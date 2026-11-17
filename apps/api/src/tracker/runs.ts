import { config } from '../config.js';
import { withSystem, withTenant, type Db } from '../db.js';
import type { EngineSet, MockContext } from '../engines.js';
import { HttpError, notFound } from '../http.js';
import { parseAnswer, type Entity } from './parse.js';

/** One engine call waiting to be made: a single prompt_results row. */
export interface CallJob {
  resultId: string;
  agencyId: string;
  engineKey: string;
}

export interface CallQueue {
  enqueue(jobs: CallJob[]): Promise<void>;
}

export interface TrackerDeps {
  engines: EngineSet;
  queue: CallQueue;
}

export interface RunInput {
  agencyId: string;
  clientId: string;
  trigger: 'manual' | 'scheduled' | 'audit';
  userId: string | null;
}

export interface RunOptions {
  /** Times each prompt is asked on each engine; the plan's number when omitted. */
  samples?: number;
  /** Audits run against prospects, which ordinary runs refuse. */
  allowProspect?: boolean;
  /**
   * Runs inside the run's own transaction, after the run is created and with
   * the agency row locked. Throwing cancels the run and reserves nothing.
   */
  within?: (db: Db, runId: string) => Promise<void>;
}

/**
 * Starts a tracking run for one client: every active prompt, on every
 * available engine, the plan's number of times.
 *
 * The full cost is reserved in the ledger before anything is queued, inside
 * the same transaction that checks the balance, with the agency row locked.
 * Two runs started at once therefore cannot both spend the same credits.
 * Calls that end up failing are refunded when the run is settled.
 */
export async function createRun(deps: TrackerDeps, input: RunInput, options: RunOptions = {}): Promise<{ id: string; totalCalls: number; credits: number }> {
  const created = await withTenant({ agencyId: input.agencyId }, async (db) => {
    const { rows: plans } = await db.query<{ samples_per_prompt: number }>(
      `SELECT p.samples_per_prompt FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id() FOR UPDATE OF a`,
    );
    const samples = options.samples ?? plans[0]!.samples_per_prompt;

    const { rows: clients } = await db.query<{ status: string }>(`SELECT status FROM clients WHERE id = $1`, [input.clientId]);
    if (!clients[0]) throw notFound('Client not found');
    if (clients[0].status === 'prospect' && !options.allowProspect) {
      throw new HttpError(409, 'client_prospect', 'Convert this prospect to a client before running it');
    }
    if (clients[0].status === 'paused') throw new HttpError(409, 'client_paused', 'Activate this client before running it');

    const inFlight = await db.query(`SELECT 1 FROM runs WHERE client_id = $1 AND status IN ('queued', 'running')`, [input.clientId]);
    if (inFlight.rows.length > 0) throw new HttpError(409, 'run_in_progress', 'A run is already in progress for this client');

    const { rows: prompts } = await db.query<{ id: string }>(
      `SELECT id FROM prompts WHERE client_id = $1 AND active AND archived_at IS NULL ORDER BY created_at, id`,
      [input.clientId],
    );
    if (prompts.length === 0) throw new HttpError(400, 'no_prompts', 'Add at least one prompt before running');

    const { rows: allEngines } = await db.query<{ key: string; credit_cost: number }>(
      `SELECT key, credit_cost FROM engines WHERE active ORDER BY sort`,
    );
    const engines = allEngines.filter((e) => deps.engines.available.has(e.key));
    if (engines.length === 0) {
      throw new HttpError(409, 'no_engines', 'No answer engines are set up yet. Ask your platform administrator to add engine API keys.');
    }

    const totalCalls = prompts.length * engines.length * samples;
    const credits = prompts.length * samples * engines.reduce((sum, e) => sum + e.credit_cost, 0);
    const { rows: balance } = await db.query<{ remaining: number }>(`SELECT credits_remaining(app_agency_id()) AS remaining`);
    if (credits > balance[0]!.remaining) {
      throw new HttpError(
        402,
        'insufficient_credits',
        `This run needs ${credits} credits and ${Math.max(balance[0]!.remaining, 0)} are left this month.`,
      );
    }

    const { rows: runs } = await db.query<{ id: string }>(
      `INSERT INTO runs (agency_id, client_id, trigger, status, engine_mode, engine_keys, samples, prompt_count, total_calls, credits_reserved, created_by)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.agencyId, input.clientId, input.trigger, deps.engines.mode, engines.map((e) => e.key), samples, prompts.length, totalCalls, credits, input.userId],
    );
    const runId = runs[0]!.id;

    const { rows: results } = await db.query<{ id: string; engine_key: string }>(
      `INSERT INTO prompt_results (agency_id, client_id, run_id, prompt_id, engine_key, sample_no)
       SELECT $1, $2, $3, p.id, e.key, s
         FROM unnest($4::uuid[]) AS p(id) CROSS JOIN unnest($5::text[]) AS e(key) CROSS JOIN generate_series(1, $6::int) AS s
       RETURNING id, engine_key`,
      [input.agencyId, input.clientId, runId, prompts.map((p) => p.id), engines.map((e) => e.key), samples],
    );

    if (options.within) await options.within(db, runId);

    if (credits > 0) {
      await db.query(
        `INSERT INTO credit_ledger (agency_id, delta, reason, run_id, created_by) VALUES ($1, $2, 'run_reserved', $3, $4)`,
        [input.agencyId, -credits, runId, input.userId],
      );
    }

    return { id: runId, totalCalls, credits, jobs: results.map((r) => ({ resultId: r.id, agencyId: input.agencyId, engineKey: r.engine_key })) };
  });

  try {
    await deps.queue.enqueue(created.jobs);
  } catch (err) {
    // Nothing will ever process these calls: fail them all, which refunds the run.
    await withSystem((db) =>
      db.query(`UPDATE prompt_results SET status = 'failed', error = 'Could not be queued', completed_at = now() WHERE run_id = $1 AND status = 'pending'`, [created.id]),
    );
    await settleRun(created.id);
    throw new HttpError(503, 'queue_unavailable', 'The run could not be started. No credits were used. Try again shortly.');
  }

  // A fast worker may already have finished the run, in which case this changes nothing.
  await withSystem((db) => db.query(`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'`, [created.id]));
  return { id: created.id, totalCalls: created.totalCalls, credits: created.credits };
}

/** Rebuilds the mentions and citations of one answered result from its stored answer. */
export async function storeParse(db: Db, resultId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT pr.agency_id, pr.client_id, pr.answer_text, pr.raw_citations, c.name, c.brand_aliases, c.domain
       FROM prompt_results pr JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1 AND pr.status = 'ok'`,
    [resultId],
  );
  const row = rows[0];
  if (!row) return;

  const { rows: competitors } = await db.query(
    `SELECT id, name, aliases, domain FROM competitors WHERE client_id = $1 ORDER BY created_at, id`,
    [row.client_id],
  );
  const entities: Entity[] = [
    { competitorId: null, name: row.name, aliases: row.brand_aliases, domain: row.domain },
    ...competitors.map((c) => ({ competitorId: c.id as string, name: c.name as string, aliases: c.aliases as string[], domain: c.domain as string | null })),
  ];
  const parsed = parseAnswer(row.answer_text ?? '', row.raw_citations, entities);

  await db.query(`DELETE FROM result_mentions WHERE prompt_result_id = $1`, [resultId]);
  await db.query(`DELETE FROM citations WHERE prompt_result_id = $1`, [resultId]);
  if (parsed.mentions.length > 0) {
    await db.query(
      `INSERT INTO result_mentions (agency_id, client_id, prompt_result_id, competitor_id, position)
       SELECT $1, $2, $3, m.competitor_id, m.position FROM unnest($4::uuid[], $5::int[]) AS m(competitor_id, position)`,
      [row.agency_id, row.client_id, resultId, parsed.mentions.map((m) => m.competitorId), parsed.mentions.map((m) => m.position)],
    );
  }
  if (parsed.citations.length > 0) {
    await db.query(
      `INSERT INTO citations (agency_id, client_id, prompt_result_id, position, url, domain, is_client)
       SELECT $1, $2, $3, c.position, c.url, c.domain, c.is_client
         FROM unnest($4::int[], $5::text[], $6::text[], $7::bool[]) AS c(position, url, domain, is_client)`,
      [
        row.agency_id,
        row.client_id,
        resultId,
        parsed.citations.map((c) => c.position),
        parsed.citations.map((c) => c.url),
        parsed.citations.map((c) => c.domain),
        parsed.citations.map((c) => c.isClient),
      ],
    );
  }
  await db.query(`UPDATE prompt_results SET parsed_at = now() WHERE id = $1`, [resultId]);
}

/**
 * Brings a run's counters in line with its results and, once no call is
 * pending, closes it and refunds the failed calls. Counts are always taken
 * from the result rows, so calling this twice, or after a retried job, never
 * double-counts or double-refunds. Runs as the platform because refunds add
 * credits, which a tenant request is not allowed to do.
 */
/**
 * Updates a run's counts and closes it once no call is pending. Returns
 * 'completed' or 'failed' only to the one caller that closed it, so follow-up
 * work is started exactly once.
 */
export async function settleRun(runId: string): Promise<'completed' | 'failed' | null> {
  return withSystem(async (db) => {
    const { rows: runs } = await db.query(
      `SELECT r.id, r.agency_id, r.client_id, r.status, r.credits_reserved, r.credits_refunded, c.status AS client_status
         FROM runs r JOIN clients c ON c.id = r.client_id WHERE r.id = $1 FOR UPDATE OF r`,
      [runId],
    );
    const run = runs[0];
    if (!run) return null;

    const { rows: counts } = await db.query(
      `SELECT count(*) FILTER (WHERE pr.status = 'ok')::int AS ok,
              count(*) FILTER (WHERE pr.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE pr.status = 'pending')::int AS pending,
              coalesce(sum(e.credit_cost) FILTER (WHERE pr.status = 'failed'), 0)::int AS failed_cost
         FROM prompt_results pr JOIN engines e ON e.key = pr.engine_key
        WHERE pr.run_id = $1`,
      [runId],
    );
    const c = counts[0]!;
    await db.query(`UPDATE runs SET ok_calls = $2, failed_calls = $3 WHERE id = $1`, [runId, c.ok, c.failed]);

    if (c.pending > 0 || !['queued', 'running'].includes(run.status)) return null;

    const owed = Math.min(c.failed_cost, run.credits_reserved) - run.credits_refunded;
    if (owed > 0) {
      await db.query(
        `INSERT INTO credit_ledger (agency_id, delta, reason, run_id, note) VALUES ($1, $2, 'run_refund', $3, $4)`,
        [run.agency_id, owed, runId, `${c.failed} failed ${c.failed === 1 ? 'call' : 'calls'}`],
      );
    }
    await db.query(
      `UPDATE runs SET status = $2, finished_at = now(), started_at = coalesce(started_at, created_at),
              credits_refunded = credits_refunded + $3,
              note = CASE WHEN $4::int > 0 THEN $4::int || ' of ' || total_calls || ' calls failed and were refunded' ELSE note END
        WHERE id = $1`,
      [runId, c.ok > 0 ? 'completed' : 'failed', Math.max(owed, 0), c.failed],
    );
    // A tracked client's completed run gets a diagnosis follow-up. Prospects get the audit's instead.
    if (c.ok > 0 && run.client_status !== 'prospect') {
      await db.query(`INSERT INTO diagnoses (run_id, agency_id, client_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [runId, run.agency_id, run.client_id]);
    }
    return c.ok > 0 ? 'completed' : 'failed';
  });
}

/**
 * Makes one engine call and stores the answer. Safe to run more than once for
 * the same result: only a still-pending row is ever written.
 */
export async function processCall(
  engines: EngineSet,
  job: CallJob,
  attempt: { number: number; max: number },
  onSettled?: (runId: string, finished: 'completed' | 'failed' | null, agencyId: string) => Promise<void>,
): Promise<void> {
  const ctx = { agencyId: job.agencyId };
  const row = await withTenant(ctx, async (db) => {
    const { rows } = await db.query(
      `SELECT pr.id, pr.run_id, pr.client_id, pr.engine_key, pr.sample_no, p.text, c.name, c.domain
         FROM prompt_results pr JOIN prompts p ON p.id = pr.prompt_id JOIN clients c ON c.id = pr.client_id
        WHERE pr.id = $1 AND pr.status = 'pending'`,
      [job.resultId],
    );
    if (!rows[0]) return null;
    const { rows: competitors } = await db.query(`SELECT name, domain FROM competitors WHERE client_id = $1 ORDER BY created_at, id`, [
      rows[0].client_id,
    ]);
    return { ...rows[0], competitors } as {
      id: string; run_id: string; engine_key: string; sample_no: number; text: string; name: string; domain: string | null;
      competitors: { name: string; domain: string | null }[];
    };
  });
  if (!row) return;

  const adapter = engines.available.get(row.engine_key);
  try {
    if (!adapter) throw new Error('This engine is not configured');
    // Brand names go to the mock engine only. A real engine sees the prompt and nothing else.
    const mock: MockContext | undefined =
      engines.mode === 'mock' ? { brands: [{ name: row.name, domain: row.domain }, ...row.competitors], sampleNo: row.sample_no } : undefined;
    const started = performance.now();
    const answer = await adapter.ask(row.text, AbortSignal.timeout(config.engineTimeoutMs), mock);
    if (!answer.text.trim()) throw new Error('The engine returned an empty answer');
    const latency = Math.round(performance.now() - started);

    await withTenant(ctx, async (db) => {
      const updated = await db.query(
        `UPDATE prompt_results
            SET status = 'ok', answer_text = $2, raw_citations = $3::jsonb, tokens_in = $4, tokens_out = $5,
                provider_cost = $6, latency_ms = $7, error = NULL, completed_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [row.id, answer.text, JSON.stringify(answer.citations), answer.tokensIn, answer.tokensOut, answer.costUsd, latency],
      );
      if (updated.rowCount) await storeParse(db, row.id);
    });
  } catch (err) {
    // Hand the call back to the queue for another attempt, unless this was the last one.
    if (adapter && attempt.number < attempt.max) throw err;
    const message = String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 300);
    await withTenant(ctx, (db) =>
      db.query(`UPDATE prompt_results SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 AND status = 'pending'`, [row.id, message]),
    );
  }
  const finished = await settleRun(row.run_id);
  if (onSettled) await onSettled(row.run_id, finished, job.agencyId);
}

/** Re-parses every answered result of a run with the client's current names, aliases and competitors. */
export async function reparseRun(db: Db, runId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM prompt_results WHERE run_id = $1 AND status = 'ok' ORDER BY id`, [runId]);
  for (const row of rows) await storeParse(db, row.id);
  return rows.length;
}
