import type { Db } from './db.js';

/**
 * The agency dashboard: headline figures, the weekly trend by engine, the
 * health of each client, and recent activity. Runs inside withTenant, so a
 * client viewer sees only their own client. Every rate comes with the count
 * it is out of; visibility is the share of answers that named the client.
 */

export const STALE_DAYS = 14;
const WEEKS = 8;

export type Health = 'healthy' | 'watch' | 'attention';

export async function overviewFor(db: Db, opts: { staff: boolean }) {
  // Each active client's two latest completed runs.
  const { rows: runRows } = await db.query(
    `WITH ranked AS (
       SELECT r.id, r.client_id, r.finished_at, (row_number() OVER (PARTITION BY r.client_id ORDER BY r.finished_at DESC))::int AS n
         FROM runs r JOIN clients c ON c.id = r.client_id
        WHERE r.status = 'completed' AND c.status = 'active')
     SELECT ranked.client_id, ranked.n, ranked.finished_at,
            count(pr.id) FILTER (WHERE pr.status = 'ok')::int AS answers,
            count(DISTINCT pr.id) FILTER (WHERE pr.status = 'ok' AND m.id IS NOT NULL)::int AS mentioned,
            (SELECT count(*) FROM result_mentions mm JOIN prompt_results p2 ON p2.id = mm.prompt_result_id
              WHERE p2.run_id = ranked.id AND p2.status = 'ok')::int AS all_mentions,
            (SELECT count(*) FROM result_mentions mm JOIN prompt_results p2 ON p2.id = mm.prompt_result_id
              WHERE p2.run_id = ranked.id AND p2.status = 'ok' AND mm.competitor_id IS NULL)::int AS own_mentions
       FROM ranked
       JOIN prompt_results pr ON pr.run_id = ranked.id
       LEFT JOIN result_mentions m ON m.prompt_result_id = pr.id AND m.competitor_id IS NULL
      WHERE ranked.n <= 2
      GROUP BY ranked.id, ranked.client_id, ranked.n, ranked.finished_at`,
  );
  const { rows: lastRun } = await db.query(
    `SELECT DISTINCT ON (r.client_id) r.client_id, r.status, r.created_at
       FROM runs r JOIN clients c ON c.id = r.client_id WHERE c.status = 'active' AND r.status <> 'skipped'
      ORDER BY r.client_id, r.created_at DESC`,
  );
  const { rows: clientRows } = await db.query(
    `SELECT c.id, c.name, c.domain, c.schedule,
            (SELECT count(*) FROM prompts p WHERE p.client_id = c.id AND p.active)::int AS questions,
            (SELECT count(*) FROM ai_visits v WHERE v.client_id = c.id AND NOT v.is_test AND v.occurred_at >= now() - interval '28 days')::int AS visits,
            (SELECT count(*) FROM ai_visits v WHERE v.client_id = c.id AND NOT v.is_test
               AND v.occurred_at >= now() - interval '56 days' AND v.occurred_at < now() - interval '28 days')::int AS visits_before,
            (SELECT count(*) FROM actions a WHERE a.client_id = c.id AND a.status IN ('suggested', 'approved', 'in_progress'))::int AS open_actions
       FROM clients c WHERE c.status = 'active' ORDER BY c.name`,
  );

  const now = Date.now();
  const clients = clientRows.map((c) => {
    const latest = runRows.find((r) => r.client_id === c.id && r.n === 1);
    const previous = runRows.find((r) => r.client_id === c.id && r.n === 2);
    const last = lastRun.find((r) => r.client_id === c.id);
    const rate = latest && latest.answers > 0 ? latest.mentioned / latest.answers : null;
    const prevRate = previous && previous.answers > 0 ? previous.mentioned / previous.answers : null;
    const change = rate !== null && prevRate !== null ? rate - prevRate : null;
    const ageDays = latest ? (now - new Date(latest.finished_at).getTime()) / 86_400_000 : null;

    let health: Health = 'healthy';
    let reason = 'Visibility steady or rising';
    if (!latest) {
      health = 'attention';
      reason = c.questions === 0 ? 'No questions to track yet' : last?.status === 'failed' ? 'The first run failed' : 'No completed run yet';
    } else if (last?.status === 'failed') {
      health = 'attention';
      reason = 'The latest run failed';
    } else if (ageDays !== null && ageDays > STALE_DAYS) {
      health = 'attention';
      reason = `No run for ${Math.floor(ageDays)} days`;
    } else if (change !== null && change <= -0.1) {
      health = 'attention';
      reason = `Visibility down ${Math.round(-change * 100)} points`;
    } else if (change !== null && change <= -0.05) {
      health = 'watch';
      reason = `Visibility down ${Math.round(-change * 100)} points`;
    }

    return {
      id: c.id as string,
      name: c.name as string,
      domain: (c.domain as string | null) ?? null,
      questions: c.questions as number,
      lastRunAt: (latest?.finished_at as string | undefined) ?? null,
      answers: (latest?.answers as number | undefined) ?? 0,
      mentioned: (latest?.mentioned as number | undefined) ?? 0,
      visibility: rate,
      change,
      // Share of voice: the client's mentions among all tracked brands' mentions in its latest run.
      shareOfVoice: latest && latest.all_mentions > 0 ? latest.own_mentions / latest.all_mentions : null,
      visits: c.visits as number,
      visitsBefore: c.visits_before as number,
      openActions: c.open_actions as number,
      health,
      reason,
    };
  });

  // Headline figures across clients' latest runs.
  const measured = clients.filter((c) => c.answers > 0);
  const answers = measured.reduce((s, c) => s + c.answers, 0);
  const mentioned = measured.reduce((s, c) => s + c.mentioned, 0);
  const { rows: before } = await db.query(
    `SELECT coalesce(sum(answers), 0)::int AS answers, coalesce(sum(mentioned), 0)::int AS mentioned FROM (${PREVIOUS_RUNS}) x`,
  );
  const prevRate = before[0]!.answers > 0 ? before[0]!.mentioned / before[0]!.answers : null;
  const rate = answers > 0 ? mentioned / answers : null;

  // Weekly trend by engine, across all active clients' completed runs.
  const { rows: weekRows } = await db.query(
    `SELECT to_char(date_trunc('week', r.finished_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, e.key, e.label, e.sort,
            count(pr.id) FILTER (WHERE pr.status = 'ok')::int AS answers,
            count(DISTINCT pr.id) FILTER (WHERE pr.status = 'ok' AND m.id IS NOT NULL)::int AS mentioned
       FROM runs r
       JOIN clients c ON c.id = r.client_id AND c.status = 'active'
       JOIN prompt_results pr ON pr.run_id = r.id
       JOIN engines e ON e.key = pr.engine_key
       LEFT JOIN result_mentions m ON m.prompt_result_id = pr.id AND m.competitor_id IS NULL
      WHERE r.status = 'completed' AND r.finished_at >= date_trunc('week', now() AT TIME ZONE 'UTC') - interval '${WEEKS - 1} weeks'
      GROUP BY 1, e.key, e.label, e.sort
      ORDER BY 1, e.sort`,
  );
  const engines = [...new Map(weekRows.map((w) => [w.key, { key: w.key as string, label: w.label as string }])).values()];
  const weeks: { week: string; engines: Record<string, { answers: number; mentioned: number }> }[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const d = new Date();
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - i * 7));
    const week = monday.toISOString().slice(0, 10);
    const entry = { week, engines: {} as Record<string, { answers: number; mentioned: number }> };
    for (const w of weekRows.filter((x) => x.week === week)) entry.engines[w.key] = { answers: w.answers, mentioned: w.mentioned };
    weeks.push(entry);
  }

  const visits = clients.reduce((s, c) => s + c.visits, 0);
  const visitsBefore = clients.reduce((s, c) => s + c.visitsBefore, 0);
  const health = { healthy: 0, watch: 0, attention: 0 };
  for (const c of clients) health[c.health]++;

  return {
    kpis: {
      visibility: { rate, answers, mentioned, previous: prevRate, clientsMeasured: measured.length },
      visits: { last28: visits, previous28: visitsBefore },
      questions: { active: clients.reduce((s, c) => s + c.questions, 0), clients: clients.length },
      attention: { clients: health.attention, openActions: clients.reduce((s, c) => s + c.openActions, 0) },
    },
    trend: { engines, weeks },
    health,
    clients,
    activity: await activityFor(db, opts.staff),
  };
}

/** Each client's previous completed run (the one before its latest). */
const PREVIOUS_RUNS = `
  SELECT count(pr.id) FILTER (WHERE pr.status = 'ok') AS answers,
         count(DISTINCT pr.id) FILTER (WHERE pr.status = 'ok' AND m.id IS NOT NULL) AS mentioned
    FROM (SELECT r.id, row_number() OVER (PARTITION BY r.client_id ORDER BY r.finished_at DESC) AS n
            FROM runs r JOIN clients c ON c.id = r.client_id WHERE r.status = 'completed' AND c.status = 'active') ranked
    JOIN prompt_results pr ON pr.run_id = ranked.id
    LEFT JOIN result_mentions m ON m.prompt_result_id = pr.id AND m.competitor_id IS NULL
   WHERE ranked.n = 2
   GROUP BY ranked.id`;

export type ActivityKind = 'run' | 'run_failed' | 'action_done' | 'report_sent' | 'audit';

/** The latest events across the workspace, newest first. */
async function activityFor(db: Db, staff: boolean) {
  const { rows } = await db.query(
    `(SELECT 'run' AS kind, r.finished_at AS at, c.id AS client_id, c.name AS client, NULL::text AS title, r.id::text AS ref,
             (SELECT count(*) FILTER (WHERE pr.status = 'ok') FROM prompt_results pr WHERE pr.run_id = r.id)::int AS n1,
             (SELECT count(DISTINCT pr.id) FROM prompt_results pr JOIN result_mentions m ON m.prompt_result_id = pr.id AND m.competitor_id IS NULL
               WHERE pr.run_id = r.id AND pr.status = 'ok')::int AS n2
        FROM runs r JOIN clients c ON c.id = r.client_id
       WHERE r.status = 'completed' AND c.status = 'active' AND r.finished_at IS NOT NULL
       ORDER BY r.finished_at DESC LIMIT 6)
     UNION ALL
     (SELECT 'run_failed', r.finished_at, c.id, c.name, NULL, r.id::text, 0, 0
        FROM runs r JOIN clients c ON c.id = r.client_id
       WHERE r.status = 'failed' AND c.status = 'active' AND r.finished_at IS NOT NULL
       ORDER BY r.finished_at DESC LIMIT 4)
     UNION ALL
     (SELECT 'action_done', a.done_at, c.id, c.name, a.title, a.id::text, 0, 0
        FROM actions a JOIN clients c ON c.id = a.client_id
       WHERE a.status = 'done' ORDER BY a.done_at DESC LIMIT 6)
     UNION ALL
     (SELECT 'report_sent', rp.sent_at, c.id, c.name, to_char(rp.period_start, 'FMMonth YYYY'), rp.id::text, 0, 0
        FROM reports rp JOIN clients c ON c.id = rp.client_id
       WHERE rp.status = 'sent' ORDER BY rp.sent_at DESC LIMIT 6)
     ${staff ? `UNION ALL
     (SELECT 'audit', au.completed_at, c.id, c.name, c.domain, au.id::text, 0, 0
        FROM audits au JOIN clients c ON c.id = au.client_id
       WHERE au.status = 'completed' ORDER BY au.completed_at DESC LIMIT 6)` : ''}
     ORDER BY at DESC LIMIT 8`,
  );
  return rows.map((r) => ({
    kind: r.kind as ActivityKind,
    at: r.at as string,
    clientId: r.client_id as string,
    client: r.client as string,
    title: (r.title as string | null) ?? null,
    ref: r.ref as string,
    answers: r.n1 as number,
    mentioned: r.n2 as number,
  }));
}
