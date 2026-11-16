import { withSystem } from './db.js';
import { HttpError } from './http.js';
import { createRun, settleRun, type TrackerDeps } from './tracker/runs.js';

const STUCK_AFTER_MINUTES = 120;

/**
 * Starts the weekly runs that are due. Each due client is claimed and moved
 * a week ahead in one transaction, so several workers ticking at once never
 * start the same run twice, and a failed start does not retry every minute.
 * A run that cannot start (no credits, no prompts) is recorded as skipped,
 * so the agency can see why nothing ran.
 */
export async function runDueSchedules(deps: TrackerDeps): Promise<{ started: number; skipped: number }> {
  const due = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; agency_id: string }>(
      `SELECT c.id, c.agency_id
         FROM clients c JOIN agencies a ON a.id = c.agency_id
        WHERE c.schedule = 'weekly' AND c.status = 'active' AND c.next_run_at <= now() AND a.status = 'active'
        ORDER BY c.next_run_at
        LIMIT 25
        FOR UPDATE OF c SKIP LOCKED`,
    );
    if (rows.length > 0) {
      await db.query(`UPDATE clients SET next_run_at = now() + interval '7 days' WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    }
    return rows;
  });

  let started = 0;
  let skipped = 0;
  for (const client of due) {
    try {
      await createRun(deps, { agencyId: client.agency_id, clientId: client.id, trigger: 'scheduled', userId: null });
      started++;
    } catch (err) {
      skipped++;
      const note = err instanceof HttpError ? err.message : 'The run could not be started';
      await withSystem((db) =>
        db.query(
          `INSERT INTO runs (agency_id, client_id, trigger, status, engine_mode, note, finished_at)
           VALUES ($1, $2, 'scheduled', 'skipped', $3, $4, now())`,
          [client.agency_id, client.id, deps.engines.mode, note],
        ),
      );
    }
  }
  return { started, skipped };
}

/**
 * Closes runs whose calls were lost (for example if the queue's data was
 * wiped): after two hours any call still pending is failed and refunded.
 */
export async function closeStuckRuns(): Promise<number> {
  const stuck = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM runs WHERE status IN ('queued', 'running') AND created_at < now() - make_interval(mins => $1)`,
      [STUCK_AFTER_MINUTES],
    );
    if (rows.length > 0) {
      await db.query(
        `UPDATE prompt_results SET status = 'failed', error = 'Timed out waiting to be processed', completed_at = now()
          WHERE run_id = ANY($1::uuid[]) AND status = 'pending'`,
        [rows.map((r) => r.id)],
      );
    }
    return rows;
  });
  for (const run of stuck) await settleRun(run.id);
  return stuck.length;
}

export function startScheduler(deps: TrackerDeps, onError: (err: unknown) => void, everyMs = 60_000): { stop(): void } {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueSchedules(deps);
      await closeStuckRuns();
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  void tick();
  return { stop: () => clearInterval(timer) };
}
