import { agencyHost, originFor } from '../config.js';
import { withSystem, withTenant, type Db } from '../db.js';
import { brandFor, runSummaryEmail } from '../emails.js';
import type { SiteFetcher } from '../audits/fetch.js';
import { runSiteAudit, sendAll } from '../audits/pipeline.js';
import { visibleText } from '../audits/site.js';
import type { Mailer } from '../mailer.js';
import type { Agency } from '../tenant.js';
import { firstIndex } from '../tracker/parse.js';
import { diagnosisFor } from './diagnose.js';
import { refreshActions } from '../actions/rules.js';
import { countingFetcher, recordPages } from '../billing/usage.js';
import { classifySource, type ThirdPartyType } from './sources.js';

/** Most pages opened after one run. Checked pages are reused for 14 days, so later runs add few. */
export const PAGE_CHECK_LIMIT = 40;
const PAGE_REUSE_DAYS = 14;
/** The client's website is checked again when the last check is older than this. */
export const SITE_RECHECK_DAYS = 7;
const PAGE_CONCURRENCY = 4;

export interface DiagnosisDeps {
  fetcher: SiteFetcher;
  mailer: Mailer;
  siteMode: 'live' | 'mock';
}

export interface Brandish {
  competitorId: string | null;
  name: string;
  aliases: string[];
  domain: string | null;
}

export interface PageResult {
  status: 'done' | 'failed';
  title: string | null;
  listsClient: boolean | null;
  listsCompetitors: string[];
  error: string | null;
}

const titleOf = (html: string) => {
  const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return raw ? visibleText(`<body>${raw}</body>`).slice(0, 200) || null : null;
};

/**
 * Opens one cited page and records which of the tracked brands it names, by
 * name, alias, or a link to the brand's website. Through the same fetcher as
 * the website check, so private addresses, odd ports and huge pages are refused.
 */
export async function checkPage(fetcher: SiteFetcher, url: string, brands: Brandish[]): Promise<PageResult> {
  const failed = (error: string): PageResult => ({ status: 'failed', title: null, listsClient: null, listsCompetitors: [], error });
  try {
    const page = await fetcher(url);
    if (page.status >= 400) return failed(`The page answered with error ${page.status}.`);
    if (!/html/i.test(page.contentType)) return failed(`Not a web page (${page.contentType.split(';')[0] || 'unknown type'}).`);
    const title = titleOf(page.body);
    const text = `${title ?? ''} ${visibleText(page.body)}`;
    if (text.trim().length < 200) return { ...failed('The page shows almost no text without JavaScript.'), title };
    const hrefs = [...page.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase());
    const names = (brand: Brandish) =>
      [brand.name, ...brand.aliases].some((term) => firstIndex(text, term) >= 0) ||
      (brand.domain !== null && hrefs.some((h) => h.includes(`//${brand.domain}`) || h.includes(`.${brand.domain}`)));
    const client = brands.find((b) => b.competitorId === null)!;
    return {
      status: 'done',
      title,
      listsClient: names(client),
      listsCompetitors: brands.filter((b) => b.competitorId !== null && names(b)).map((b) => b.competitorId!),
      error: null,
    };
  } catch (err) {
    return failed(String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 200) || 'The page could not be opened.');
  }
}

async function mapLimit<T>(items: T[], limit: number, each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await each(items[next++]!);
  }));
}

/** Third-party pages cited in this run's lost answers that have not been checked lately, most-cited first. */
async function pagesToCheck(db: Db, runId: string, clientId: string): Promise<string[]> {
  const { rows } = await db.query<{ url: string; domain: string }>(
    `SELECT c.url, c.domain, count(DISTINCT pr.id)::int AS answers
       FROM citations c JOIN prompt_results pr ON pr.id = c.prompt_result_id
      WHERE pr.run_id = $1 AND pr.status = 'ok'
        AND NOT EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL)
        AND EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM source_pages sp WHERE sp.client_id = $2 AND sp.url = c.url
                         AND sp.checked_at > now() - make_interval(days => $3))
      GROUP BY c.url, c.domain
      ORDER BY answers DESC, c.url
      LIMIT $4`,
    [runId, clientId, PAGE_REUSE_DAYS, PAGE_CHECK_LIMIT * 3],
  );
  const { rows: client } = await db.query<{ domain: string | null }>(`SELECT domain FROM clients WHERE id = $1`, [clientId]);
  const { rows: competitors } = await db.query<{ id: string; domain: string | null }>(`SELECT id, domain FROM competitors WHERE client_id = $1`, [clientId]);
  const { rows: overrides } = await db.query<{ domain: string; source_type: ThirdPartyType }>(`SELECT domain, source_type FROM source_overrides`);
  const ctx = { clientDomain: client[0]?.domain ?? null, competitors, overrides: new Map(overrides.map((o) => [o.domain, o.source_type])) };
  return rows
    .filter((r) => {
      const type = classifySource(r.url, r.domain, ctx).type;
      return type !== 'own' && type !== 'competitor';
    })
    .slice(0, PAGE_CHECK_LIMIT)
    .map((r) => r.url);
}

/**
 * The follow-up to a completed run of a tracked client: check the client's
 * website if the last check is old, open the cited pages, then email the
 * summary. Each part happens once, and running the job again is harmless.
 */
export async function runDiagnosis(deps: DiagnosisDeps, runId: string, agencyId: string): Promise<void> {
  const ctx = { agencyId };
  const head = await withTenant(ctx, async (db) => {
    const { rows } = await db.query(
      `SELECT d.status, d.emailed_at, d.client_id, c.name, c.domain, c.brand_aliases, c.status AS client_status
         FROM diagnoses d JOIN clients c ON c.id = d.client_id WHERE d.run_id = $1`,
      [runId],
    );
    return rows[0] as
      | { status: 'pending' | 'done'; emailed_at: string | null; client_id: string; name: string; domain: string | null; brand_aliases: string[]; client_status: string }
      | undefined;
  });
  if (!head) return;
  const clientId = head.client_id;

  if (head.status === 'pending') {
    // 1. The client's website, at most once a week.
    if (head.domain) {
      const siteAuditId = await withTenant(ctx, async (db) => {
        const { rows: recent } = await db.query(
          `SELECT 1 FROM site_audits WHERE client_id = $1 AND created_at > now() - make_interval(days => $2) AND status IN ('pending', 'done')`,
          [clientId, SITE_RECHECK_DAYS],
        );
        if (recent.length > 0) return null;
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO site_audits (agency_id, client_id, domain, mode) VALUES ($1, $2, $3, $4) RETURNING id`,
          [agencyId, clientId, head.domain, deps.siteMode],
        );
        return rows[0]!.id;
      });
      if (siteAuditId) await runSiteAudit(deps.fetcher, siteAuditId, agencyId);
    }

    // 2. The cited pages behind the lost answers.
    const { urls, brands } = await withTenant(ctx, async (db) => {
      const { rows: competitors } = await db.query(`SELECT id, name, aliases, domain FROM competitors WHERE client_id = $1`, [clientId]);
      const brands: Brandish[] = [
        { competitorId: null, name: head.name, aliases: head.brand_aliases, domain: head.domain },
        ...competitors.map((c) => ({ competitorId: c.id as string, name: c.name as string, aliases: c.aliases as string[], domain: c.domain as string | null })),
      ];
      return { urls: await pagesToCheck(db, runId, clientId), brands };
    });
    let checked = 0;
    const counted = countingFetcher(deps.fetcher);
    await mapLimit(urls, PAGE_CONCURRENCY, async (url) => {
      const result = await checkPage(counted.fetcher, url, brands);
      checked++;
      await withTenant(ctx, (db) =>
        db.query(
          `INSERT INTO source_pages (agency_id, client_id, url, status, mode, title, lists_client, lists_competitors, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)
           ON CONFLICT (client_id, url) DO UPDATE SET status = EXCLUDED.status, mode = EXCLUDED.mode, title = EXCLUDED.title,
             lists_client = EXCLUDED.lists_client, lists_competitors = EXCLUDED.lists_competitors, error = EXCLUDED.error, checked_at = now()`,
          [agencyId, clientId, url, result.status, deps.siteMode, result.title, result.listsClient, result.listsCompetitors, result.error],
        ),
      );
    });
    await recordPages(agencyId, clientId, counted.count(), runId);

    // 3. Suggested actions, from the latest run only: an older run's diagnosis must not undo a newer one's.
    await withTenant(ctx, async (db) => {
      const { rows: latest } = await db.query(`SELECT id FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`, [clientId]);
      if (latest[0]?.id === runId && head.client_status !== 'prospect') await refreshActions(db, clientId, runId, await diagnosisFor(db, clientId, runId));
      await db.query(`UPDATE diagnoses SET status = 'done', pages_checked = $2, finished_at = now() WHERE run_id = $1 AND status = 'pending'`, [runId, checked]);
    });
  }

  // 4. The summary email, once.
  if (!head.emailed_at && head.client_status !== 'prospect') await sendRunSummary(deps.mailer, runId, agencyId, clientId);
}

async function sendRunSummary(mailer: Mailer, runId: string, agencyId: string, clientId: string): Promise<void> {
  const { agency, recipients } = await withSystem(async (db) => {
    const { rows } = await db.query<Agency & { run_emails: 'owners' | 'staff' | 'off' }>(
      `SELECT id, name, slug, custom_domain, domain_status, branding, status, plan_id, widget_enabled, run_emails FROM agencies WHERE id = $1`,
      [agencyId],
    );
    const agency = rows[0];
    if (!agency || agency.status !== 'active' || agency.run_emails === 'off') return { agency: null, recipients: [] };
    const roles = agency.run_emails === 'staff' ? ['agency_owner', 'agency_member'] : ['agency_owner'];
    const { rows: users } = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE agency_id = $1 AND role = ANY($2::text[]) ORDER BY created_at`,
      [agencyId, roles],
    );
    return { agency, recipients: users.map((u) => u.email) };
  });
  if (!agency || recipients.length === 0) return;

  const summary = await withTenant({ agencyId }, async (db) => {
    // Claim the email first, so two workers can never both send it.
    const claimed = await db.query(`UPDATE diagnoses SET emailed_at = now() WHERE run_id = $1 AND emailed_at IS NULL RETURNING run_id`, [runId]);
    if (!claimed.rowCount) return null;
    const { rows: runRows } = await db.query(`SELECT engine_mode, finished_at FROM runs WHERE id = $1`, [runId]);
    const { rows: clientRows } = await db.query(`SELECT name FROM clients WHERE id = $1`, [clientId]);
    const now = await diagnosisFor(db, clientId, runId);
    const { rows: prevRows } = await db.query<{ id: string }>(
      `SELECT id FROM runs WHERE client_id = $1 AND status = 'completed' AND id <> $2 AND finished_at < $3 ORDER BY finished_at DESC LIMIT 1`,
      [clientId, runId, runRows[0]!.finished_at],
    );
    const prev = prevRows[0] ? await diagnosisFor(db, clientId, prevRows[0].id) : null;
    const statusBefore = new Map(prev?.prompts.map((p) => [p.id, p.status]) ?? []);
    const named = (d: typeof now) => d.prompts.reduce((sum, p) => sum + p.clientAnswers, 0);
    return {
      client: clientRows[0]!.name as string,
      demo: runRows[0]!.engine_mode === 'mock',
      answers: now.totals.answers,
      named: named(now),
      previous: prev ? { answers: prev.totals.answers, named: named(prev) } : null,
      questions: now.totals.questions,
      lost: now.totals.lost,
      newlyLost: prev ? now.prompts.filter((p) => p.status === 'lost' && ['won', 'open'].includes(statusBefore.get(p.id) ?? '')).map((p) => p.text) : [],
      newlyWon: prev ? now.prompts.filter((p) => p.status === 'won' && statusBefore.get(p.id) === 'lost').map((p) => p.text) : [],
      causes: now.prompts.filter((p) => p.cause).map((p) => ({ question: p.text, sentence: p.cause!.sentence })),
      gaps: { count: now.gaps.length, top: now.gaps.map((g) => g.domain) },
      newActions: Number(
        (await db.query(
          `SELECT count(*) AS n FROM actions WHERE client_id = $1 AND last_run_id = $2 AND status = 'suggested'
              AND created_at >= (SELECT created_at FROM diagnoses WHERE run_id = $2)`,
          [clientId, runId],
        )).rows[0].n,
      ),
    };
  });
  if (!summary) return;

  const brand = brandFor({ kind: 'agency', agency });
  const url = `${originFor(agencyHost(agency))}/clients/${clientId}?tab=diagnosis`;
  await sendAll(mailer, recipients.map((to) => runSummaryEmail(brand, { ...summary, to, url })));
}

/** Follow-ups whose job was lost (Redis restarted, enqueue failed): queued again by the scheduler. */
export async function stuckDiagnoses(olderThanMinutes = 30): Promise<{ run_id: string; agency_id: string }[]> {
  const { rows } = await withSystem((db) =>
    db.query<{ run_id: string; agency_id: string }>(
      `SELECT run_id, agency_id FROM diagnoses
        WHERE (status = 'pending' AND created_at < now() - make_interval(mins => $1))
        ORDER BY created_at LIMIT 50`,
      [olderThanMinutes],
    ),
  );
  return rows;
}
