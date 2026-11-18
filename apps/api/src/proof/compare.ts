import type { Db } from '../db.js';

/**
 * Before and after for one finished action: how often the client was named
 * in answers to the action's linked questions, in the four weeks before the
 * done date and the four weeks after. Worked out each time it is read.
 *
 * It reports the change that followed the action, never that the action
 * caused it: AI answers shift from month to month for many reasons. A result
 * is shown only with enough answers on both sides, and counts as improved or
 * declined only when the change is both large and unlikely to be noise.
 */

export const WINDOW_DAYS = 28;
/** Fewest answers on each side before any label other than "too early". */
export const MIN_ANSWERS = 6;
/** The smallest change in share, in percentage points, that is labelled at all. */
const MIN_CHANGE = 0.1;
/** One-sided two-proportion z threshold (about 95%). */
const Z = 1.645;

export type ChangeLabel = 'improved' | 'no_change' | 'declined' | 'too_early';

interface Side {
  answers: number;
  named: number;
  runs: number;
  rate: number | null;
}

export interface Comparison {
  label: ChangeLabel;
  /** A plain sentence saying what the numbers show. */
  sentence: string;
  windowDays: number;
  /** False until four weeks have passed since the done date: the "after" figures are so far. */
  complete: boolean;
  before: Side;
  after: Side;
  byEngine: { key: string; label: string; before: Side; after: Side }[];
  visits: { path: string; before: number; after: number } | null;
  questions: number;
}

const side = (answers: number, named: number, runs: number): Side => ({ answers, named, runs, rate: answers ? named / answers : null });
const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);

export function labelFor(before: Side, after: Side): ChangeLabel {
  if (before.answers < MIN_ANSWERS || after.answers < MIN_ANSWERS) return 'too_early';
  const rb = before.rate!;
  const ra = after.rate!;
  const pooled = (before.named + after.named) / (before.answers + after.answers);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.answers + 1 / after.answers));
  const z = se === 0 ? 0 : (ra - rb) / se;
  if (ra - rb >= MIN_CHANGE && z >= Z) return 'improved';
  if (rb - ra >= MIN_CHANGE && z <= -Z) return 'declined';
  return 'no_change';
}

export async function comparisonFor(db: Db, action: { id: string; client_id: string; done_at: Date | string; done_url: string | null }, clientName: string): Promise<Comparison> {
  const done = new Date(action.done_at);
  const { rows: links } = await db.query<{ prompt_id: string }>(`SELECT prompt_id FROM action_prompts WHERE action_id = $1`, [action.id]);
  const promptIds = links.map((l) => l.prompt_id);

  // Answers to the linked questions from completed runs either side of the done date, by engine.
  const { rows } = await db.query<{ after: boolean; engine_key: string; label: string; answers: number; named: number; runs: number }>(
    `SELECT r.created_at >= $2 AS after, pr.engine_key, e.label,
            count(*)::int AS answers,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL))::int AS named,
            count(DISTINCT r.id)::int AS runs
       FROM prompt_results pr
       JOIN runs r ON r.id = pr.run_id
       JOIN engines e ON e.key = pr.engine_key
      WHERE pr.prompt_id = ANY($1::uuid[]) AND pr.status = 'ok' AND r.status = 'completed'
        AND r.created_at >= $2::timestamptz - make_interval(days => $3)
        AND r.created_at < $2::timestamptz + make_interval(days => $3)
      GROUP BY 1, 2, 3, e.sort
      ORDER BY e.sort`,
    [promptIds, done, WINDOW_DAYS],
  );
  // Runs are counted across engines, not summed per engine.
  const { rows: runCounts } = await db.query<{ after: boolean; runs: number }>(
    `SELECT r.created_at >= $2 AS after, count(DISTINCT r.id)::int AS runs
       FROM prompt_results pr JOIN runs r ON r.id = pr.run_id
      WHERE pr.prompt_id = ANY($1::uuid[]) AND pr.status = 'ok' AND r.status = 'completed'
        AND r.created_at >= $2::timestamptz - make_interval(days => $3) AND r.created_at < $2::timestamptz + make_interval(days => $3)
      GROUP BY 1`,
    [promptIds, done, WINDOW_DAYS],
  );
  const runsOn = (after: boolean) => runCounts.find((r) => r.after === after)?.runs ?? 0;
  const sum = (after: boolean) => {
    const of = rows.filter((r) => r.after === after);
    return side(of.reduce((s, r) => s + r.answers, 0), of.reduce((s, r) => s + r.named, 0), runsOn(after));
  };
  const before = sum(false);
  const after = sum(true);
  const engines = [...new Map(rows.map((r) => [r.engine_key, r.label])).entries()];
  const byEngine = engines.map(([key, label]) => {
    const b = rows.find((r) => r.engine_key === key && !r.after);
    const a = rows.find((r) => r.engine_key === key && r.after);
    return { key, label, before: side(b?.answers ?? 0, b?.named ?? 0, b?.runs ?? 0), after: side(a?.answers ?? 0, a?.named ?? 0, a?.runs ?? 0) };
  });

  // AI visits to the page the action published, either side of the done date.
  let visits: Comparison['visits'] = null;
  if (action.done_url) {
    try {
      const path = new URL(action.done_url).pathname || '/';
      const { rows: v } = await db.query<{ before: number; after: number }>(
        `SELECT count(*) FILTER (WHERE occurred_at < $3)::int AS before, count(*) FILTER (WHERE occurred_at >= $3)::int AS after
           FROM ai_visits WHERE client_id = $1 AND NOT is_test
            -- /page and /page/ are the same page.
            AND rtrim(landing_path, '/') = rtrim($2, '/')
            AND occurred_at >= $3::timestamptz - make_interval(days => $4) AND occurred_at < $3::timestamptz + make_interval(days => $4)`,
        [action.client_id, path, done, WINDOW_DAYS],
      );
      visits = { path, before: v[0]?.before ?? 0, after: v[0]?.after ?? 0 };
    } catch {
      visits = null;
    }
  }

  const label = promptIds.length ? labelFor(before, after) : 'too_early';
  const complete = Date.now() >= done.getTime() + WINDOW_DAYS * 86_400_000;
  const soFar = complete ? '' : ' so far';
  const rates = `${pct(before.rate)} of ${before.answers} answers before, ${pct(after.rate)} of ${after.answers} after${soFar}`;
  const sentence =
    promptIds.length === 0
      ? 'This action isn’t linked to particular questions, so there is no before and after for answers.'
      : after.answers === 0
        ? 'Waiting for the first completed run after the done date.'
        : before.answers < MIN_ANSWERS
          ? `Too few answers from the four weeks before the done date to compare (${before.answers}; at least ${MIN_ANSWERS} needed).`
          : after.answers < MIN_ANSWERS
            ? `Too few answers since the done date to compare yet (${after.answers}; at least ${MIN_ANSWERS} needed).`
            : label === 'improved'
              ? `${clientName} was named more often after this action: ${rates}.`
              : label === 'declined'
                ? `${clientName} was named less often after this action: ${rates}.`
                : `No clear change after this action: ${rates}.`;

  return { label, sentence, windowDays: WINDOW_DAYS, complete, before, after, byEngine, visits, questions: promptIds.length };
}
