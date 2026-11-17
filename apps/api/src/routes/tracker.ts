import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, type Db } from '../db.js';
import { AGENCY_STAFF, HttpError, notFound, parse, requireRole, scope, uuidParam } from '../http.js';
import { createRun, reparseRun, type TrackerDeps } from '../tracker/runs.js';
import { trendFor, visibilityFor } from '../tracker/visibility.js';

const ANYONE = ['agency_owner', 'agency_member', 'client_viewer'] as const;
export const MAX_COMPETITORS = 5;
const WEEKS_PER_MONTH = 52 / 12;

const domainField = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((value) => value.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0] ?? '')
  .refine((value) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), 'Enter a domain such as example.com');
const aliasList = z.array(z.string().trim().min(2).max(80)).max(20);

const competitorSchema = z.object({ name: z.string().trim().min(1).max(160), domain: domainField.nullable().optional(), aliases: aliasList.optional() }).strict();

const INTENTS = ['category', 'comparison', 'problem', 'brand'] as const;
const promptText = z.string().trim().min(3).max(500).transform((t) => t.replace(/\s+/g, ' '));
const promptInput = z.object({ text: promptText, intent: z.enum(INTENTS).optional(), priority: z.boolean().optional(), persona: z.string().trim().max(120).optional() }).strict();
const addPromptsSchema = z.object({ prompts: z.array(promptInput).min(1).max(50) }).strict();
// A prompt's text cannot be edited: results must always refer to the question that was asked.
const patchPromptSchema = z.object({ intent: z.enum(INTENTS), priority: z.boolean(), active: z.boolean(), persona: z.string().trim().max(120).nullable() }).partial().strict();

const presentCompetitor = (row: any) => ({ id: row.id, name: row.name, domain: row.domain, aliases: row.aliases });
const presentPrompt = (row: any) => ({ id: row.id, text: row.text, intent: row.intent, priority: row.priority, persona: row.persona, active: row.active, createdAt: row.created_at });
export const presentRun = (row: any) => ({
  id: row.id,
  trigger: row.trigger,
  status: row.status,
  engineMode: row.engine_mode,
  engineKeys: row.engine_keys,
  samples: row.samples,
  promptCount: row.prompt_count,
  totalCalls: row.total_calls,
  okCalls: row.ok_calls,
  failedCalls: row.failed_calls,
  credits: row.credits_reserved - row.credits_refunded,
  note: row.note,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

export async function clientOr404(db: Db, clientId: string) {
  const { rows } = await db.query(
    `SELECT id, name, domain, brand_aliases, status, schedule, next_run_at FROM clients WHERE id = $1`,
    [clientId],
  );
  if (!rows[0]) throw notFound('Client not found');
  return rows[0];
}

export async function trackerRoutes(app: FastifyInstance, deps: TrackerDeps): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };
  const anyone = { preHandler: requireRole(...ANYONE) };
  const isViewer = (req: FastifyRequest) => req.user!.role === 'client_viewer';

  const engineList = async (db: Db) => {
    const { rows } = await db.query(`SELECT key, label, credit_cost FROM engines WHERE active ORDER BY sort`);
    return rows.map((e) => ({ key: e.key as string, label: e.label as string, creditCost: e.credit_cost as number, available: deps.engines.available.has(e.key) }));
  };

  /** Everything the client workspace needs in one call. Client viewers get the read-only parts. */
  app.get('/v1/clients/:id/tracker', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const client = await clientOr404(db, id);
      const { rows: competitors } = await db.query(`SELECT id, name, domain, aliases FROM competitors WHERE client_id = $1 ORDER BY created_at, id`, [id]);
      const { rows: prompts } = await db.query(
        `SELECT id, text, intent, priority, persona, active, created_at FROM prompts
          WHERE client_id = $1 AND archived_at IS NULL ORDER BY priority DESC, created_at, id`,
        [id],
      );
      const { rows: runs } = await db.query(`SELECT * FROM runs WHERE client_id = $1 ORDER BY created_at DESC LIMIT 12`, [id]);
      const engines = await engineList(db);
      const base = {
        client: { id: client.id, name: client.name, domain: client.domain, brandAliases: client.brand_aliases, status: client.status, schedule: client.schedule, nextRunAt: client.next_run_at },
        competitors: competitors.map(presentCompetitor),
        prompts: prompts.map(presentPrompt),
        runs: runs.map(presentRun),
        engineMode: deps.engines.mode,
        trend: await trendFor(db, id),
      };
      if (isViewer(req)) return base;

      const { rows: plan } = await db.query(
        `SELECT p.prompts_per_client, p.samples_per_prompt, p.monthly_credits, credits_remaining(a.id) AS remaining
           FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id()`,
      );
      const usable = engines.filter((e) => e.available);
      const activePrompts = prompts.filter((p) => p.active).length;
      const samples = plan[0].samples_per_prompt as number;
      const creditsPerRun = activePrompts * samples * usable.reduce((total, e) => total + e.creditCost, 0);
      return {
        ...base,
        engines,
        limits: { prompts: plan[0].prompts_per_client as number, competitors: MAX_COMPETITORS, samples },
        estimate: { callsPerRun: activePrompts * samples * usable.length, creditsPerRun, creditsPerMonth: Math.round(creditsPerRun * WEEKS_PER_MONTH) },
        credits: { allowance: plan[0].monthly_credits as number, remaining: plan[0].remaining as number },
      };
    });
  });

  // Competitors ------------------------------------------------------------------

  app.post('/v1/clients/:id/competitors', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(competitorSchema, req.body);
    const ctx = scope(req);
    const row = await withTenant(ctx, async (db) => {
      await clientOr404(db, id);
      // Lock the client row so two requests cannot both pass the limit.
      await db.query(`SELECT 1 FROM clients WHERE id = $1 FOR UPDATE`, [id]);
      const { rows: count } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM competitors WHERE client_id = $1`, [id]);
      if (count[0]!.n >= MAX_COMPETITORS) throw new HttpError(409, 'limit_reached', `You can track up to ${MAX_COMPETITORS} competitors per client`);
      const exists = await db.query(`SELECT 1 FROM competitors WHERE client_id = $1 AND lower(name) = lower($2)`, [id, body.name]);
      if (exists.rows.length > 0) throw new HttpError(409, 'conflict', 'That competitor is already on the list');
      const { rows } = await db.query(
        `INSERT INTO competitors (agency_id, client_id, name, domain, aliases) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, domain, aliases`,
        [ctx.agencyId, id, body.name, body.domain ?? null, body.aliases ?? []],
      );
      return rows[0];
    });
    reply.code(201);
    return { competitor: presentCompetitor(row) };
  });

  app.patch('/v1/competitors/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(competitorSchema.partial(), req.body);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(
        `UPDATE competitors SET name = coalesce($2, name), domain = CASE WHEN $3 THEN $4 ELSE domain END, aliases = coalesce($5, aliases)
          WHERE id = $1 RETURNING id, name, domain, aliases`,
        [id, body.name ?? null, body.domain !== undefined, body.domain ?? null, body.aliases ?? null],
      );
      if (!rows[0]) throw notFound('Competitor not found');
      return { competitor: presentCompetitor(rows[0]) };
    });
  });

  app.delete('/v1/competitors/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const deleted = await withTenant(scope(req), (db) => db.query(`DELETE FROM competitors WHERE id = $1`, [id]));
    if (deleted.rowCount === 0) throw notFound('Competitor not found');
    return { ok: true };
  });

  // Prompts ----------------------------------------------------------------------

  /** Adds up to 50 prompts at once. Prompts already on the list are skipped, not errors. */
  app.post('/v1/clients/:id/prompts', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(addPromptsSchema, req.body);
    const ctx = scope(req);
    const result = await withTenant(ctx, async (db) => {
      await clientOr404(db, id);
      await db.query(`SELECT 1 FROM clients WHERE id = $1 FOR UPDATE`, [id]);
      const { rows: existing } = await db.query<{ text: string; active: boolean }>(
        `SELECT lower(text) AS text, active FROM prompts WHERE client_id = $1 AND archived_at IS NULL`,
        [id],
      );
      const { rows: plan } = await db.query<{ prompts_per_client: number }>(
        `SELECT p.prompts_per_client FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id()`,
      );
      const seen = new Set(existing.map((p) => p.text));
      const fresh = body.prompts.filter((p) => {
        const key = p.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const limit = plan[0]!.prompts_per_client;
      const active = existing.filter((p) => p.active).length;
      if (active + fresh.length > limit) {
        throw new HttpError(409, 'plan_limit', `Your plan tracks up to ${limit} prompts per client. You have ${active}, so you can add ${Math.max(limit - active, 0)} more.`);
      }
      const added = [];
      for (const prompt of fresh) {
        const { rows } = await db.query(
          `INSERT INTO prompts (agency_id, client_id, text, intent, priority, persona) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, text, intent, priority, persona, active, created_at`,
          [ctx.agencyId, id, prompt.text, prompt.intent ?? 'category', prompt.priority ?? false, prompt.persona || null],
        );
        added.push(presentPrompt(rows[0]));
      }
      return { added, skipped: body.prompts.length - fresh.length };
    });
    reply.code(201);
    return result;
  });

  app.patch('/v1/prompts/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(patchPromptSchema, req.body);
    return withTenant(scope(req), async (db) => {
      const { rows: current } = await db.query(`SELECT client_id, active FROM prompts WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [id]);
      if (!current[0]) throw notFound('Prompt not found');
      if (body.active === true && !current[0].active) {
        const { rows: plan } = await db.query(
          `SELECT p.prompts_per_client AS max, (SELECT count(*)::int FROM prompts WHERE client_id = $1 AND active AND archived_at IS NULL) AS n
             FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id()`,
          [current[0].client_id],
        );
        if (plan[0].n >= plan[0].max) throw new HttpError(409, 'plan_limit', `Your plan tracks up to ${plan[0].max} prompts per client.`);
      }
      const { rows } = await db.query(
        `UPDATE prompts SET intent = coalesce($2, intent), priority = coalesce($3, priority), active = coalesce($4, active),
                persona = CASE WHEN $5 THEN $6 ELSE persona END
          WHERE id = $1 RETURNING id, text, intent, priority, persona, active, created_at`,
        [id, body.intent ?? null, body.priority ?? null, body.active ?? null, body.persona !== undefined, body.persona || null],
      );
      return { prompt: presentPrompt(rows[0]) };
    });
  });

  /** Removes a prompt from the list. Its past results are kept. */
  app.delete('/v1/prompts/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const archived = await withTenant(scope(req), (db) =>
      db.query(`UPDATE prompts SET archived_at = now(), active = false WHERE id = $1 AND archived_at IS NULL`, [id]),
    );
    if (archived.rowCount === 0) throw notFound('Prompt not found');
    return { ok: true };
  });

  // Schedule ---------------------------------------------------------------------

  app.put('/v1/clients/:id/schedule', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { schedule } = parse(z.object({ schedule: z.enum(['off', 'weekly']) }).strict(), req.body);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      // Weekly: a week after the last run, or within the next minute if it has never run.
      const { rows } = await db.query(
        `UPDATE clients SET schedule = $2,
                next_run_at = CASE WHEN $2 = 'weekly' THEN greatest(now(), coalesce(
                  (SELECT max(created_at) + interval '7 days' FROM runs WHERE client_id = $1 AND status IN ('queued', 'running', 'completed')), now()))
                END
          WHERE id = $1 RETURNING schedule, next_run_at`,
        [id, schedule],
      );
      return { schedule: rows[0].schedule, nextRunAt: rows[0].next_run_at };
    });
  });

  // Runs -------------------------------------------------------------------------

  app.post('/v1/clients/:id/runs', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const run = await createRun(deps, { agencyId: scope(req).agencyId, clientId: id, trigger: 'manual', userId: req.user!.id });
    reply.code(202);
    return { run };
  });

  app.get('/v1/runs/:id', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT * FROM runs WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Run not found');
      return { run: presentRun(rows[0]) };
    });
  });

  /** Visibility for one run: the one named in ?run=, or the client's latest completed run. */
  app.get('/v1/clients/:id/visibility', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { run: wanted } = parse(z.object({ run: z.string().uuid().optional() }), req.query);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows } = wanted
        ? await db.query(`SELECT * FROM runs WHERE id = $1 AND client_id = $2`, [wanted, id])
        : await db.query(`SELECT * FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`, [id]);
      if (!rows[0]) {
        if (wanted) throw notFound('Run not found');
        return { run: null, visibility: null };
      }
      return { run: presentRun(rows[0]), visibility: await visibilityFor(db, id, rows[0].id) };
    });
  });

  /** The stored answers for one prompt in a run, with what was found in each. */
  app.get('/v1/runs/:id/answers', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { prompt } = parse(z.object({ prompt: z.string().uuid() }), req.query);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(
        `SELECT pr.id, pr.engine_key, e.label AS engine_label, pr.sample_no, pr.status, pr.answer_text, pr.error,
                coalesce((SELECT json_agg(json_build_object('name', coalesce(k.name, c.name), 'isClient', m.competitor_id IS NULL, 'position', m.position) ORDER BY m.position)
                            FROM result_mentions m LEFT JOIN competitors k ON k.id = m.competitor_id WHERE m.prompt_result_id = pr.id), '[]') AS mentions,
                coalesce((SELECT json_agg(json_build_object('url', ci.url, 'domain', ci.domain, 'isClient', ci.is_client) ORDER BY ci.position)
                            FROM citations ci WHERE ci.prompt_result_id = pr.id), '[]') AS citations
           FROM prompt_results pr JOIN engines e ON e.key = pr.engine_key JOIN clients c ON c.id = pr.client_id
          WHERE pr.run_id = $1 AND pr.prompt_id = $2
          ORDER BY e.sort, pr.sample_no`,
        [id, prompt],
      );
      return {
        answers: rows.map((r) => ({
          id: r.id, engineKey: r.engine_key, engineLabel: r.engine_label, sampleNo: r.sample_no, status: r.status,
          text: r.answer_text, error: r.error, mentions: r.mentions, citations: r.citations,
        })),
      };
    });
  });

  /** Re-reads every stored answer of a run against the client's current names, aliases and competitors. */
  app.post('/v1/runs/:id/reparse', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT status FROM runs WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Run not found');
      if (rows[0].status !== 'completed') throw new HttpError(409, 'run_not_finished', 'Only a completed run can be re-read');
      return { reparsed: await reparseRun(db, id) };
    });
  });

  // Credits ----------------------------------------------------------------------

  app.get('/v1/credits', staff, async (req) =>
    withTenant(scope(req), async (db) => {
      const { rows: plan } = await db.query(
        `SELECT p.monthly_credits, credits_remaining(a.id) AS remaining FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id()`,
      );
      const { rows: entries } = await db.query(
        `SELECT l.id, l.delta, l.reason, l.note, l.created_at, c.name AS client_name
           FROM credit_ledger l LEFT JOIN runs r ON r.id = l.run_id LEFT JOIN clients c ON c.id = r.client_id
          ORDER BY l.created_at DESC, l.id LIMIT 30`,
      );
      return {
        allowance: plan[0].monthly_credits as number,
        remaining: plan[0].remaining as number,
        entries: entries.map((e) => ({ id: e.id, delta: e.delta, reason: e.reason, note: e.note, clientName: e.client_name, createdAt: e.created_at })),
      };
    }),
  );
}
