import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, originFor } from '../config.js';
import { withSystem, withTenant, type Db } from '../db.js';
import { AGENCY_STAFF, ANYONE, HttpError, agencyOf, notFound, parse, requireRole, scope, uuidParam } from '../http.js';
import type { ReportData } from '../reports/data.js';
import { createReport, failSummary, monthBounds, refreshReport, requestSummary, type ReportTasks } from '../reports/service.js';
import type { Writer } from '../writer.js';
import { clientOr404 } from './tracker.js';

const email = z.string().trim().toLowerCase().email().max(254);

function present(row: any, opts: { staff: boolean; origin: string }) {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    periodStart: (row.period_start as string),
    periodEnd: (row.period_end as string),
    status: row.status as 'draft' | 'approved' | 'sent',
    data: row.data as ReportData,
    dataAt: row.data_at as string,
    summaryText: row.summary_text as string | null,
    summaryState: row.summary_state as 'none' | 'pending' | 'done' | 'failed',
    summaryError: opts.staff ? (row.summary_error as string | null) : null,
    summaryMode: row.summary_mode as 'live' | 'mock' | null,
    planText: row.plan_text as string | null,
    approvedBy: (row.approved_by_name as string | undefined) ?? null,
    approvedAt: row.approved_at as string | null,
    sendState: opts.staff ? (row.send_state as string) : null,
    sendError: opts.staff ? (row.send_error as string | null) : null,
    recipients: opts.staff ? (row.recipients as string[]) : [],
    sentAt: row.sent_at as string | null,
    hasPdf: Boolean(row.has_pdf),
    // The live link exists once the report is approved: never for a draft.
    liveUrl: row.status === 'draft' ? null : `${opts.origin}/r/${row.share_token}`,
    createdAt: row.created_at as string,
  };
}

const REPORT_SQL = `SELECT r.*, (r.pdf IS NOT NULL) AS has_pdf, u.name AS approved_by_name FROM reports r LEFT JOIN users u ON u.id = r.approved_by`;

async function reportOr404(db: Db, id: string) {
  const { rows } = await db.query(`${REPORT_SQL} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('Report not found');
  return rows[0];
}

/**
 * Monthly client reports. Agency users draft, edit, approve and send; a
 * client's viewers see that client's sent reports only (row-level security
 * enforces it). Nothing reaches a client without an agency user's approval.
 */
export async function reportRoutes(app: FastifyInstance, opts: { tasks: ReportTasks; writer: Writer }): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };
  const anyone = { preHandler: requireRole(...ANYONE) };
  const isStaff = (role: string) => role !== 'client_viewer';

  app.get('/v1/clients/:id/reports', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const origin = originFor(agencyHost(agencyOf(req)));
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows } = await db.query(`${REPORT_SQL} WHERE r.client_id = $1 ORDER BY r.period_start DESC`, [id]);
      const writer = opts.writer.mode === 'mock' || opts.writer.missing() === null;
      return {
        reports: rows.map((r) => {
          const { data, ...rest } = present(r, { staff: isStaff(req.user!.role), origin });
          return { ...rest, headline: { named: data.overall.named, answers: data.overall.answers, runs: data.runs } };
        }),
        writerReady: writer,
      };
    });
  });

  /** Drafts the report for a calendar month, or returns the one that exists. */
  app.post('/v1/clients/:id/reports', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const { month, summary } = parse(
      z.object({ month: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/), summary: z.boolean().default(true) }).strict(),
      req.body,
    );
    const { start, end } = monthBounds(month);
    if (start > new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'invalid_input', 'That month hasn’t started yet.');
    const ctx = scope(req);
    const made = await withTenant(ctx, async (db) => {
      await clientOr404(db, id);
      const result = await createReport(db, { agencyId: ctx.agencyId, clientId: id, start, end, userId: req.user!.id });
      let summaryQueued = false;
      if (result.created && summary && (opts.writer.mode === 'mock' || opts.writer.missing() === null)) {
        try {
          await requestSummary(db, result.id, req.user!.id);
          summaryQueued = true;
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 402)) throw err;
        }
      }
      return { ...result, summaryQueued };
    });
    if (made.summaryQueued) await opts.tasks.reportSummary(made.id, ctx.agencyId).catch(() => failSummary(made.id, 'Could not be queued'));
    reply.code(made.created ? 201 : 200);
    return { report: { id: made.id }, created: made.created };
  });

  app.get('/v1/monthly-reports/:id', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const origin = originFor(agencyHost(agencyOf(req)));
    return withTenant(scope(req), async (db) => {
      const row = await reportOr404(db, id);
      const { rows: client } = await db.query(`SELECT name, report_emails FROM clients WHERE id = $1`, [row.client_id]);
      let suggested: string[] = [];
      if (isStaff(req.user!.role)) {
        const { rows: viewers } = await db.query<{ email: string }>(`SELECT email FROM users WHERE client_id = $1 AND role = 'client_viewer' ORDER BY email`, [row.client_id]);
        suggested = [...new Set([...(row.recipients as string[]), ...(client[0]?.report_emails ?? []), ...viewers.map((v) => v.email)])];
      }
      return { report: present(row, { staff: isStaff(req.user!.role), origin }), clientName: client[0]?.name, suggestedRecipients: suggested };
    });
  });

  /** Edit a draft's text; approve it; or reopen an approved report that hasn't been sent. */
  app.patch('/v1/monthly-reports/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z
        .object({
          summaryText: z.string().max(6000),
          planText: z.string().max(6000),
          status: z.enum(['draft', 'approved']),
        })
        .partial()
        .strict(),
      req.body,
    );
    const origin = originFor(agencyHost(agencyOf(req)));
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT status, summary_text, summary_state, send_state FROM reports WHERE id = $1 FOR UPDATE`, [id]);
      const current = rows[0];
      if (!current) throw notFound('Report not found');

      if (body.summaryText !== undefined || body.planText !== undefined) {
        if (current.status !== 'draft') throw new HttpError(409, 'not_draft', 'This report is approved. Reopen it as a draft to change it.');
        if (current.summary_state === 'pending' && body.summaryText !== undefined) throw new HttpError(409, 'already_writing', 'Wait for the AI summary to finish, then edit it.');
        await db.query(
          `UPDATE reports SET summary_text = coalesce($2, summary_text), plan_text = coalesce($3, plan_text),
                  summary_mode = CASE WHEN $2::text IS NOT NULL THEN 'live' ELSE summary_mode END, updated_at = now() WHERE id = $1`,
          [id, body.summaryText?.trim() ?? null, body.planText?.trim() ?? null],
        );
      }
      if (body.status === 'approved' && current.status === 'draft') {
        const { rows: now } = await db.query(`SELECT summary_text, summary_state FROM reports WHERE id = $1`, [id]);
        if (now[0].summary_state === 'pending') throw new HttpError(409, 'already_writing', 'Wait for the AI summary to finish first.');
        if (!now[0].summary_text || now[0].summary_text.trim().length < 20) throw new HttpError(400, 'invalid_input', 'Write the summary before approving: it’s the first thing the client reads.');
        await db.query(`UPDATE reports SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, req.user!.id]);
      }
      if (body.status === 'draft' && current.status !== 'draft') {
        if (current.status === 'sent') throw new HttpError(409, 'already_sent', 'This report has been sent. It can’t go back to being a draft.');
        if (current.send_state === 'pending') throw new HttpError(409, 'sending', 'This report is being sent.');
        await db.query(`UPDATE reports SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`, [id]);
      }
      return { report: present(await reportOr404(db, id), { staff: true, origin }) };
    });
  });

  app.post('/v1/monthly-reports/:id/refresh', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const origin = originFor(agencyHost(agencyOf(req)));
    return withTenant(scope(req), async (db) => {
      await refreshReport(db, id);
      return { report: present(await reportOr404(db, id), { staff: true, origin }) };
    });
  });

  /** Writes (or rewrites) the summary with the AI writer, for one credit. */
  app.post('/v1/monthly-reports/:id/summary', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    if (opts.writer.mode === 'live' && opts.writer.missing()) {
      throw new HttpError(409, 'no_writer', `${opts.writer.missing()} Your platform administrator can set it on the API keys screen. You can write the summary yourself meanwhile.`);
    }
    const ctx = scope(req);
    await withTenant(ctx, (db) => requestSummary(db, id, req.user!.id));
    await opts.tasks.reportSummary(id, ctx.agencyId).catch(async () => {
      await failSummary(id, 'Could not be queued');
      throw new HttpError(503, 'queue_unavailable', 'The summary could not be started. Try again in a minute; no credit was used.');
    });
    reply.code(202);
    return { ok: true };
  });

  /** Sends an approved report: PDF and email, done by the worker. Can be sent again to more people. */
  app.post('/v1/monthly-reports/:id/send', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const { recipients } = parse(z.object({ recipients: z.array(email).min(1).max(10) }).strict(), req.body);
    const ctx = scope(req);
    await withTenant(ctx, async (db) => {
      const { rows } = await db.query(`SELECT client_id, status, send_state FROM reports WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw notFound('Report not found');
      if (rows[0].status === 'draft') throw new HttpError(409, 'not_approved', 'Approve the report before sending it. Nothing goes to a client without approval.');
      if (rows[0].send_state === 'pending') throw new HttpError(409, 'sending', 'This report is already being sent.');
      const unique = [...new Set(recipients)];
      await db.query(`UPDATE reports SET recipients = $2, send_state = 'pending', send_error = NULL, sent_by = $3, updated_at = now() WHERE id = $1`, [id, unique, req.user!.id]);
      // Remembered for next month, apart from the client's dashboard users, who are added anyway.
      const { rows: viewers } = await db.query<{ email: string }>(`SELECT email FROM users WHERE client_id = $1 AND role = 'client_viewer'`, [rows[0].client_id]);
      const extra = unique.filter((e) => !viewers.some((v) => v.email === e)).slice(0, 10);
      await db.query(`UPDATE clients SET report_emails = $2 WHERE id = $1`, [rows[0].client_id, extra]);
    });
    try {
      await opts.tasks.reportSend(id, ctx.agencyId);
    } catch {
      await withTenant(ctx, (db) => db.query(`UPDATE reports SET send_state = 'failed', send_error = 'Could not be queued' WHERE id = $1`, [id]));
      throw new HttpError(503, 'queue_unavailable', 'Sending could not be started. Try again in a minute.');
    }
    reply.code(202);
    return { ok: true };
  });

  /** The PDF that was sent. */
  app.get('/v1/monthly-reports/:id/pdf', anyone, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const row = await withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT r.pdf, r.period_start, c.name FROM reports r JOIN clients c ON c.id = r.client_id WHERE r.id = $1`, [id]);
      return rows[0];
    });
    if (!row) throw notFound('Report not found');
    if (!row.pdf) throw notFound('The PDF is made when the report is sent');
    const name = `${String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client'}-ai-visibility-${String(row.period_start).slice(0, 7)}.pdf`;
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${name}"`);
    return row.pdf as Buffer;
  });

  /**
   * The live link, public: only for an approved or sent report, and only on
   * the address of the agency that made it, so a link never shows another
   * brand. Returns just what the page shows.
   */
  app.get('/v1/client-reports/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(32).max(100) }), req.params);
    const agency = agencyOf(req);
    const row = await withSystem(async (db) => {
      const { rows } = await db.query(
        `SELECT r.period_start, r.period_end, r.status, r.data, r.summary_text, r.plan_text, r.approved_at, r.sent_at
           FROM reports r WHERE r.share_token = $1 AND r.agency_id = $2 AND r.status IN ('approved', 'sent')`,
        [token, agency.id],
      );
      return rows[0];
    });
    if (!row) throw notFound('Report not found');
    return {
      report: {
        periodStart: (row.period_start as string),
        periodEnd: (row.period_end as string),
        data: row.data as ReportData,
        summaryText: row.summary_text as string,
        planText: row.plan_text as string | null,
        approvedAt: row.approved_at as string,
      },
      agency: { name: agency.name },
    };
  });
}
