import type { Db } from '../db.js';
import type { SiteFindings } from '../audits/site.js';
import { classifySource, SOURCE_LABEL, SOURCE_NOUN, type ClassifyContext, type SourceType, type ThirdPartyType } from './sources.js';

/**
 * Diagnosis of one run, worked out from the stored answers each time it is
 * read, so a re-parse or a corrected source type shows at once.
 *
 * A question is lost when some competitor was named in more of its answers
 * than the client. Every lost question gets one cause, in one plain sentence,
 * chosen from what the answers actually cite, and the sources behind it.
 * Causes describe what the engines did. They never claim to know why.
 */

/** Which engine reads a site through which crawler. Claude is not tracked. */
const ENGINE_CRAWLER: Record<string, string> = { chatgpt: 'OAI-SearchBot', perplexity: 'PerplexityBot', gemini: 'Google-Extended' };
/** A third-party domain is a citation gap when it is cited in at least this many answers that named a competitor but not the client. */
export const GAP_MIN_ANSWERS = 2;
const MAX_SOURCES = 5;

export type PromptStatus = 'won' | 'lost' | 'open' | 'no_answers';
export type CauseKind = 'blocked' | 'third_party' | 'competitor_site' | 'own_unnamed' | 'uncited';
export type PageCheck = 'not_listed' | 'listed' | 'unchecked' | 'failed';

export interface DiagnosisSource {
  url: string;
  domain: string;
  type: SourceType | 'robots';
  typeLabel: string;
  /** Answers to this question (or, for fallback sources, in the run) that cited this page. */
  answers: number;
  title: string | null;
  check: PageCheck | null;
  /** True when the page is not cited for this question but for the leading competitor elsewhere in the run. */
  elsewhere: boolean;
}

interface Answer {
  id: string;
  promptId: string;
  engine: string;
  clientNamed: boolean;
  competitorsNamed: string[];
  citations: { url: string; domain: string }[];
}

interface PageRow {
  url: string;
  status: 'done' | 'failed';
  title: string | null;
  lists_client: boolean | null;
  lists_competitors: string[];
  checked_at: string;
  error: string | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** "A", "A and B", "A, B and C". */
export function joinAll(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

export async function diagnosisFor(db: Db, clientId: string, runId: string) {
  const { rows: clients } = await db.query(`SELECT id, agency_id, name, domain FROM clients WHERE id = $1`, [clientId]);
  const client = clients[0] as { id: string; agency_id: string; name: string; domain: string | null };
  const { rows: competitors } = await db.query<{ id: string; name: string; domain: string | null }>(
    `SELECT id, name, domain FROM competitors WHERE client_id = $1 ORDER BY created_at, id`,
    [clientId],
  );
  const competitorName = (id: string) => competitors.find((c) => c.id === id)?.name ?? 'A competitor';
  const { rows: overrideRows } = await db.query<{ domain: string; source_type: ThirdPartyType }>(`SELECT domain, source_type FROM source_overrides`);
  const ctx: ClassifyContext = {
    clientDomain: client.domain,
    competitors,
    overrides: new Map(overrideRows.map((o) => [o.domain, o.source_type])),
  };

  const { rows: engineRows } = await db.query<{ key: string; label: string }>(`SELECT key, label FROM engines ORDER BY sort`);
  const engineLabel = (key: string) => engineRows.find((e) => e.key === key)?.label ?? key;

  const { rows: promptRows } = await db.query<{ id: string; text: string; intent: string; priority: boolean }>(
    `SELECT DISTINCT p.id, p.text, p.intent, p.priority, p.created_at
       FROM prompts p JOIN prompt_results pr ON pr.prompt_id = p.id
      WHERE pr.run_id = $1
      ORDER BY p.priority DESC, p.created_at, p.id`,
    [runId],
  );

  // Every answered call, with who it named and what it cited.
  const { rows: resultRows } = await db.query(
    `SELECT pr.id, pr.prompt_id, pr.engine_key,
            coalesce((SELECT bool_or(m.competitor_id IS NULL) FROM result_mentions m WHERE m.prompt_result_id = pr.id), false) AS client_named,
            coalesce((SELECT array_agg(m.competitor_id ORDER BY m.position) FROM result_mentions m
                       WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NOT NULL), '{}') AS competitors_named,
            coalesce((SELECT json_agg(json_build_object('url', c.url, 'domain', c.domain) ORDER BY c.position) FROM citations c
                       WHERE c.prompt_result_id = pr.id), '[]') AS citations
       FROM prompt_results pr
      WHERE pr.run_id = $1 AND pr.status = 'ok'`,
    [runId],
  );
  const answers: Answer[] = resultRows.map((r) => ({
    id: r.id,
    promptId: r.prompt_id,
    engine: r.engine_key,
    clientNamed: r.client_named,
    competitorsNamed: r.competitors_named,
    citations: r.citations,
  }));

  const { rows: pageRows } = await db.query<PageRow>(
    `SELECT url, status, title, lists_client, lists_competitors, checked_at, error FROM source_pages WHERE client_id = $1`,
    [clientId],
  );
  const pages = new Map(pageRows.map((p) => [p.url, p]));
  const checkOf = (url: string): PageCheck => {
    const page = pages.get(url);
    if (!page) return 'unchecked';
    if (page.status === 'failed') return 'failed';
    return page.lists_client ? 'listed' : 'not_listed';
  };

  const classified = new Map<string, ReturnType<typeof classifySource>>();
  const classify = (url: string, domain: string) => {
    let c = classified.get(url);
    if (!c) {
      c = classifySource(url, domain, ctx, pages.get(url)?.title);
      classified.set(url, c);
    }
    return c;
  };

  // Latest website check, for the "blocked crawler" cause and the readiness card.
  const { rows: siteRows } = await db.query(
    `SELECT id, status, mode, findings, error, created_at, finished_at FROM site_audits
      WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [clientId],
  );
  const siteRow = siteRows[0];
  const findings = siteRow?.status === 'done' ? (siteRow.findings as SiteFindings) : null;
  const blockedTokens = new Set((findings?.blockedCrawlers ?? []).filter((c) => c.kind === 'answers').map((c) => c.token));

  // Per question ------------------------------------------------------------------
  const prompts = promptRows.map((prompt) => {
    const mine = answers.filter((a) => a.promptId === prompt.id);
    const clientAnswers = mine.filter((a) => a.clientNamed).length;
    const byCompetitor = new Map<string, number>();
    for (const a of mine) for (const id of a.competitorsNamed) byCompetitor.set(id, (byCompetitor.get(id) ?? 0) + 1);
    const ranked = [...byCompetitor].sort((x, y) => y[1] - x[1] || competitorName(x[0]).localeCompare(competitorName(y[0])));
    const leadAnswers = ranked[0]?.[1] ?? 0;

    const status: PromptStatus =
      mine.length === 0 ? 'no_answers' : leadAnswers > clientAnswers ? 'lost' : clientAnswers > 0 ? 'won' : 'open';

    // Engines where this question was lost.
    const engines = engineRows.map((e) => e.key).filter((key) => mine.some((a) => a.engine === key)).map((key) => {
      const on = mine.filter((a) => a.engine === key);
      const client = on.filter((a) => a.clientNamed).length;
      const counts = new Map<string, number>();
      for (const a of on) for (const id of a.competitorsNamed) counts.set(id, (counts.get(id) ?? 0) + 1);
      const best = Math.max(0, ...counts.values());
      return { key, label: engineLabel(key), answers: on.length, client, lost: best > client };
    });

    const base = {
      id: prompt.id,
      text: prompt.text,
      intent: prompt.intent,
      priority: prompt.priority,
      status,
      answers: mine.length,
      clientAnswers,
      leader: ranked[0] ? { name: competitorName(ranked[0][0]), answers: leadAnswers } : null,
      engines,
      cause: null as null | { kind: CauseKind; sentence: string; sources: DiagnosisSource[]; note: string | null; bots?: string[]; blockedEngines?: string[] },
    };
    if (status !== 'lost') return base;
    base.cause = causeFor({ mine, ranked, engines });
    return base;
  });

  function causeFor({ mine, ranked, engines }: { mine: Answer[]; ranked: [string, number][]; engines: { key: string; label: string; lost: boolean }[] }) {
    // The answers that named a competitor and not the client: these are the losses.
    const lostAnswers = mine.filter((a) => !a.clientNamed && a.competitorsNamed.length > 0);
    const winners = ranked.filter(([id]) => lostAnswers.some((a) => a.competitorsNamed.includes(id))).map(([id]) => competitorName(id));
    const who = listNames(winners);
    const verb = winners.length === 1 ? 'is' : 'are';
    const C = client.name;

    const cited = new Map<string, { url: string; domain: string; answers: number }>();
    for (const a of lostAnswers) {
      for (const c of a.citations) {
        const entry = cited.get(c.url) ?? { url: c.url, domain: c.domain, answers: 0 };
        entry.answers++;
        cited.set(c.url, entry);
      }
    }
    const asSource = (c: { url: string; domain: string; answers: number }, elsewhere = false): DiagnosisSource => {
      const type = classify(c.url, c.domain).type;
      const thirdParty = type !== 'own' && type !== 'competitor';
      return { url: c.url, domain: c.domain, type, typeLabel: SOURCE_LABEL[type], answers: c.answers, title: pages.get(c.url)?.title ?? null, check: thirdParty ? checkOf(c.url) : null, elsewhere };
    };
    const all = [...cited.values()].map((c) => asSource(c)).sort((x, y) => y.answers - x.answers || x.url.localeCompare(y.url));
    const thirdParty = all.filter((s) => s.type !== 'own' && s.type !== 'competitor');
    // Pages that do not list the client lead: they are where the fix is.
    const checkOrder: Record<PageCheck, number> = { not_listed: 0, unchecked: 1, failed: 2, listed: 3 };
    thirdParty.sort((x, y) => checkOrder[x.check!] - checkOrder[y.check!] || y.answers - x.answers);
    const competitorPages = all.filter((s) => s.type === 'competitor');
    const ownPages = all.filter((s) => s.type === 'own');

    // 1. The client's site keeps out the crawler of an engine where the question was lost.
    const blockedOn = engines.filter((e) => e.lost && blockedTokens.has(ENGINE_CRAWLER[e.key] ?? ''));
    if (blockedOn.length > 0 && client.domain) {
      const bots = blockedOn.map((e) => ENGINE_CRAWLER[e.key]!);
      const robots: DiagnosisSource = {
        url: `https://${client.domain}/robots.txt`, domain: client.domain, type: 'robots', typeLabel: 'Client’s robots.txt',
        answers: 0, title: null, check: null, elsewhere: false,
      };
      return {
        kind: 'blocked' as const,
        sentence: `${C}’s robots.txt blocks ${joinAll(bots)}, so ${joinAll(blockedOn.map((e) => e.label))} can’t read its site; ${who} ${verb} named instead.`,
        sources: [robots, ...thirdParty, ...competitorPages].slice(0, MAX_SOURCES),
        note: null,
        bots,
        blockedEngines: blockedOn.map((e) => e.label),
      };
    }

    // 2. Third-party pages name the competitors.
    if (thirdParty.length > 0) {
      const n = thirdParty.length;
      const types = new Set(thirdParty.map((s) => s.type as ThirdPartyType));
      const noun = types.size === 1 ? SOURCE_NOUN[[...types][0]!] : (['third-party page', 'third-party pages'] as [string, string]);
      const what = n === 1 ? `a ${noun[0]}` : `${n} ${noun[1]}`;
      const notListed = thirdParty.filter((s) => s.check === 'not_listed').length;
      const listedCount = thirdParty.filter((s) => s.check === 'listed').length;
      const failed = thirdParty.filter((s) => s.check === 'failed').length;
      const unchecked = n - notListed - listedCount - failed;
      let sentence: string;
      if (notListed === n) sentence = `${who} ${verb} named from ${what} that ${plural(n, 'doesn’t', 'don’t')} list ${C}.`;
      else if (listedCount === n) sentence = `${who} ${verb} named from ${what} that also ${plural(n, 'lists', 'list')} ${C}, but the answers picked ${who} over it.`;
      else if (notListed > 0) sentence = `${who} ${verb} named from ${what}; ${notListed} of them ${plural(notListed, 'doesn’t', 'don’t')} list ${C}.`;
      else if (unchecked > 0) sentence = `${who} ${verb} named from ${what}. Whether ${plural(n, 'it lists', 'they list')} ${C} hasn’t been checked yet.`;
      else sentence = `${who} ${verb} named from ${what}, which couldn’t be opened to check whether ${plural(n, 'it lists', 'they list')} ${C}.`;
      return { kind: 'third_party' as const, sentence, sources: [...thirdParty, ...competitorPages].slice(0, MAX_SOURCES), note: null };
    }

    // 3. The competitors' own websites are the sources.
    if (competitorPages.length > 0) {
      const owners = [...new Set(competitorPages.map((s) => competitors.find((c) => c.domain && (s.domain === c.domain || s.domain.endsWith(`.${c.domain}`)))?.name ?? s.domain))];
      const theirs = owners.length === 1 ? `${owners[0]}’s own website` : `the competitors’ own websites`;
      const yours = ownPages.length > 0 ? '' : client.domain ? ` ${C}’s site isn’t cited for this question.` : ` No page of ${C}’s is cited.`;
      return { kind: 'competitor_site' as const, sentence: `The answers cite ${theirs} and name ${who}.${yours}`, sources: competitorPages.slice(0, MAX_SOURCES), note: null };
    }

    // 4. The client's own site is cited, yet the answer names someone else.
    if (ownPages.length > 0) {
      return {
        kind: 'own_unnamed' as const,
        sentence: `${C}’s site is cited, but the answers name ${who} and not ${C}.`,
        sources: ownPages.slice(0, MAX_SOURCES),
        note: null,
      };
    }

    // 5. No sources at all: the engine answered from what it already knows.
    // Point to where the leading competitor is cited elsewhere in this run.
    const leaderId = ranked[0]?.[0];
    const elsewhere = new Map<string, { url: string; domain: string; answers: number }>();
    for (const a of answers) {
      if (!leaderId || !a.competitorsNamed.includes(leaderId) || a.clientNamed) continue;
      for (const c of a.citations) {
        const t = classify(c.url, c.domain).type;
        if (t === 'own') continue;
        const entry = elsewhere.get(c.url) ?? { url: c.url, domain: c.domain, answers: 0 };
        entry.answers++;
        elsewhere.set(c.url, entry);
      }
    }
    let sources = [...elsewhere.values()].sort((x, y) => y.answers - x.answers).map((c) => asSource(c, true));
    const leader = competitors.find((c) => c.id === leaderId);
    if (sources.length === 0 && leader?.domain) {
      sources = [{ url: `https://${leader.domain}/`, domain: leader.domain, type: 'competitor', typeLabel: SOURCE_LABEL.competitor, answers: 0, title: null, check: null, elsewhere: true }];
    }
    const lostOn = engines.filter((e) => e.lost).map((e) => e.label);
    return {
      kind: 'uncited' as const,
      sentence: `${joinAll(lostOn)} named ${who} without citing any source, so the choice came from what ${plural(lostOn.length, 'that engine', 'those engines')} already ${plural(lostOn.length, 'knows', 'know')} about these brands.`,
      sources: sources.slice(0, MAX_SOURCES),
      note: sources.length > 0 && sources[0]!.type !== 'competitor' ? `Pages that cite ${leader?.name ?? 'the leading competitor'} elsewhere in this run:` : sources.length > 0 ? `${leader?.name}’s website:` : null,
    };
  }

  // Source map: every cited site, by type ---------------------------------------
  interface DomainStat {
    domain: string;
    type: SourceType;
    corrected: boolean;
    competitor: string | null;
    answers: Set<string>;
    withClient: Set<string>;
    competitorOnly: Set<string>;
    competitorsNamed: Map<string, number>;
    urls: Map<string, number>;
    prompts: Set<string>;
  }
  const domains = new Map<string, DomainStat>();
  for (const a of answers) {
    const seenHere = new Set<string>();
    for (const c of a.citations) {
      const k = classify(c.url, c.domain);
      const stat: DomainStat = domains.get(c.domain) ?? {
        domain: c.domain,
        type: k.type,
        corrected: k.corrected,
        competitor: k.competitorId ? competitorName(k.competitorId) : null,
        answers: new Set(), withClient: new Set(), competitorOnly: new Set(), competitorsNamed: new Map(), urls: new Map(), prompts: new Set(),
      };
      // A domain takes the most specific type seen across its pages (a list article beats "other").
      if (stat.type === 'other' && k.type !== 'other') stat.type = k.type;
      stat.urls.set(c.url, (stat.urls.get(c.url) ?? 0) + 1);
      domains.set(c.domain, stat);
      if (seenHere.has(c.domain)) continue;
      seenHere.add(c.domain);
      stat.answers.add(a.id);
      stat.prompts.add(a.promptId);
      if (a.clientNamed) stat.withClient.add(a.id);
      else if (a.competitorsNamed.length > 0) {
        stat.competitorOnly.add(a.id);
        for (const id of a.competitorsNamed) stat.competitorsNamed.set(id, (stat.competitorsNamed.get(id) ?? 0) + 1);
      }
    }
  }
  const domainList = [...domains.values()].sort((x, y) => y.answers.size - x.answers.size || x.domain.localeCompare(y.domain));
  const isThirdParty = (t: SourceType) => t !== 'own' && t !== 'competitor';

  const byType = (['own', 'competitor', 'list_review', 'directory', 'forum', 'news', 'other'] as SourceType[]).map((type) => {
    const of = domainList.filter((d) => d.type === type);
    const ids = new Set(of.flatMap((d) => [...d.answers]));
    return { type, label: SOURCE_LABEL[type], domains: of.length, answers: ids.size };
  });

  const pageSummary = (stat: DomainStat) => {
    const urls = [...stat.urls.keys()];
    const checks = urls.map(checkOf);
    return { checked: checks.filter((c) => c === 'listed' || c === 'not_listed').length, listsClient: checks.filter((c) => c === 'listed').length, failed: checks.filter((c) => c === 'failed').length };
  };

  const gaps = domainList
    .filter((d) => isThirdParty(d.type) && d.competitorOnly.size >= GAP_MIN_ANSWERS)
    .sort((x, y) => y.competitorOnly.size - x.competitorOnly.size || x.domain.localeCompare(y.domain))
    .map((d) => ({
      domain: d.domain,
      type: d.type,
      typeLabel: SOURCE_LABEL[d.type],
      answers: d.competitorOnly.size,
      questions: new Set(answers.filter((a) => d.competitorOnly.has(a.id)).map((a) => a.promptId)).size,
      competitors: [...d.competitorsNamed].sort((x, y) => y[1] - x[1]).map(([id]) => competitorName(id)),
      urls: [...d.urls].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([url]) => ({ url, title: pages.get(url)?.title ?? null, check: checkOf(url) })),
      pages: pageSummary(d),
    }));

  const lost = prompts.filter((p) => p.status === 'lost');
  const { rows: diagnosisRows } = await db.query(`SELECT status, pages_checked, finished_at FROM diagnoses WHERE run_id = $1`, [runId]);

  return {
    runId,
    status: (diagnosisRows[0]?.status ?? 'done') as 'pending' | 'done',
    pagesChecked: (diagnosisRows[0]?.pages_checked ?? 0) as number,
    totals: {
      questions: prompts.filter((p) => p.status !== 'no_answers').length,
      lost: lost.length,
      won: prompts.filter((p) => p.status === 'won').length,
      open: prompts.filter((p) => p.status === 'open').length,
      gaps: gaps.length,
      domains: domainList.length,
      answers: answers.length,
      uncitedAnswers: answers.filter((a) => a.citations.length === 0).length,
    },
    prompts,
    gaps,
    sources: {
      byType,
      domains: domainList.slice(0, 60).map((d) => ({
        domain: d.domain,
        type: d.type,
        typeLabel: SOURCE_LABEL[d.type],
        corrected: d.corrected,
        competitor: d.competitor,
        answers: d.answers.size,
        withClient: d.withClient.size,
        competitorOnly: d.competitorOnly.size,
        topUrl: [...d.urls].sort((x, y) => y[1] - x[1])[0]![0],
      })),
    },
    site: siteRow
      ? {
          id: siteRow.id as string,
          status: siteRow.status as 'pending' | 'done' | 'failed',
          mode: siteRow.mode as 'live' | 'mock',
          checkedAt: (siteRow.finished_at ?? siteRow.created_at) as string,
          error: siteRow.error as string | null,
          findings,
          passed: findings ? findings.checks.filter((c) => c.status === 'pass').length : 0,
        }
      : null,
  };
}

export type Diagnosis = Awaited<ReturnType<typeof diagnosisFor>>;
