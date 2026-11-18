import { agencyHost, originFor } from '../config.js';
import { withSystem, withTenant, type Db } from '../db.js';
import { brandFor, clientReportEmail, reportsReadyEmail } from '../emails.js';
import { HttpError, notFound } from '../http.js';
import type { Mailer } from '../mailer.js';
import { newToken } from '../security.js';
import type { Agency } from '../tenant.js';
import type { Writer } from '../writer.js';
import { buildReportData, defaultPlan, summaryFacts, type ReportData } from './data.js';

/** The AI summary costs one credit, refunded if it can't be written. */
export const SUMMARY_CREDITS = 1;

export interface ReportTasks {
  reportSummary(reportId: string, agencyId: string): Promise<void>;
  reportSend(reportId: string, agencyId: string): Promise<void>;
}

/** First and last day of a calendar month, 'YYYY-MM'. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Drafts a report with fresh figures and the plan from the queue. Returns its id; an existing one for the same period is returned instead. */
export async function createReport(db: Db, input: { agencyId: string; clientId: string; start: string; end: string; userId: string | null }): Promise<{ id: string; created: boolean }> {
  const { rows: existing } = await db.query<{ id: string }>(`SELECT id FROM reports WHERE client_id = $1 AND period_start = $2 AND period_end = $3`, [
    input.clientId,
    input.start,
    input.end,
  ]);
  if (existing[0]) return { id: existing[0].id, created: false };
  const data = await buildReportData(db, input.clientId, input.start, input.end);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO reports (agency_id, client_id, period_start, period_end, data, plan_text, share_token, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (client_id, period_start, period_end) DO NOTHING RETURNING id`,
    [input.agencyId, input.clientId, input.start, input.end, data, defaultPlan(data), newToken(), input.userId],
  );
  if (!rows[0]) return createReport(db, input);
  return { id: rows[0].id, created: true };
}

async function draftOr409(db: Db, id: string) {
  const { rows } = await db.query(`SELECT * FROM reports WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw notFound('Report not found');
  if (rows[0].status !== 'draft') throw new HttpError(409, 'not_draft', 'This report is approved. Reopen it as a draft to change it.');
  return rows[0];
}

/** Recomputes a draft's figures, e.g. after a late run. The summary is kept as written. */
export async function refreshReport(db: Db, id: string): Promise<void> {
  const report = await draftOr409(db, id);
  const data = await buildReportData(db, report.client_id, report.period_start as string, report.period_end as string);
  await db.query(`UPDATE reports SET data = $2, data_at = now(), updated_at = now() WHERE id = $1`, [id, data]);
}

/**
 * Queues the AI summary: reserves its credit with the agency row locked, and
 * marks it pending. Throws when the agency is out of credits.
 */
export async function requestSummary(db: Db, id: string, userId: string | null): Promise<void> {
  const report = await draftOr409(db, id);
  if (report.summary_state === 'pending') throw new HttpError(409, 'already_writing', 'The summary is already being written.');
  await db.query(`SELECT 1 FROM agencies WHERE id = app_agency_id() FOR UPDATE`);
  const { rows } = await db.query<{ remaining: number }>(`SELECT credits_remaining(app_agency_id()) AS remaining`);
  if (rows[0]!.remaining < SUMMARY_CREDITS) throw new HttpError(402, 'insufficient_credits', 'No credits are left this month for the AI summary. You can still write it yourself.');
  await db.query(
    `INSERT INTO credit_ledger (agency_id, delta, reason, report_id, created_by, note) VALUES ($1, $2, 'summary_reserved', $3, $4, 'Report summary')`,
    [report.agency_id, -SUMMARY_CREDITS, id, userId],
  );
  await db.query(`UPDATE reports SET summary_state = 'pending', summary_error = NULL, updated_at = now() WHERE id = $1`, [id]);
}

const SUMMARY_SYSTEM = [
  'You write the summary at the top of a monthly report that a marketing agency sends to its client about how often AI assistants (ChatGPT, Perplexity, Gemini) name the client.',
  'Write as the agency, to the client ("we", "you"). Plain, calm, specific. 120 to 180 words, two or three short paragraphs, no headings, no bullet points.',
  'Use only the facts given. Do not invent numbers, causes, competitors or plans.',
  'Always give a rate with what it is out of, e.g. "named in 41% of 108 answers".',
  'Never say an action caused a change. Say what changed after it, and say when a sample is small or a result is too early to judge.',
  'If figures went down, say so plainly. Do not use hype words such as "skyrocketed" or "game-changing".',
  'Return only the summary text.',
].join('\n');

function mockSummary(d: ReportData): string {
  const pct = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
  const change = d.overallBefore ? ` In ${d.previous.label} it was ${pct(d.overallBefore.rate)} of ${d.overallBefore.answers}.` : '';
  return [
    `Demo summary, written without a model because the platform is in mock mode. In ${d.period.label}, ${d.client.name} was named in ${pct(d.overall.rate)} of ${d.overall.answers} AI answers across ${d.runs} ${d.runs === 1 ? 'run' : 'runs'}.${change}`,
    `We finished ${d.actionsDone.length} ${d.actionsDone.length === 1 ? 'action' : 'actions'} this month${d.visits.installed ? ` and recorded ${d.visits.total} ${d.visits.total === 1 ? 'visit' : 'visits'} from AI assistants to the website` : ''}.`,
  ].join('\n\n');
}

/** The worker's half of the summary: writes it, or marks it failed and refunds the credit. */
export async function runSummary(writer: Writer, reportId: string, agencyId: string): Promise<void> {
  const job = await withTenant({ agencyId }, async (db) => {
    const { rows } = await db.query(`SELECT r.id, r.data, a.name AS agency FROM reports r JOIN agencies a ON a.id = r.agency_id WHERE r.id = $1 AND r.summary_state = 'pending'`, [reportId]);
    return rows[0] as { id: string; data: ReportData; agency: string } | undefined;
  });
  if (!job) return;
  try {
    const text =
      writer.mode === 'mock'
        ? mockSummary(job.data)
        : (await writer.write({ system: SUMMARY_SYSTEM, prompt: `Agency: ${job.agency}\n\n${summaryFacts(job.data)}`, maxTokens: 700 }, AbortSignal.timeout(90_000))).text.trim();
    await withTenant({ agencyId }, (db) =>
      db.query(`UPDATE reports SET summary_text = $2, summary_state = 'done', summary_mode = $3, updated_at = now() WHERE id = $1 AND summary_state = 'pending'`, [
        reportId,
        text.slice(0, 6000),
        writer.mode,
      ]),
    );
  } catch (err) {
    await failSummary(reportId, String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 300));
  }
}

export async function failSummary(reportId: string, reason: string): Promise<void> {
  await withSystem(async (db) => {
    const { rows } = await db.query(
      `UPDATE reports SET summary_state = 'failed', summary_error = $2, updated_at = now() WHERE id = $1 AND summary_state = 'pending' RETURNING agency_id`,
      [reportId, reason],
    );
    if (rows[0]) {
      await db.query(`INSERT INTO credit_ledger (agency_id, delta, reason, report_id, note) VALUES ($1, $2, 'summary_refund', $3, 'Report summary failed')`, [
        rows[0].agency_id,
        SUMMARY_CREDITS,
        reportId,
      ]);
    }
  });
}

/** Opens a report through the agency's own address and prints it to PDF. */
export type PdfRenderer = (url: string) => Promise<Buffer>;

export interface SendDeps {
  mailer: Mailer;
  renderPdf: PdfRenderer;
}

const fileName = (client: string, start: string) =>
  `${client.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'client'}-ai-visibility-${start.slice(0, 7)}.pdf`;

/**
 * The worker's half of sending: the PDF is made from the live page itself, so
 * the two always match; then each recipient gets the branded email with it.
 */
export async function runSend(deps: SendDeps, reportId: string, agencyId: string): Promise<void> {
  const job = await withSystem(async (db) => {
    const { rows } = await db.query(
      `SELECT r.id, r.client_id, r.share_token, r.recipients, r.period_start, r.data, c.name AS client,
              a.id AS agency_id, a.name, a.slug, a.custom_domain, a.domain_status, a.branding, a.status, a.plan_id, a.widget_enabled
         FROM reports r JOIN clients c ON c.id = r.client_id JOIN agencies a ON a.id = r.agency_id
        WHERE r.id = $1 AND r.agency_id = $2 AND r.send_state = 'pending' AND r.status IN ('approved', 'sent')`,
      [reportId, agencyId],
    );
    return rows[0];
  });
  if (!job) return;
  const fail = (reason: string) =>
    withSystem((db) => db.query(`UPDATE reports SET send_state = 'failed', send_error = $2, updated_at = now() WHERE id = $1`, [reportId, reason.slice(0, 300)]));

  const agency = { ...job, id: job.agency_id } as Agency;
  const url = `${originFor(agencyHost(agency))}/r/${job.share_token}`;
  let pdf: Buffer;
  try {
    pdf = await deps.renderPdf(url);
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('The PDF renderer returned something that is not a PDF');
  } catch (err) {
    await fail(`The PDF could not be made: ${String((err as Error)?.message ?? err)}`);
    return;
  }
  await withSystem((db) => db.query(`UPDATE reports SET pdf = $2 WHERE id = $1`, [reportId, pdf]));

  const brand = brandFor({ kind: 'agency', agency });
  const period = (job.data as ReportData).period.label;
  const failed: string[] = [];
  for (const to of job.recipients as string[]) {
    try {
      await deps.mailer.send(clientReportEmail(brand, { to, client: job.client, period, url, pdf, filename: fileName(job.client, job.period_start as string) }));
    } catch (err) {
      failed.push(`${to} (${String((err as Error)?.message ?? err).slice(0, 80)})`);
    }
  }
  if (failed.length === (job.recipients as string[]).length) {
    await fail(`No email could be sent: ${failed.join('; ')}`);
    return;
  }
  await withSystem((db) =>
    db.query(
      `UPDATE reports SET status = 'sent', send_state = 'done', send_error = $2, sent_at = now(), updated_at = now() WHERE id = $1`,
      [reportId, failed.length ? `Not delivered to: ${failed.join('; ')}` : null],
    ),
  );
}

/**
 * On the 1st of each month: a draft for last month for every tracked client
 * that had a completed run then, with its AI summary queued, and one email per
 * agency to its owners. Safe to call every hour: each report exists once.
 */
export async function draftDueReports(now: Date, deps: { tasks: ReportTasks; mailer: Mailer; writerReady: boolean }): Promise<number> {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const { start, end } = monthBounds(month);
  const { rows: due } = await withSystem((db) =>
    db.query<{ client_id: string; agency_id: string }>(
      `SELECT c.id AS client_id, c.agency_id FROM clients c JOIN agencies a ON a.id = c.agency_id
        WHERE a.status = 'active' AND c.status = 'active'
          AND EXISTS (SELECT 1 FROM runs r WHERE r.client_id = c.id AND r.status = 'completed'
                        AND r.created_at >= $1::date AND r.created_at < $2::date + 1)
          AND NOT EXISTS (SELECT 1 FROM reports x WHERE x.client_id = c.id AND x.period_start = $1 AND x.period_end = $2)
        ORDER BY c.agency_id, c.name`,
      [start, end],
    ),
  );
  const byAgency = new Map<string, string[]>();
  for (const row of due) {
    const id = await withTenant({ agencyId: row.agency_id }, async (db) => {
      const made = await createReport(db, { agencyId: row.agency_id, clientId: row.client_id, start, end, userId: null });
      if (!made.created) return null;
      if (deps.writerReady) {
        try {
          await requestSummary(db, made.id, null);
        } catch {
          // Out of credits: the draft waits for a summary written by hand.
        }
      }
      return made.id;
    });
    if (!id) continue;
    byAgency.set(row.agency_id, [...(byAgency.get(row.agency_id) ?? []), id]);
    await deps.tasks.reportSummary(id, row.agency_id).catch(() => {});
  }

  for (const [agencyId, ids] of byAgency) {
    const { agency, owners, clients } = await withSystem(async (db) => {
      const { rows } = await db.query(`SELECT id, name, slug, custom_domain, domain_status, branding, status, plan_id, widget_enabled FROM agencies WHERE id = $1`, [agencyId]);
      const { rows: o } = await db.query<{ email: string }>(`SELECT email FROM users WHERE agency_id = $1 AND role = 'agency_owner'`, [agencyId]);
      const { rows: c } = await db.query<{ name: string }>(`SELECT c.name FROM reports r JOIN clients c ON c.id = r.client_id WHERE r.id = ANY($1::uuid[]) ORDER BY c.name`, [ids]);
      return { agency: rows[0] as Agency, owners: o.map((x) => x.email), clients: c.map((x) => x.name) };
    });
    const brand = brandFor({ kind: 'agency', agency });
    const period = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
    for (const to of owners) {
      await deps.mailer.send(reportsReadyEmail(brand, { to, period, clients, url: `${originFor(agencyHost(agency))}/clients` })).catch(() => {});
    }
  }
  return due.length;
}
