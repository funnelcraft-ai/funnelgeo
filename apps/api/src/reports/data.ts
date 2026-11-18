import type { Db } from '../db.js';
import { ACTION_TYPE_LABEL, type ActionType } from '../actions/rules.js';
import { comparisonFor, type ChangeLabel } from '../proof/compare.js';
import { sourceLabel } from '../proof/sources.js';

/**
 * Every figure in a monthly report, worked out from the stored answers,
 * actions and visits for the period. The report keeps this snapshot so the
 * client sees exactly what was approved; drafts can be refreshed.
 *
 * All rates come with the counts they are made of. Nothing is a blended score.
 */

interface Rate {
  answers: number;
  named: number;
  rate: number | null;
}
const rate = (answers: number, named: number): Rate => ({ answers, named, rate: answers ? named / answers : null });

export interface ReportData {
  client: { name: string; domain: string | null };
  period: { start: string; end: string; label: string };
  previous: { start: string; end: string; label: string };
  runs: number;
  questions: number;
  overall: Rate;
  overallBefore: Rate | null;
  engines: { key: string; label: string; now: Rate; before: Rate | null }[];
  shareOfVoice: { name: string; isClient: boolean; answers: number; share: number | null }[];
  trend: { date: string; answers: number; named: number; rate: number | null }[];
  actionsDone: { title: string; type: string; doneAt: string; url: string | null; note: string | null; change: ChangeLabel | null; changeSentence: string | null }[];
  visits: {
    installed: boolean;
    total: number;
    conversions: number;
    totalBefore: number;
    byEngine: { label: string; visits: number; conversions: number }[];
    pages: { path: string; visits: number }[];
  };
  plan: { title: string; type: string; status: string }[];
  method: { engines: string[]; samplesPerQuestion: number | null; engineMode: 'live' | 'mock' | 'mixed' | null };
  demo: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthLabel = (start: Date, end: Date) => {
  const sameMonth = start.getUTCDate() === 1 && new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate() && start.getUTCMonth() === end.getUTCMonth();
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  return sameMonth ? fmt(start, { month: 'long', year: 'numeric' }) : `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

/** The period of the same length just before, for comparison: the previous calendar month for a calendar month. */
export function previousPeriod(start: Date, end: Date): { start: Date; end: Date } {
  if (start.getUTCDate() === 1 && new Date(end.getTime() + 86_400_000).getUTCDate() === 1) {
    const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    return { start: prevStart, end: new Date(start.getTime() - 86_400_000) };
  }
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return { start: new Date(start.getTime() - days * 86_400_000), end: new Date(start.getTime() - 86_400_000) };
}

/** Period bounds as a half-open range of timestamps: [start 00:00, day after end 00:00). */
const bounds = (start: Date, end: Date): [string, string] => [start.toISOString(), new Date(end.getTime() + 86_400_000).toISOString()];

export async function buildReportData(db: Db, clientId: string, startDate: string, endDate: string): Promise<ReportData> {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const prev = previousPeriod(start, end);
  const [from, to] = bounds(start, end);
  const [prevFrom, prevTo] = bounds(prev.start, prev.end);

  const { rows: clients } = await db.query(`SELECT name, domain, snippet_seen_at FROM clients WHERE id = $1`, [clientId]);
  const client = clients[0]!;

  // Answers from completed runs that started in a period, by engine.
  const byEngine = async (a: string, b: string) =>
    (
      await db.query<{ key: string; label: string; answers: number; named: number }>(
        `SELECT e.key, e.label, count(*)::int AS answers,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL))::int AS named
           FROM prompt_results pr JOIN runs r ON r.id = pr.run_id JOIN engines e ON e.key = pr.engine_key
          WHERE r.client_id = $1 AND r.status = 'completed' AND pr.status = 'ok' AND r.created_at >= $2 AND r.created_at < $3
          GROUP BY e.key, e.label, e.sort ORDER BY e.sort`,
        [clientId, a, b],
      )
    ).rows;
  const now = await byEngine(from, to);
  const before = await byEngine(prevFrom, prevTo);
  const total = (rows: typeof now) => rate(rows.reduce((s, r) => s + r.answers, 0), rows.reduce((s, r) => s + r.named, 0));
  const beforeTotal = total(before);

  const { rows: runRows } = await db.query<{ id: string; created_at: Date; samples: number; engine_mode: string }>(
    `SELECT id, created_at, samples, engine_mode FROM runs
      WHERE client_id = $1 AND status = 'completed' AND created_at >= $2 AND created_at < $3 ORDER BY created_at`,
    [clientId, from, to],
  );
  const { rows: trendRows } = await db.query<{ run_id: string; answers: number; named: number }>(
    `SELECT pr.run_id, count(*)::int AS answers,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL))::int AS named
       FROM prompt_results pr WHERE pr.run_id = ANY($1::uuid[]) AND pr.status = 'ok' GROUP BY pr.run_id`,
    [runRows.map((r) => r.id)],
  );
  const { rows: questionRows } = await db.query<{ n: number }>(
    `SELECT count(DISTINCT pr.prompt_id)::int AS n FROM prompt_results pr WHERE pr.run_id = ANY($1::uuid[])`,
    [runRows.map((r) => r.id)],
  );

  // Share of voice: in how many of the period's answers each tracked brand was named.
  const { rows: sovRows } = await db.query<{ competitor_id: string | null; answers: number }>(
    `SELECT m.competitor_id, count(DISTINCT m.prompt_result_id)::int AS answers
       FROM result_mentions m JOIN prompt_results pr ON pr.id = m.prompt_result_id JOIN runs r ON r.id = pr.run_id
      WHERE r.client_id = $1 AND r.status = 'completed' AND pr.status = 'ok' AND r.created_at >= $2 AND r.created_at < $3
      GROUP BY m.competitor_id`,
    [clientId, from, to],
  );
  const { rows: competitors } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM competitors WHERE client_id = $1 ORDER BY created_at`, [clientId]);
  const brandAnswers = [
    { name: client.name as string, isClient: true, answers: sovRows.find((r) => r.competitor_id === null)?.answers ?? 0 },
    ...competitors.map((c) => ({ name: c.name, isClient: false, answers: sovRows.find((r) => r.competitor_id === c.id)?.answers ?? 0 })),
  ];
  const allMentions = brandAnswers.reduce((s, b) => s + b.answers, 0);
  const shareOfVoice = brandAnswers
    .map((b) => ({ ...b, share: allMentions ? b.answers / allMentions : null }))
    .sort((a, b) => b.answers - a.answers || Number(b.isClient) - Number(a.isClient));

  // Actions finished in the period, each with what followed it.
  const { rows: doneRows } = await db.query(
    `SELECT id, client_id, type, title, done_at, done_url, done_note FROM actions
      WHERE client_id = $1 AND status = 'done' AND done_at >= $2 AND done_at < $3 ORDER BY done_at`,
    [clientId, from, to],
  );
  const actionsDone = [];
  for (const a of doneRows) {
    const c = await comparisonFor(db, a, client.name);
    actionsDone.push({
      title: a.title as string,
      type: ACTION_TYPE_LABEL[a.type as ActionType],
      doneAt: (a.done_at as Date).toISOString(),
      url: a.done_url as string | null,
      note: a.done_note as string | null,
      change: c.questions > 0 ? c.label : null,
      changeSentence: c.questions > 0 ? c.sentence : null,
    });
  }

  // AI visits in the period, test visits left out.
  const { rows: visitEngines } = await db.query<{ source_engine: string; visits: number; conversions: number }>(
    `SELECT source_engine, count(*)::int AS visits, count(*) FILTER (WHERE converted)::int AS conversions FROM ai_visits
      WHERE client_id = $1 AND NOT is_test AND occurred_at >= $2 AND occurred_at < $3 GROUP BY 1 ORDER BY 2 DESC`,
    [clientId, from, to],
  );
  const { rows: visitPages } = await db.query<{ landing_path: string; visits: number }>(
    `SELECT landing_path, count(*)::int AS visits FROM ai_visits
      WHERE client_id = $1 AND NOT is_test AND occurred_at >= $2 AND occurred_at < $3 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
    [clientId, from, to],
  );
  const { rows: visitsBefore } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_visits WHERE client_id = $1 AND NOT is_test AND occurred_at >= $2 AND occurred_at < $3`,
    [clientId, prevFrom, prevTo],
  );

  // Next month: work in hand first, then the highest-impact suggestions.
  const { rows: planRows } = await db.query(
    `SELECT title, type, status FROM actions WHERE client_id = $1 AND status IN ('approved', 'in_progress', 'suggested')
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, impact_score DESC, created_at LIMIT 5`,
    [clientId],
  );

  const modes = new Set(runRows.map((r) => r.engine_mode));
  return {
    client: { name: client.name, domain: client.domain },
    period: { start: iso(start), end: iso(end), label: monthLabel(start, end) },
    previous: { start: iso(prev.start), end: iso(prev.end), label: monthLabel(prev.start, prev.end) },
    runs: runRows.length,
    questions: questionRows[0]?.n ?? 0,
    overall: total(now),
    overallBefore: beforeTotal.answers ? beforeTotal : null,
    engines: now.map((e) => {
      const b = before.find((x) => x.key === e.key);
      return { key: e.key, label: e.label, now: rate(e.answers, e.named), before: b ? rate(b.answers, b.named) : null };
    }),
    shareOfVoice,
    trend: runRows.map((r) => {
      const t = trendRows.find((x) => x.run_id === r.id);
      return { date: r.created_at.toISOString(), answers: t?.answers ?? 0, named: t?.named ?? 0, rate: t?.answers ? t.named / t.answers : null };
    }),
    actionsDone,
    visits: {
      installed: client.snippet_seen_at !== null,
      total: visitEngines.reduce((s, v) => s + v.visits, 0),
      conversions: visitEngines.reduce((s, v) => s + v.conversions, 0),
      totalBefore: visitsBefore[0]?.n ?? 0,
      byEngine: visitEngines.map((v) => ({ label: sourceLabel(v.source_engine), visits: v.visits, conversions: v.conversions })),
      pages: visitPages.map((p) => ({ path: p.landing_path, visits: p.visits })),
    },
    plan: planRows.map((p) => ({ title: p.title, type: ACTION_TYPE_LABEL[p.type as ActionType], status: p.status })),
    method: {
      engines: now.map((e) => e.label),
      samplesPerQuestion: runRows[0]?.samples ?? null,
      engineMode: modes.size === 0 ? null : modes.size > 1 ? 'mixed' : (([...modes][0] as 'live' | 'mock') ?? null),
    },
    demo: modes.has('mock'),
  };
}

const pct = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
const STATUS: Record<string, string> = { in_progress: 'in progress', approved: 'approved', suggested: 'proposed' };

/** The plan as editable text, from the queue. */
export function defaultPlan(d: ReportData): string {
  if (!d.plan.length) return 'Keep tracking the same questions and review new suggestions after each run.';
  return d.plan.map((p) => `- ${p.title} (${p.type.toLowerCase()}, ${STATUS[p.status] ?? p.status})`).join('\n');
}

/** The facts the summary is written from: the model gets nothing else. */
export function summaryFacts(d: ReportData): string {
  const lines = [
    `Client: ${d.client.name}`,
    `Period: ${d.period.label} (${d.period.start} to ${d.period.end}); compared with ${d.previous.label}`,
    `Runs in the period: ${d.runs}; questions tracked: ${d.questions}; each question asked ${d.method.samplesPerQuestion ?? '?'} times per engine per run`,
    `Named in AI answers: ${pct(d.overall.rate)} (${d.overall.named} of ${d.overall.answers} answers)` +
      (d.overallBefore ? `; previous period ${pct(d.overallBefore.rate)} (${d.overallBefore.named} of ${d.overallBefore.answers})` : '; no previous period to compare'),
    ...d.engines.map((e) => `- ${e.label}: ${pct(e.now.rate)} (${e.now.named} of ${e.now.answers})${e.before ? `, previously ${pct(e.before.rate)} (${e.before.named} of ${e.before.answers})` : ''}`),
    `Share of voice (share of tracked-brand mentions): ${d.shareOfVoice.map((b) => `${b.name}${b.isClient ? ' (client)' : ''} ${pct(b.share)}`).join(', ')}`,
    d.actionsDone.length
      ? `Actions finished: ${d.actionsDone.map((a) => `${a.title} [${a.change ? a.change.replace('_', ' ') : 'no linked questions'}${a.changeSentence ? `: ${a.changeSentence}` : ''}]`).join('; ')}`
      : 'Actions finished: none in this period',
    d.visits.installed
      ? `Visits from AI assistants to the website: ${d.visits.total} (previous period ${d.visits.totalBefore}); conversions ${d.visits.conversions}${d.visits.byEngine.length ? `; by assistant: ${d.visits.byEngine.map((v) => `${v.label} ${v.visits}`).join(', ')}` : ''}`
      : 'Visits from AI assistants: the tracking snippet is not installed, so there is no visit data',
    `Planned next: ${d.plan.map((p) => p.title).join('; ') || 'nothing queued'}`,
  ];
  return lines.join('\n');
}
