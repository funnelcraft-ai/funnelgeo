import type { Db } from '../db.js';
import type { Diagnosis, DiagnosisSource } from '../diagnosis/diagnose.js';
import { joinAll } from '../diagnosis/diagnose.js';

/**
 * Turns a run's diagnosis into suggested actions. Each lost question's cause
 * points to its fixes; the same fix for several questions is one action that
 * lists them all. Rules only: no model is involved in deciding what to do.
 */

export type ActionType = 'new_content' | 'content_update' | 'schema' | 'technical_fix' | 'off_site_listing' | 'off_site_outreach' | 'profile_review';
export type AssetKind = 'brief' | 'draft' | 'faq_schema' | 'llms_txt' | 'robots_patch' | 'outreach_email' | 'listing' | 'review_request';

export const ACTION_TYPE_LABEL: Record<ActionType, string> = {
  new_content: 'New content',
  content_update: 'Content update',
  schema: 'Schema',
  technical_fix: 'Technical fix',
  off_site_listing: 'Off-site listing',
  off_site_outreach: 'Off-site outreach',
  profile_review: 'Profile or reviews',
};

/** Dismissed actions are not suggested again for this long (PRD). */
export const DISMISS_DAYS = 90;
/** A finished action is not suggested again for this long, so the change after it can be measured first. */
export const DONE_QUIET_DAYS = 28;

/** Review platforms, where the fix is more reviews rather than a listing. */
const REVIEW_SITES = ['trustpilot.com', 'g2.com', 'capterra.com', 'getapp.com', 'sitejabber.com', 'yelp.com', 'tripadvisor.com', 'tripadvisor.in', 'glassdoor.com', 'practo.com', 'healthgrades.com', 'zocdoc.com'];
const onSite = (domain: string, site: string) => domain === site || domain.endsWith(`.${site}`);

export interface ActionDetails {
  domain?: string;
  sourceType?: string;
  pages?: { url: string; title: string | null; check: string | null }[];
  competitors?: string[];
  bots?: string[];
  engines?: string[];
  fix?: 'robots' | 'llms' | 'js';
  url?: string;
  questions?: string[];
}

export interface Candidate {
  key: string;
  type: ActionType;
  title: string;
  rationale: string;
  effort: 'S' | 'M' | 'L';
  details: ActionDetails;
  promptIds: string[];
}

/** What can be produced for an action. */
export function generatorsFor(type: ActionType, details: ActionDetails): AssetKind[] {
  switch (type) {
    case 'new_content':
    case 'content_update':
      return ['brief', 'draft', 'faq_schema'];
    case 'schema':
      return ['faq_schema'];
    case 'technical_fix':
      return details.fix === 'robots' ? ['robots_patch'] : details.fix === 'llms' ? ['llms_txt'] : [];
    case 'off_site_listing':
      return ['listing', 'outreach_email'];
    case 'off_site_outreach':
      return details.sourceType === 'forum' ? [] : ['outreach_email'];
    case 'profile_review':
      return ['review_request'];
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function candidatesFrom(d: Diagnosis, client: { name: string; domain: string | null }): Candidate[] {
  const C = client.name;
  const byKey = new Map<string, Candidate & { answers: number; competitorsSeen: Set<string> }>();
  const add = (c: Candidate, promptId: string | null, answers = 0, competitors: string[] = []) => {
    const existing = byKey.get(c.key);
    const entry = existing ?? { ...c, promptIds: [], answers: 0, competitorsSeen: new Set<string>() };
    if (promptId && !entry.promptIds.includes(promptId)) entry.promptIds.push(promptId);
    entry.answers += answers;
    for (const name of competitors) entry.competitorsSeen.add(name);
    if (existing && c.details.bots) {
      existing.details.bots = [...new Set([...(existing.details.bots ?? []), ...c.details.bots])];
      existing.details.engines = [...new Set([...(existing.details.engines ?? []), ...(c.details.engines ?? [])])];
    }
    if (existing && c.details.pages) {
      const known = new Set((existing.details.pages ?? []).map((p) => p.url));
      existing.details.pages = [...(existing.details.pages ?? []), ...c.details.pages.filter((p) => !known.has(p.url))];
    }
    byKey.set(c.key, entry);
  };

  const lost = d.prompts.filter((p) => p.status === 'lost' && p.cause);
  const winnersOf = (p: (typeof lost)[number]) => (p.leader ? [p.leader.name] : []);

  for (const p of lost) {
    const cause = p.cause!;

    // 1. The client's own robots.txt keeps an engine out.
    if (cause.kind === 'blocked') {
      const bots = cause.bots ?? [];
      const engines = cause.blockedEngines ?? [];
      add({
        key: 'fix:robots',
        type: 'technical_fix',
        title: `Let AI search crawlers read ${client.domain}`,
        rationale: `${C}’s robots.txt blocks ${joinAll(bots)}, so ${joinAll(engines)} can’t read or cite the site. Allowing these crawlers costs nothing and keeps model-training crawlers as they are.`,
        effort: 'S',
        details: { fix: 'robots', bots, engines },
        promptIds: [],
      }, p.id);
    }

    // 2. Third-party pages behind the loss: get the client onto them.
    for (const s of cause.sources) {
      if (s.type === 'own' || s.type === 'competitor' || s.type === 'robots' || s.check === 'listed') continue;
      add(siteCandidate(s, C), p.id, s.answers, winnersOf(p));
    }

    // 3. Nothing of the client's to cite: a page that answers the question.
    if (cause.kind === 'competitor_site' || cause.kind === 'uncited') {
      add({
        key: `content:${p.id}`,
        type: 'new_content',
        title: `Publish a page that answers “${p.text}”`,
        rationale: `${cause.sentence} A page on ${client.domain ?? `${C}’s site`} that answers this question directly, with the facts buyers compare on, gives the engines something of ${C}’s to cite.`,
        effort: 'L',
        details: { competitors: winnersOf(p), questions: [p.text] },
        promptIds: [],
      }, p.id);
    }

    // 4. The client's page is cited but doesn't get the client named.
    if (cause.kind === 'own_unnamed') {
      const page = cause.sources.find((s) => s.type === 'own');
      add({
        key: `update:${page?.url ?? p.id}`,
        type: 'content_update',
        title: `Make ${C} unmistakable on ${page ? new URL(page.url).pathname : 'the cited page'}`,
        rationale: `${cause.sentence} The page is already trusted as a source; it needs to say plainly who ${C} is and what it offers for this question.`,
        effort: 'M',
        details: { url: page?.url, competitors: winnersOf(p), questions: [p.text] },
        promptIds: [],
      }, p.id);
    }

    // 5. Losses with nothing of the client's to cite are also questions for an FAQ.
    if (cause.kind === 'competitor_site' || cause.kind === 'uncited' || cause.kind === 'own_unnamed') {
      add({
        key: 'faq',
        type: 'schema',
        title: `Add an FAQ with structured data to ${client.domain ?? `${C}’s site`}`,
        rationale: `Short, direct answers marked up as FAQPage structured data are easy for AI search to quote.`,
        effort: 'S',
        details: { questions: [] },
        promptIds: [],
      }, p.id);
    }
  }

  // Website-wide fixes from the readiness check.
  const checks = d.site?.findings?.checks ?? [];
  const failing = (key: string) => checks.find((c) => c.key === key && (c.status === 'fail' || c.status === 'warn'));
  const llms = failing('llms_txt');
  if (llms && client.domain) {
    add({ key: 'fix:llms', type: 'technical_fix', title: `Add an llms.txt file to ${client.domain}`, rationale: `${llms.detail} It is a small file and a newer convention, so it is the lowest of these fixes in weight.`, effort: 'S', details: { fix: 'llms' }, promptIds: [] }, null);
  }
  const js = checks.find((c) => c.key === 'readable_without_js' && c.status === 'fail');
  if (js && client.domain) {
    add({ key: 'fix:js', type: 'technical_fix', title: `Make ${client.domain} readable without JavaScript`, rationale: `${js.detail} AI crawlers mostly read the HTML as served, so content that only appears after scripts run is invisible to them.`, effort: 'L', details: { fix: 'js' }, promptIds: [] }, null);
  }
  const schema = failing('structured_data');
  if (schema && client.domain && !byKey.has('faq')) {
    add({ key: 'faq', type: 'schema', title: `Add an FAQ with structured data to ${client.domain}`, rationale: 'Short, direct answers marked up as FAQPage structured data are easy for AI search to quote.', effort: 'S', details: { questions: [] }, promptIds: [] }, null);
  }
  const faq = byKey.get('faq');
  if (faq && schema) faq.rationale = `${schema.detail} ${faq.rationale}`;

  // Finish: rationale numbers, questions list, impact order.
  const promptText = new Map(d.prompts.map((p) => [p.id, p.text]));
  return [...byKey.values()].map(({ answers, competitorsSeen, ...c }) => {
    if (c.key.startsWith('site:')) {
      const names = [...competitorsSeen];
      c.details.competitors = names;
      c.rationale = `Cited in ${plural(answers, 'answer', 'answers')} to ${plural(c.promptIds.length, 'lost question', 'lost questions')}${names.length ? ` that named ${joinAll(names)} instead` : ''}. ${c.rationale}`;
    }
    if (c.key === 'fix:robots') {
      c.rationale = `${C}’s robots.txt blocks ${joinAll(c.details.bots ?? [])}, so ${joinAll(c.details.engines ?? [])} can’t read or cite the site. Allowing these crawlers costs nothing and keeps model-training crawlers as they are.`;
    }
    if (c.key === 'faq') {
      c.details.questions = c.promptIds.map((id) => promptText.get(id)!).filter(Boolean);
      if (c.promptIds.length) c.rationale = `${c.rationale} It would answer ${plural(c.promptIds.length, 'lost question', 'lost questions')}.`;
    }
    return c;
  });
}

function siteCandidate(s: DiagnosisSource, C: string): Candidate {
  const pages = [{ url: s.url, title: s.title, check: s.check }];
  const checkNote = s.check === 'not_listed' ? `The page doesn’t list ${C}.` : s.check === 'failed' ? 'The page couldn’t be opened to check whether it lists the client.' : '';
  const base = { key: `site:${s.domain}`, promptIds: [] as string[] };
  if (s.type === 'directory') {
    if (REVIEW_SITES.some((site) => onSite(s.domain, site))) {
      return { ...base, type: 'profile_review', title: `Build up reviews of ${C} on ${s.domain}`, rationale: `${checkNote} Answers draw on review platforms; a complete profile with recent reviews makes ${C} eligible to be picked.`.trim(), effort: 'M', details: { domain: s.domain, sourceType: s.type, pages } };
    }
    return { ...base, type: 'off_site_listing', title: `List ${C} on ${s.domain}`, rationale: `${checkNote} Directories are a common source for these answers; a complete listing puts ${C} where the engines look.`.trim(), effort: 'S', details: { domain: s.domain, sourceType: s.type, pages } };
  }
  if (s.type === 'forum') {
    return { ...base, type: 'off_site_outreach', title: `Take part in the discussions on ${s.domain}`, rationale: `${checkNote} Answers quote these threads. Reply openly as ${C}, with useful answers rather than promotion; disguised posts break most communities’ rules and backfire.`.trim(), effort: 'M', details: { domain: s.domain, sourceType: s.type, pages } };
  }
  const title = s.title ? `Get ${C} into “${s.title.length > 80 ? `${s.title.slice(0, 77)}…` : s.title}” on ${s.domain}` : `Get ${C} mentioned on ${s.domain}`;
  return { ...base, type: 'off_site_outreach', title, rationale: `${checkNote} Ask the author or editor to consider ${C} for the page.`.trim(), effort: 'M', details: { domain: s.domain, sourceType: s.type, pages } };
}

export const impactOf = (promptIds: string[], priority: Map<string, boolean>) =>
  promptIds.reduce((sum, id) => sum + (priority.get(id) ? 2 : 1), 0);

/**
 * Brings a client's queue in line with a diagnosis: open actions for the same
 * problem are updated, new problems become suggestions unless recently
 * dismissed or done, and untouched suggestions the run no longer supports are
 * closed as resolved. Returns how many new suggestions were added.
 */
export async function refreshActions(db: Db, clientId: string, runId: string, d: Diagnosis): Promise<{ added: number; updated: number; resolved: number }> {
  const { rows: clients } = await db.query(`SELECT id, agency_id, name, domain FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);
  const client = clients[0];
  if (!client) return { added: 0, updated: 0, resolved: 0 };
  const candidates = candidatesFrom(d, client);
  const priority = new Map(d.prompts.map((p) => [p.id, p.priority]));

  const { rows: existing } = await db.query<{ id: string; key: string; status: string; dismiss_reason: string | null; dismissed_at: Date | null; done_at: Date | null }>(
    `SELECT id, key, status, dismiss_reason, dismissed_at, done_at FROM actions WHERE client_id = $1 ORDER BY created_at DESC`,
    [clientId],
  );
  const now = Date.now();
  const days = (date: Date | null) => (date ? (now - date.getTime()) / 86_400_000 : Infinity);
  let added = 0;
  let updated = 0;

  const link = async (actionId: string, promptIds: string[]) => {
    await db.query(`DELETE FROM action_prompts WHERE action_id = $1`, [actionId]);
    if (promptIds.length) {
      await db.query(
        `INSERT INTO action_prompts (action_id, prompt_id, agency_id, client_id) SELECT $1, id, $2, $3 FROM unnest($4::uuid[]) AS id`,
        [actionId, client.agency_id, clientId, promptIds],
      );
    }
  };

  for (const c of candidates) {
    const impact = impactOf(c.promptIds, priority);
    const history = existing.filter((a) => a.key === c.key);
    const open = history.find((a) => ['suggested', 'approved', 'in_progress'].includes(a.status));
    if (open) {
      // Suggestions take the latest wording; work already approved keeps its title and type.
      await db.query(
        open.status === 'suggested'
          ? `UPDATE actions SET impact_score = $2, details = $3, last_run_id = $4, title = $5, rationale = $6, type = $7, effort = $8, updated_at = now() WHERE id = $1`
          : `UPDATE actions SET impact_score = $2, details = $3, last_run_id = $4, updated_at = now() WHERE id = $1`,
        open.status === 'suggested' ? [open.id, impact, c.details, runId, c.title, c.rationale, c.type, c.effort] : [open.id, impact, c.details, runId],
      );
      await link(open.id, c.promptIds);
      updated++;
      continue;
    }
    const quiet = history.some(
      (a) => (a.status === 'dismissed' && a.dismiss_reason === 'member' && days(a.dismissed_at) < DISMISS_DAYS) || (a.status === 'done' && days(a.done_at) < DONE_QUIET_DAYS),
    );
    if (quiet) continue;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actions (agency_id, client_id, key, type, title, rationale, impact_score, effort, details, last_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [client.agency_id, clientId, c.key, c.type, c.title, c.rationale, impact, c.effort, c.details, runId],
    );
    await link(rows[0]!.id, c.promptIds);
    added++;
  }

  // Suggestions nobody touched, for problems this run no longer shows.
  const keys = candidates.map((c) => c.key);
  const resolved = await db.query(
    `UPDATE actions SET status = 'dismissed', dismiss_reason = 'resolved', dismissed_at = now(), updated_at = now()
      WHERE client_id = $1 AND status = 'suggested' AND NOT (key = ANY($2::text[]))`,
    [clientId, keys],
  );
  return { added, updated, resolved: resolved.rowCount ?? 0 };
}
