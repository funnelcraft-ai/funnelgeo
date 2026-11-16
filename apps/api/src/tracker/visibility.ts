import type { Db } from '../db.js';

/**
 * Everything the visibility screen shows for one run. All figures are counts
 * of answers with the number of answers they are out of; nothing here is a
 * blended score. Computed from the result rows on every request, so a
 * re-parse is reflected at once and there are no stored totals to go stale.
 */
export async function visibilityFor(db: Db, clientId: string, runId: string) {
  const { rows: clients } = await db.query(`SELECT name, domain FROM clients WHERE id = $1`, [clientId]);
  const client = clients[0]!;
  const { rows: competitors } = await db.query(`SELECT id, name, domain FROM competitors WHERE client_id = $1 ORDER BY created_at, id`, [clientId]);

  const { rows: engineRows } = await db.query(
    `SELECT e.key, e.label,
            count(*) FILTER (WHERE pr.status = 'ok')::int AS answers,
            count(*) FILTER (WHERE pr.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE pr.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE pr.status = 'ok' AND EXISTS (
              SELECT 1 FROM result_mentions m WHERE m.prompt_result_id = pr.id AND m.competitor_id IS NULL))::int AS mentioned,
            count(*) FILTER (WHERE pr.status = 'ok' AND EXISTS (
              SELECT 1 FROM citations c WHERE c.prompt_result_id = pr.id AND c.is_client))::int AS cited
       FROM prompt_results pr JOIN engines e ON e.key = pr.engine_key
      WHERE pr.run_id = $1
      GROUP BY e.key, e.label, e.sort
      ORDER BY e.sort`,
    [runId],
  );
  const engines = engineRows.map((e) => ({ key: e.key, label: e.label, answers: e.answers, failed: e.failed, pending: e.pending, mentioned: e.mentioned, cited: e.cited }));
  const sum = (field: 'answers' | 'failed' | 'pending' | 'mentioned' | 'cited') => engines.reduce((total, e) => total + e[field], 0);
  const answers = sum('answers');

  // Share of voice: in how many answers each tracked brand was named.
  const { rows: mentionRows } = await db.query(
    `SELECT m.competitor_id, count(*)::int AS mentions, round(avg(m.position), 1)::float AS avg_position
       FROM result_mentions m JOIN prompt_results pr ON pr.id = m.prompt_result_id
      WHERE pr.run_id = $1 AND pr.status = 'ok'
      GROUP BY m.competitor_id`,
    [runId],
  );
  const mentionsOf = (competitorId: string | null) => mentionRows.find((m) => m.competitor_id === competitorId);
  const brands = [
    { id: null as string | null, name: client.name as string, isClient: true },
    ...competitors.map((c) => ({ id: c.id as string | null, name: c.name as string, isClient: false })),
  ]
    .map((brand) => ({
      ...brand,
      mentions: mentionsOf(brand.id)?.mentions ?? 0,
      avgPosition: (mentionsOf(brand.id)?.avg_position as number | undefined) ?? null,
    }))
    .sort((a, b) => b.mentions - a.mentions || Number(b.isClient) - Number(a.isClient) || a.name.localeCompare(b.name));

  // Per prompt and engine: answers received, and how many named the client.
  const { rows: promptRows } = await db.query(
    `SELECT p.id, p.text, p.intent, p.priority, pr.engine_key,
            count(*) FILTER (WHERE pr.status = 'ok')::int AS answers,
            count(cm.id)::int AS mentioned,
            round(avg(cm.position), 1)::float AS avg_position
       FROM prompt_results pr
       JOIN prompts p ON p.id = pr.prompt_id
       LEFT JOIN result_mentions cm ON cm.prompt_result_id = pr.id AND cm.competitor_id IS NULL AND pr.status = 'ok'
      WHERE pr.run_id = $1
      GROUP BY p.id, p.text, p.intent, p.priority, p.created_at, pr.engine_key
      ORDER BY p.priority DESC, p.created_at, p.id`,
    [runId],
  );
  type PromptRow = { id: string; text: string; intent: string; priority: boolean; answers: number; mentioned: number; engines: Record<string, { answers: number; mentioned: number }> };
  const prompts = new Map<string, PromptRow>();
  for (const row of promptRows) {
    const prompt: PromptRow = prompts.get(row.id) ?? { id: row.id, text: row.text, intent: row.intent, priority: row.priority, answers: 0, mentioned: 0, engines: {} };
    prompt.engines[row.engine_key] = { answers: row.answers, mentioned: row.mentioned };
    prompt.answers += row.answers;
    prompt.mentioned += row.mentioned;
    prompts.set(row.id, prompt);
  }

  // The sites engines cited most, by number of answers citing them.
  const { rows: domainRows } = await db.query(
    `SELECT c.domain, count(DISTINCT c.prompt_result_id)::int AS answers, bool_or(c.is_client) AS is_client
       FROM citations c JOIN prompt_results pr ON pr.id = c.prompt_result_id
      WHERE pr.run_id = $1 AND pr.status = 'ok'
      GROUP BY c.domain
      ORDER BY answers DESC, c.domain
      LIMIT 15`,
    [runId],
  );
  const ownerOf = (domain: string) =>
    competitors.find((c) => c.domain && (domain === c.domain || domain.endsWith(`.${c.domain}`)))?.name ?? null;

  return {
    totals: { answers, mentioned: sum('mentioned'), cited: sum('cited'), failed: sum('failed'), pending: sum('pending') },
    engines,
    brands,
    prompts: [...prompts.values()],
    domains: domainRows.map((d) => ({ domain: d.domain as string, answers: d.answers as number, isClient: d.is_client as boolean, competitor: d.is_client ? null : ownerOf(d.domain) })),
  };
}

/** The client's last completed runs, oldest first, for the trend strip. */
export async function trendFor(db: Db, clientId: string, limit = 8) {
  const { rows } = await db.query(
    `SELECT r.id, r.finished_at, r.engine_mode,
            count(pr.id) FILTER (WHERE pr.status = 'ok')::int AS answers,
            count(m.id)::int AS mentioned
       FROM runs r
       JOIN prompt_results pr ON pr.run_id = r.id
       LEFT JOIN result_mentions m ON m.prompt_result_id = pr.id AND m.competitor_id IS NULL AND pr.status = 'ok'
      WHERE r.client_id = $1 AND r.status = 'completed'
      GROUP BY r.id
      ORDER BY r.finished_at DESC
      LIMIT $2`,
    [clientId, limit],
  );
  return rows.reverse().map((r) => ({ runId: r.id as string, finishedAt: r.finished_at as string, engineMode: r.engine_mode as string, answers: r.answers as number, mentioned: r.mentioned as number }));
}
