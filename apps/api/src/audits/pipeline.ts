import { agencyHost, originFor } from '../config.js';
import { withSystem, withTenant } from '../db.js';
import { auditReadyEmail, brandFor, leadAgencyEmail, leadThanksEmail } from '../emails.js';
import { HttpError } from '../http.js';
import type { Mailer } from '../mailer.js';
import { newToken } from '../security.js';
import type { Agency } from '../tenant.js';
import { createRun, type TrackerDeps } from '../tracker/runs.js';
import type { SiteFetcher } from './fetch.js';
import { checkSite } from './site.js';
import { suggestCompetitors, suggestPrompts } from './suggest.js';
import { AUDIT_SAMPLES } from './types.js';

export interface TaskQueue {
  siteAudit(siteAuditId: string, agencyId: string): Promise<void>;
  lead(leadId: string, agencyId: string): Promise<void>;
  /** The follow-up to a completed run: page checks, website check, summary email. */
  diagnose(runId: string, agencyId: string): Promise<void>;
  /** Writes one asset for an action. */
  generate(assetId: string, agencyId: string): Promise<void>;
  /** Writes a report's AI summary. */
  reportSummary(reportId: string, agencyId: string): Promise<void>;
  /** Makes a report's PDF and emails it. */
  reportSend(reportId: string, agencyId: string): Promise<void>;
}

export interface AuditDeps extends TrackerDeps {
  tasks: TaskQueue;
  siteMode: 'live' | 'mock';
}

const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** Audits used this calendar month (UTC) and the plan's allowance. Run inside a tenant transaction. */
export const AUDIT_QUOTA_SQL = `
  SELECT p.audits_per_month AS max, (SELECT count(*)::int FROM audits WHERE created_at >= ${MONTH_START}) AS used
    FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id()`;

/**
 * Starts an audit of a prospect that already has its prompts and
 * competitors: one tracking run, asked once per engine, plus a check of the
 * website. The monthly audit allowance is checked inside the run's own
 * transaction, with the agency row locked, so it cannot be overrun by two
 * requests at once.
 */
export async function startAudit(
  deps: AuditDeps,
  input: { agencyId: string; clientId: string; userId: string | null; source: 'manual' | 'widget' },
): Promise<{ auditId: string; runId: string }> {
  let auditId = '';
  let siteAuditId = '';
  const run = await createRun(
    deps,
    { agencyId: input.agencyId, clientId: input.clientId, trigger: 'audit', userId: input.userId },
    {
      samples: AUDIT_SAMPLES,
      allowProspect: true,
      within: async (db, runId) => {
        const { rows: quota } = await db.query<{ max: number; used: number }>(AUDIT_QUOTA_SQL);
        if (quota[0]!.used >= quota[0]!.max) {
          throw new HttpError(409, 'audit_limit', `Your plan includes ${quota[0]!.max} audits a month and all of them have been used.`);
        }
        const { rows: clients } = await db.query<{ domain: string | null }>(`SELECT domain FROM clients WHERE id = $1`, [input.clientId]);
        const domain = clients[0]?.domain;
        if (!domain) throw new HttpError(400, 'invalid_input', 'An audit needs the business’s website');
        const { rows: site } = await db.query<{ id: string }>(
          `INSERT INTO site_audits (agency_id, client_id, domain, mode) VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.agencyId, input.clientId, domain, deps.siteMode],
        );
        siteAuditId = site[0]!.id;
        const { rows: audits } = await db.query<{ id: string }>(
          `INSERT INTO audits (agency_id, client_id, run_id, site_audit_id, source, share_token, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [input.agencyId, input.clientId, runId, siteAuditId, input.source, newToken(), input.userId],
        );
        auditId = audits[0]!.id;
      },
    },
  );

  try {
    await deps.tasks.siteAudit(siteAuditId, input.agencyId);
  } catch {
    await withTenant({ agencyId: input.agencyId }, (db) =>
      db.query(`UPDATE site_audits SET status = 'failed', error = 'Could not be queued', finished_at = now() WHERE id = $1 AND status = 'pending'`, [siteAuditId]),
    );
    await completeAudit({ siteAuditId });
  }
  return { auditId, runId: run.id };
}

/** The site-check job. Safe to run twice: only a pending check is written. */
export async function runSiteAudit(fetcher: SiteFetcher, siteAuditId: string, agencyId: string, mailer?: Mailer): Promise<void> {
  const ctx = { agencyId };
  const row = await withTenant(ctx, async (db) => {
    const { rows } = await db.query<{ domain: string }>(`SELECT domain FROM site_audits WHERE id = $1 AND status = 'pending'`, [siteAuditId]);
    return rows[0];
  });
  if (!row) return;
  try {
    const findings = await checkSite(row.domain, fetcher);
    await withTenant(ctx, (db) =>
      db.query(
        `UPDATE site_audits SET status = 'done', findings = $2::jsonb, pages_checked = $3, finished_at = now() WHERE id = $1 AND status = 'pending'`,
        [siteAuditId, JSON.stringify(findings), findings.pagesChecked],
      ),
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 300);
    await withTenant(ctx, (db) =>
      db.query(`UPDATE site_audits SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'pending'`, [siteAuditId, message]),
    );
  }
  await completeAudit({ siteAuditId }, mailer);
}

interface Finished {
  auditId: string;
  agencyId: string;
  status: 'completed' | 'failed';
  token: string;
  business: string;
  domain: string;
  lead: { email: string; name: string | null } | null;
}

/**
 * Closes an audit once both its run and its site check have finished, then,
 * for audits requested through the website widget, sends the emails. Called
 * after every step that could be the last one; does nothing until both are
 * done, and sends the emails only once.
 */
export async function completeAudit(ref: { runId?: string; siteAuditId?: string }, mailer?: Mailer): Promise<void> {
  const finished = await withSystem(async (db): Promise<Finished | null> => {
    const { rows } = await db.query(
      `SELECT a.id, a.agency_id, a.status, a.source, a.share_token, a.notified_at, r.status AS run_status, s.status AS site_status,
              c.name, c.domain, l.email AS lead_email, l.name AS lead_name
         FROM audits a
         JOIN runs r ON r.id = a.run_id
         JOIN clients c ON c.id = a.client_id
         LEFT JOIN site_audits s ON s.id = a.site_audit_id
         LEFT JOIN leads l ON l.audit_id = a.id
        WHERE ${ref.runId ? 'a.run_id = $1' : 'a.site_audit_id = $1'}
        FOR UPDATE OF a`,
      [ref.runId ?? ref.siteAuditId],
    );
    const audit = rows[0];
    if (!audit) return null;
    let status = audit.status as string;
    if (status === 'running') {
      const runDone = !['queued', 'running'].includes(audit.run_status);
      const siteDone = audit.site_status !== 'pending';
      if (!runDone || !siteDone) return null;
      status = audit.run_status === 'completed' ? 'completed' : 'failed';
      await db.query(`UPDATE audits SET status = $2, completed_at = now() WHERE id = $1`, [audit.id, status]);
    }
    if (audit.source !== 'widget' || audit.notified_at || !mailer) return null;
    // The lead is linked just after the audit starts; until then there is nobody to tell.
    if (!audit.lead_email) return null;
    await db.query(`UPDATE audits SET notified_at = now() WHERE id = $1`, [audit.id]);
    return {
      auditId: audit.id,
      agencyId: audit.agency_id,
      status: status as Finished['status'],
      token: audit.share_token,
      business: audit.name,
      domain: audit.domain,
      lead: audit.lead_email ? { email: audit.lead_email, name: audit.lead_name } : null,
    };
  });
  if (!finished || !mailer) return;

  const { agency, owners } = await agencyContacts(finished.agencyId);
  if (!agency) return;
  const brand = brandFor({ kind: 'agency', agency });
  const origin = originFor(agencyHost(agency));
  const mails = [];
  if (finished.lead) {
    mails.push(
      finished.status === 'completed'
        ? auditReadyEmail(brand, { to: finished.lead.email, business: finished.business, url: `${origin}/report/${finished.token}` })
        : leadThanksEmail(brand, { to: finished.lead.email, business: finished.business }),
    );
  }
  const lead = { business: finished.business, domain: finished.domain, email: finished.lead?.email ?? 'unknown', name: finished.lead?.name ?? null };
  for (const to of owners) {
    mails.push(leadAgencyEmail(brand, { to, lead, url: `${origin}/audits/${finished.auditId}`, outcome: finished.status === 'completed' ? 'ready' : 'failed' }));
  }
  await sendAll(mailer, mails);
}

async function agencyContacts(agencyId: string): Promise<{ agency: Agency | null; owners: string[] }> {
  const { rows } = await withSystem((db) =>
    db.query<Agency>(`SELECT id, name, slug, custom_domain, domain_status, branding, status, plan_id, widget_enabled FROM agencies WHERE id = $1`, [agencyId]),
  );
  const { rows: owners } = await withSystem((db) =>
    db.query<{ email: string }>(`SELECT email FROM users WHERE agency_id = $1 AND role = 'agency_owner' ORDER BY created_at`, [agencyId]),
  );
  return { agency: rows[0] ?? null, owners: owners.map((o) => o.email) };
}

/** A failed email never fails the job: the report stays available in the app. */
export async function sendAll(mailer: Mailer, mails: Parameters<Mailer['send']>[0][]): Promise<void> {
  for (const mail of mails) {
    try {
      await mailer.send(mail);
    } catch (err) {
      console.error(JSON.stringify({ message: 'email failed', to: mail.to, subject: mail.subject, error: String((err as Error)?.message ?? err) }));
    }
  }
}

/** Creates a prospect with its prompts and competitors. Returns its id. */
export async function createProspect(
  agencyId: string,
  input: {
    business: string;
    domain: string;
    category: string;
    location: string | null;
    prompts: { text: string; intent?: string }[];
    competitors: { name: string; domain?: string | null }[];
  },
): Promise<string> {
  return withTenant({ agencyId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO clients (agency_id, name, domain, category, location, status) VALUES ($1, $2, $3, $4, $5, 'prospect') RETURNING id`,
      [agencyId, input.business, input.domain, input.category, input.location],
    );
    const clientId = rows[0]!.id;
    const seen = new Set<string>();
    for (const prompt of input.prompts) {
      const key = prompt.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await db.query(`INSERT INTO prompts (agency_id, client_id, text, intent) VALUES ($1, $2, $3, $4)`, [agencyId, clientId, prompt.text, prompt.intent ?? 'category']);
    }
    const names = new Set<string>();
    for (const competitor of input.competitors) {
      const key = competitor.name.toLowerCase();
      if (names.has(key) || key === input.business.toLowerCase()) continue;
      names.add(key);
      await db.query(`INSERT INTO competitors (agency_id, client_id, name, domain) VALUES ($1, $2, $3, $4)`, [agencyId, clientId, competitor.name, competitor.domain ?? null]);
    }
    return clientId;
  });
}

/** Removes a prospect that never got going, with everything attached to it. */
export async function dropProspect(agencyId: string, clientId: string): Promise<void> {
  await withTenant({ agencyId }, (db) => db.query(`DELETE FROM clients WHERE id = $1 AND status = 'prospect'`, [clientId]));
}

/**
 * The job behind a request from the website widget: turns the lead into a
 * prospect with suggested prompts and competitors, then starts its audit. If
 * the audit cannot run (no audits or credits left, no engines), the lead is
 * kept, the agency is told why and the visitor is told the agency will be in touch.
 */
export async function processLead(deps: AuditDeps & { mailer: Mailer }, leadId: string, agencyId: string): Promise<void> {
  const ctx = { agencyId };
  const lead = await withTenant(ctx, async (db) => {
    const { rows } = await db.query(
      `UPDATE leads SET status = 'audit_started' WHERE id = $1 AND status = 'received'
       RETURNING id, name, email, business_name, domain, category, location`,
      [leadId],
    );
    return rows[0] as { id: string; name: string | null; email: string; business_name: string; domain: string; category: string; location: string | null } | undefined;
  });
  if (!lead) return;

  const notRun = async (reason: string, clientId: string | null) => {
    await withTenant(ctx, (db) => db.query(`UPDATE leads SET status = 'not_run', note = $2, client_id = $3 WHERE id = $1`, [lead.id, reason, clientId]));
    const { agency, owners } = await agencyContacts(agencyId);
    if (!agency) return;
    const brand = brandFor({ kind: 'agency', agency });
    const origin = originFor(agencyHost(agency));
    const leadInfo = { business: lead.business_name, domain: lead.domain, email: lead.email, name: lead.name };
    await sendAll(deps.mailer, [
      leadThanksEmail(brand, { to: lead.email, business: lead.business_name }),
      ...owners.map((to) => leadAgencyEmail(brand, { to, lead: leadInfo, url: `${origin}/audits`, outcome: 'not_run', reason })),
    ]);
  };

  const existing = await withTenant(ctx, async (db) => {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM clients WHERE domain = $1 ORDER BY created_at LIMIT 1`, [lead.domain]);
    return rows[0]?.id ?? null;
  });
  if (existing) return notRun('This website already has an audit or is one of your clients', existing);

  const competitors = await suggestCompetitors(deps.engines, {
    business: lead.business_name,
    domain: lead.domain,
    category: lead.category,
    location: lead.location,
  });
  const clientId = await createProspect(agencyId, {
    business: lead.business_name,
    domain: lead.domain,
    category: lead.category,
    location: lead.location,
    prompts: suggestPrompts(lead.category, lead.location),
    competitors: competitors.map((name) => ({ name })),
  });

  try {
    const { auditId } = await startAudit(deps, { agencyId, clientId, userId: null, source: 'widget' });
    await withTenant(ctx, (db) => db.query(`UPDATE leads SET client_id = $2, audit_id = $3 WHERE id = $1`, [lead.id, clientId, auditId]));
    // A run can finish before the lead is linked to it; check again now that it is.
    await completeAudit({ runId: (await runOf(agencyId, auditId))! }, deps.mailer);
  } catch (err) {
    await dropProspect(agencyId, clientId);
    await notRun(err instanceof HttpError ? err.message : 'The audit could not be started', null);
  }
}

async function runOf(agencyId: string, auditId: string): Promise<string | null> {
  return withTenant({ agencyId }, async (db) => {
    const { rows } = await db.query<{ run_id: string }>(`SELECT run_id FROM audits WHERE id = $1`, [auditId]);
    return rows[0]?.run_id ?? null;
  });
}

/** Site checks that never reported back (for example after a lost queue) are closed after 30 minutes. */
export async function closeStuckSiteAudits(mailer?: Mailer): Promise<number> {
  const stuck = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE site_audits SET status = 'failed', error = 'Timed out', finished_at = now()
        WHERE status = 'pending' AND created_at < now() - interval '30 minutes' RETURNING id`,
    );
    return rows;
  });
  for (const row of stuck) await completeAudit({ siteAuditId: row.id }, mailer);
  return stuck.length;
}
