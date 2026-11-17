import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, config, originFor } from '../config.js';
import { withTenant } from '../db.js';
import { AGENCY_STAFF, HttpError, agencyOf, notFound, parse, requireRole, scope, uuidParam } from '../http.js';
import { newToken } from '../security.js';
import { AUDIT_QUOTA_SQL, createProspect, dropProspect, startAudit, type AuditDeps } from '../audits/pipeline.js';
import { buildReport } from '../audits/report.js';
import { suggestCompetitors, suggestPrompts } from '../audits/suggest.js';
import { AUDIT_MAX_COMPETITORS, AUDIT_MAX_PROMPTS, AUDIT_SAMPLES } from '../audits/types.js';

const domainField = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((value) => value.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0] ?? '')
  .refine((value) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), 'Enter a website such as example.com');
const text = (max: number) => z.string().trim().min(1).max(max).transform((t) => t.replace(/\s+/g, ' '));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((t) => (t ? t.replace(/\s+/g, ' ') : null));

const businessFields = { business: text(160), domain: domainField, category: text(120), location: optionalText(120) };

const createSchema = z
  .object({
    ...businessFields,
    prompts: z
      .array(z.object({ text: z.string().trim().min(3).max(500).transform((t) => t.replace(/\s+/g, ' ')), intent: z.enum(['category', 'comparison', 'problem', 'brand']).optional() }).strict())
      .min(1)
      .max(AUDIT_MAX_PROMPTS),
    competitors: z.array(z.object({ name: text(160), domain: domainField.nullable().optional() }).strict()).max(AUDIT_MAX_COMPETITORS),
  })
  .strict();

const widgetSchema = z
  .object({
    businessName: text(160),
    website: domainField,
    category: text(120),
    location: optionalText(120),
    name: optionalText(120),
    email: z.string().trim().toLowerCase().email().max(254),
    // Hidden from people; bots that fill every field give themselves away.
    company: z.string().max(200).optional(),
  })
  .strict();

const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,100}$/) });

export async function auditRoutes(app: FastifyInstance, deps: AuditDeps): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };

  app.post('/v1/audits/suggest-prompts', staff, async (req) => {
    const body = parse(z.object({ category: text(120), location: optionalText(120) }).strict(), req.body);
    return { prompts: suggestPrompts(body.category, body.location) };
  });

  /** One engine call, not charged in credits, so it is rate limited per user. */
  app.post(
    '/v1/audits/suggest-competitors',
    { ...staff, config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: any) => req.headers.cookie ?? req.ip } } },
    async (req) => {
      const body = parse(z.object(businessFields).strict(), req.body);
      if (deps.engines.available.size === 0) throw new HttpError(409, 'no_engines', 'No answer engines are set up yet, so competitors cannot be suggested.');
      return { competitors: await suggestCompetitors(deps.engines, body), engineMode: deps.engines.mode };
    },
  );

  app.post('/v1/audits', staff, async (req, reply) => {
    const body = parse(createSchema, req.body);
    const ctx = scope(req);
    // Fail fast on the common refusals, before anything is created.
    await withTenant(ctx, async (db) => {
      const { rows } = await db.query<{ max: number; used: number }>(AUDIT_QUOTA_SQL);
      if (rows[0]!.used >= rows[0]!.max) throw new HttpError(409, 'audit_limit', `Your plan includes ${rows[0]!.max} audits a month and all of them have been used.`);
    });
    const clientId = await createProspect(ctx.agencyId, { ...body });
    try {
      const { auditId } = await startAudit(deps, { agencyId: ctx.agencyId, clientId, userId: req.user!.id, source: 'manual' });
      reply.code(201);
      return { audit: { id: auditId } };
    } catch (err) {
      await dropProspect(ctx.agencyId, clientId);
      throw err;
    }
  });

  app.get('/v1/audits', staff, async (req) =>
    withTenant(scope(req), async (db) => {
      const { rows } = await db.query(
        `SELECT a.id, a.status, a.source, a.created_at, c.id AS client_id, c.name, c.domain, c.status AS client_status,
                r.total_calls, r.ok_calls, r.failed_calls, s.status AS site_status, l.email AS lead_email,
                (SELECT count(*)::int FROM result_mentions m JOIN prompt_results pr ON pr.id = m.prompt_result_id
                  WHERE pr.run_id = a.run_id AND pr.status = 'ok' AND m.competitor_id IS NULL) AS mentioned
           FROM audits a
           JOIN clients c ON c.id = a.client_id
           JOIN runs r ON r.id = a.run_id
           LEFT JOIN site_audits s ON s.id = a.site_audit_id
           LEFT JOIN leads l ON l.audit_id = a.id
          ORDER BY a.created_at DESC
          LIMIT 100`,
      );
      const { rows: quota } = await db.query<{ max: number; used: number }>(AUDIT_QUOTA_SQL);
      const { rows: agency } = await db.query<{ widget_enabled: boolean }>(`SELECT widget_enabled FROM agencies WHERE id = app_agency_id()`);
      return {
        quota: { used: quota[0]!.used, max: quota[0]!.max },
        widgetEnabled: agency[0]!.widget_enabled,
        audits: rows.map((r) => ({
          id: r.id,
          status: r.status,
          source: r.source,
          createdAt: r.created_at,
          clientId: r.client_id,
          clientStatus: r.client_status,
          business: r.name,
          domain: r.domain,
          answers: r.ok_calls,
          mentioned: r.mentioned,
          progress: { done: r.ok_calls + r.failed_calls, total: r.total_calls, site: r.site_status ?? 'failed' },
          leadEmail: r.lead_email,
        })),
      };
    }),
  );

  app.get('/v1/audits/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const agency = agencyOf(req);
    return withTenant(scope(req), async (db) => {
      const report = await buildReport(db, id);
      const { rows: leads } = await db.query(`SELECT name, email, created_at FROM leads WHERE audit_id = $1`, [id]);
      return {
        report,
        shareUrl: `${originFor(agencyHost(agency))}/report/${report.shareToken}`,
        lead: leads[0] ? { name: leads[0].name, email: leads[0].email, createdAt: leads[0].created_at } : null,
      };
    });
  });

  /** Replaces the share link. The old one stops working at once. */
  app.post('/v1/audits/:id/share-link', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const agency = agencyOf(req);
    const token = newToken();
    const updated = await withTenant(scope(req), (db) => db.query(`UPDATE audits SET share_token = $2 WHERE id = $1`, [id, token]));
    if (updated.rowCount === 0) throw notFound('Audit not found');
    return { shareUrl: `${originFor(agencyHost(agency))}/report/${token}` };
  });

  /** Deletes a prospect's audit and the prospect with it. A converted client is never deleted this way. */
  app.delete('/v1/audits/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT c.id, c.status FROM audits a JOIN clients c ON c.id = a.client_id WHERE a.id = $1`, [id]);
      if (!rows[0]) throw notFound('Audit not found');
      if (rows[0].status !== 'prospect') throw new HttpError(409, 'converted', 'This prospect is now a client. Delete the client instead.');
      await db.query(`DELETE FROM clients WHERE id = $1`, [rows[0].id]);
      return { ok: true };
    });
  });

  app.get('/v1/leads', staff, async (req) =>
    withTenant(scope(req), async (db) => {
      const { rows } = await db.query(
        `SELECT l.id, l.name, l.email, l.business_name, l.domain, l.category, l.location, l.status, l.note, l.created_at, l.audit_id,
                a.status AS audit_status, c.status AS client_status
           FROM leads l LEFT JOIN audits a ON a.id = l.audit_id LEFT JOIN clients c ON c.id = l.client_id
          ORDER BY l.created_at DESC LIMIT 200`,
      );
      return {
        leads: rows.map((l) => ({
          id: l.id,
          name: l.name,
          email: l.email,
          business: l.business_name,
          domain: l.domain,
          category: l.category,
          location: l.location,
          status: l.status,
          note: l.note,
          createdAt: l.created_at,
          auditId: l.audit_id,
          auditStatus: l.audit_status,
          clientStatus: l.client_status,
        })),
      };
    }),
  );

  // Public: anyone with the link, on the agency's own address only -----------------

  app.get('/v1/reports/:token', async (req) => {
    const agency = agencyOf(req);
    if (agency.status === 'suspended') throw notFound('Report not found');
    const { token } = parse(tokenParam, req.params);
    return withTenant({ agencyId: agency.id }, async (db) => {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM audits WHERE share_token = $1`, [token]);
      if (!rows[0]) throw notFound('Report not found');
      const { shareToken: _token, clientId: _client, clientStatus: _status, source: _source, ...report } = await buildReport(db, rows[0].id);
      return {
        report,
        agency: { name: agency.name, ctaLabel: agency.branding.ctaLabel ?? null, ctaUrl: agency.branding.ctaUrl ?? null },
      };
    });
  });

  /**
   * The website widget. Always answers the same way, whether the request was
   * new, a repeat or a bot, so it reveals nothing. The work happens in the
   * background job, which also emails both sides.
   */
  app.post(
    '/v1/widget/audits',
    { config: { rateLimit: { max: config.widgetPerHour, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const agency = agencyOf(req);
      const ctx = { agencyId: agency.id };
      const enabled = await withTenant(ctx, async (db) => {
        const { rows } = await db.query<{ widget_enabled: boolean }>(`SELECT widget_enabled FROM agencies WHERE id = app_agency_id()`);
        return rows[0]?.widget_enabled === true;
      });
      if (!enabled || agency.status === 'suspended') throw notFound('This form is not available');
      const body = parse(widgetSchema, req.body);
      reply.code(202);
      const accepted = { ok: true, email: body.email };
      if (body.company) return accepted;

      const leadId = await withTenant(ctx, async (db) => {
        const repeat = await db.query(
          `SELECT 1 FROM leads WHERE email = $1 AND domain = $2 AND created_at > now() - interval '1 day'`,
          [body.email, body.website],
        );
        if (repeat.rows.length > 0) return null;
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO leads (agency_id, name, email, business_name, domain, category, location) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [agency.id, body.name, body.email, body.businessName, body.website, body.category, body.location],
        );
        return rows[0]!.id;
      });
      if (leadId) {
        try {
          await deps.tasks.lead(leadId, agency.id);
        } catch {
          // The lead is saved either way; the agency still sees it in its list.
          await withTenant(ctx, (db) => db.query(`UPDATE leads SET status = 'not_run', note = 'Could not be queued' WHERE id = $1`, [leadId]));
        }
      }
      return accepted;
    },
  );

  /** What one audit costs, for the confirmation in the new-audit form. */
  app.get('/v1/audits/estimate', staff, async (req) =>
    withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT key, label, credit_cost FROM engines WHERE active ORDER BY sort`);
      const engines = rows.filter((e) => deps.engines.available.has(e.key));
      const { rows: quota } = await db.query<{ max: number; used: number }>(AUDIT_QUOTA_SQL);
      const { rows: credits } = await db.query<{ remaining: number }>(`SELECT credits_remaining(app_agency_id()) AS remaining`);
      return {
        engines: engines.map((e) => e.label as string),
        creditsPerPrompt: AUDIT_SAMPLES * engines.reduce((sum, e) => sum + (e.credit_cost as number), 0),
        samples: AUDIT_SAMPLES,
        quota: { used: quota[0]!.used, max: quota[0]!.max },
        creditsRemaining: credits[0]!.remaining,
        engineMode: deps.engines.mode,
        limits: { prompts: AUDIT_MAX_PROMPTS, competitors: AUDIT_MAX_COMPETITORS },
      };
    }),
  );
}
