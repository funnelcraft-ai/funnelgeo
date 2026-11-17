import type { Db } from '../db.js';
import { notFound } from '../http.js';
import { visibilityFor } from '../tracker/visibility.js';
import type { Check, SiteFindings } from './site.js';

export interface Fix {
  key: string;
  title: string;
  why: string;
  effort: 'quick' | 'some' | 'project';
}

interface FixInput {
  business: string;
  domain: string;
  site: SiteFindings | null;
  missing: { text: string; competitors: string[] }[];
  gaps: { domain: string; answers: number }[];
}

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The first five things to fix, most important first. Every rule is fixed and
 * written out here, so the same findings always give the same advice.
 */
export function buildFixes(input: FixInput): Fix[] {
  const check = (key: Check['key']) => input.site?.checks.find((c) => c.key === key);
  const status = (key: Check['key']) => check(key)?.status;
  const fixes: Fix[] = [];
  const add = (when: boolean, fix: Fix) => {
    if (when) fixes.push(fix);
  };
  const missingFix = (i: number) => {
    const m = input.missing[i];
    if (!m) return;
    add(true, {
      key: `answer_prompt_${i}`,
      title: `Publish a page that answers “${m.text}”`,
      why: `${list(m.competitors)} ${m.competitors.length === 1 ? 'is' : 'are'} named for this question and ${input.business} is not.`,
      effort: 'some',
    });
  };
  const gapFix = (i: number) => {
    const g = input.gaps[i];
    if (!g) return;
    add(true, {
      key: `get_listed_${i}`,
      title: `Get ${input.business} listed on ${g.domain}`,
      why: `The engines cited ${g.domain} in ${g.answers} ${g.answers === 1 ? 'answer' : 'answers'} that did not name ${input.business}.`,
      effort: 'some',
    });
  };

  add(status('site_loads') === 'fail', {
    key: 'site_loads',
    title: `Make sure ${input.domain} loads for crawlers`,
    why: check('site_loads')?.detail ?? '',
    effort: 'some',
  });
  const blocked = input.site?.blockedCrawlers.filter((c) => c.kind === 'answers') ?? [];
  add(blocked.length > 0, {
    key: 'unblock_crawlers',
    title: 'Unblock AI search crawlers in robots.txt',
    why: `robots.txt blocks ${list(blocked.map((c) => c.token))}. While they are blocked, the site cannot be cited in ${list(blocked.map((c) => c.label))}.`,
    effort: 'quick',
  });
  add(status('readable_without_js') === 'fail', {
    key: 'render_without_js',
    title: 'Make the main content load without JavaScript',
    why: check('readable_without_js')?.detail ?? '',
    effort: 'project',
  });
  missingFix(0);
  gapFix(0);
  add(status('structured_data') === 'fail', {
    key: 'structured_data',
    title: 'Add structured data that describes the business',
    why: 'Organization or LocalBusiness markup states plainly what the business is, where it is and what it offers, in a form AI tools read reliably.',
    effort: 'quick',
  });
  add(status('answer_structure') === 'warn', {
    key: 'answer_structure',
    title: 'Add a questions-and-answers section to key pages',
    why: 'AI tools quote pages that answer a question directly. None of the pages checked does that yet.',
    effort: 'some',
  });
  add(status('readable_without_js') === 'warn', {
    key: 'render_without_js',
    title: 'Put more of the home page in plain HTML',
    why: check('readable_without_js')?.detail ?? '',
    effort: 'some',
  });
  missingFix(1);
  gapFix(1);
  add(status('https') === 'fail', { key: 'https', title: 'Serve the site over HTTPS', why: check('https')?.detail ?? '', effort: 'quick' });
  add(status('page_basics') === 'warn', { key: 'page_basics', title: 'Add a page title and description to the home page', why: check('page_basics')?.detail ?? '', effort: 'quick' });
  add(status('sitemap') === 'warn', { key: 'sitemap', title: 'Publish an XML sitemap', why: check('sitemap')?.detail ?? '', effort: 'quick' });
  add(status('llms_txt') === 'warn', {
    key: 'llms_txt',
    title: 'Add an llms.txt file',
    why: 'A small extra that summarises the site for AI tools. Few engines are known to read it yet, so do the fixes above first.',
    effort: 'quick',
  });

  const seen = new Set<string>();
  return fixes.filter((f) => !seen.has(f.key) && seen.add(f.key)).slice(0, 5);
}

/** Everything an audit report shows. The same data backs the in-app view and the public share link. */
export async function buildReport(db: Db, auditId: string) {
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.source, a.created_at, a.completed_at, a.share_token, a.client_id, a.run_id,
            c.name, c.domain, c.category, c.location, c.status AS client_status,
            r.status AS run_status, r.engine_mode, r.engine_keys, r.samples, r.prompt_count, r.total_calls, r.ok_calls, r.failed_calls,
            s.status AS site_status, s.mode AS site_mode, s.findings, s.error AS site_error
       FROM audits a
       JOIN clients c ON c.id = a.client_id
       JOIN runs r ON r.id = a.run_id
       LEFT JOIN site_audits s ON s.id = a.site_audit_id
      WHERE a.id = $1`,
    [auditId],
  );
  const a = rows[0];
  if (!a) throw notFound('Audit not found');

  const visibility = a.run_status === 'completed' ? await visibilityFor(db, a.client_id, a.run_id) : null;
  const { rows: competitors } = await db.query<{ name: string; domain: string | null }>(`SELECT name, domain FROM competitors WHERE client_id = $1`, [a.client_id]);

  // Questions where the business was never named but a competitor was.
  let missing: { id: string; text: string; competitors: string[] }[] = [];
  let gaps: { domain: string; answers: number }[] = [];
  if (visibility) {
    const { rows: named } = await db.query<{ prompt_id: string; name: string; n: number }>(
      `SELECT pr.prompt_id, k.name, count(*)::int AS n
         FROM result_mentions m JOIN prompt_results pr ON pr.id = m.prompt_result_id JOIN competitors k ON k.id = m.competitor_id
        WHERE pr.run_id = $1 AND pr.status = 'ok'
        GROUP BY pr.prompt_id, k.name
        ORDER BY n DESC, k.name`,
      [a.run_id],
    );
    missing = visibility.prompts
      .filter((p) => p.answers > 0 && p.mentioned === 0)
      .map((p) => ({ id: p.id, text: p.text, priority: p.priority, competitors: named.filter((n) => n.prompt_id === p.id).map((n) => n.name) }))
      .filter((p) => p.competitors.length > 0)
      .sort((x, y) => Number(y.priority) - Number(x.priority) || y.competitors.length - x.competitors.length)
      .slice(0, 5)
      .map(({ id, text, competitors: names }) => ({ id, text, competitors: names }));

    // Third-party sites cited in answers that did not name the business: places it could get listed.
    const { rows: cited } = await db.query<{ domain: string; answers: number }>(
      `SELECT ci.domain, count(DISTINCT ci.prompt_result_id)::int AS answers
         FROM citations ci JOIN prompt_results pr ON pr.id = ci.prompt_result_id
        WHERE pr.run_id = $1 AND pr.status = 'ok' AND NOT ci.is_client
          AND NOT EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL)
        GROUP BY ci.domain
        ORDER BY answers DESC, ci.domain
        LIMIT 30`,
      [a.run_id],
    );
    const ownedByCompetitor = (domain: string) => competitors.some((c) => c.domain && (domain === c.domain || domain.endsWith(`.${c.domain}`)));
    gaps = cited.filter((g) => !ownedByCompetitor(g.domain)).slice(0, 5);
  }

  const site = a.site_status === 'done' ? (a.findings as SiteFindings) : null;
  const fixes = a.status === 'running' ? [] : buildFixes({ business: a.name, domain: a.domain, site, missing, gaps });
  const done = a.ok_calls + a.failed_calls;

  return {
    id: a.id as string,
    shareToken: a.share_token as string,
    status: a.status as 'running' | 'completed' | 'failed',
    source: a.source as 'manual' | 'widget',
    createdAt: a.created_at as string,
    completedAt: a.completed_at as string | null,
    clientId: a.client_id as string,
    clientStatus: a.client_status as string,
    business: a.name as string,
    domain: a.domain as string,
    category: a.category as string | null,
    location: a.location as string | null,
    demo: a.engine_mode === 'mock' || a.site_mode === 'mock',
    run: {
      status: a.run_status as string,
      samples: a.samples as number,
      promptCount: a.prompt_count as number,
      engines: a.engine_keys as string[],
      totalCalls: a.total_calls as number,
      done,
      failed: a.failed_calls as number,
    },
    site: {
      status: (a.site_status ?? 'failed') as 'pending' | 'done' | 'failed',
      findings: site,
      passed: site ? site.checks.filter((c) => c.status === 'pass').length : 0,
    },
    competitors: competitors.map((c) => c.name),
    visibility,
    missing,
    gaps,
    fixes,
  };
}

export type AuditReport = Awaited<ReturnType<typeof buildReport>>;
