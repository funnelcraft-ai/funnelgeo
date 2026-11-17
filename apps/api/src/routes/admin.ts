import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, originFor } from '../config.js';
import { ownerPool } from '../db.js';
import { HttpError, notFound, parse, requireRole, uuidParam } from '../http.js';

const patchSchema = z
  .object({ planKey: z.string().min(1).max(40), status: z.enum(['active', 'suspended']) })
  .partial()
  .strict();

/**
 * Super admin. requireRole('super_admin') can only succeed on the platform's
 * own hostname, because agency sessions are not accepted there and super
 * admin sessions are not accepted on agency hostnames.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('super_admin') };

  app.get('/v1/admin/agencies', guard, async () => {
    const { rows } = await ownerPool.query(
      `SELECT a.id, a.name, a.slug, a.custom_domain, a.domain_status, a.status, a.created_at,
              p.key AS plan_key, p.name AS plan_name,
              (SELECT count(*)::int FROM clients c WHERE c.agency_id = a.id AND c.status <> 'prospect') AS client_count,
              (SELECT count(*)::int FROM users u WHERE u.agency_id = a.id) AS user_count
         FROM agencies a JOIN plans p ON p.id = a.plan_id
        ORDER BY a.created_at DESC`,
    );
    return {
      agencies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        workspaceUrl: originFor(agencyHost(row)),
        customDomain: row.custom_domain,
        domainStatus: row.domain_status,
        status: row.status,
        planKey: row.plan_key,
        planName: row.plan_name,
        clientCount: row.client_count,
        userCount: row.user_count,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/v1/admin/plans', guard, async () => {
    const { rows } = await ownerPool.query(
      `SELECT key, name, monthly_credits, client_limit, samples_per_prompt, prompts_per_client, audits_per_month
         FROM plans WHERE active ORDER BY client_limit`,
    );
    return {
      plans: rows.map((row) => ({
        key: row.key,
        name: row.name,
        monthlyCredits: row.monthly_credits,
        clientLimit: row.client_limit,
        samplesPerPrompt: row.samples_per_prompt,
        promptsPerClient: row.prompts_per_client,
        auditsPerMonth: row.audits_per_month,
      })),
    };
  });

  app.patch('/v1/admin/agencies/:id', guard, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(patchSchema, req.body);
    if (body.planKey === undefined && body.status === undefined) {
      throw new HttpError(400, 'invalid_input', 'Nothing to update');
    }
    if (body.planKey !== undefined) {
      const plan = await ownerPool.query(`SELECT id FROM plans WHERE key = $1 AND active`, [body.planKey]);
      if (plan.rows.length === 0) throw new HttpError(400, 'invalid_input', 'Unknown plan');
      await ownerPool.query(`UPDATE agencies SET plan_id = $1 WHERE id = $2`, [plan.rows[0].id, id]);
    }
    if (body.status !== undefined) {
      await ownerPool.query(`UPDATE agencies SET status = $1 WHERE id = $2`, [body.status, id]);
    }
    const { rows } = await ownerPool.query(
      `SELECT a.id, a.status, p.key AS plan_key FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Agency not found');
    return { agency: { id: rows[0].id, status: rows[0].status, planKey: rows[0].plan_key } };
  });

  // Credit settings. These are the adjustable numbers behind the tracker:
  // what one call to each engine costs in credits, what each plan includes a
  // month, and one-off grants to an agency. Screens for these come with the
  // plans milestone; until then they are set through these endpoints.

  app.get('/v1/admin/engines', guard, async () => {
    const { rows } = await ownerPool.query(`SELECT key, label, credit_cost, active FROM engines ORDER BY sort`);
    return { engines: rows.map((e) => ({ key: e.key, label: e.label, creditCost: e.credit_cost, active: e.active })) };
  });

  app.patch('/v1/admin/engines/:key', guard, async (req) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(40) }), req.params);
    const body = parse(z.object({ creditCost: z.number().int().min(0).max(1000), active: z.boolean() }).partial().strict(), req.body);
    const { rows } = await ownerPool.query(
      `UPDATE engines SET credit_cost = coalesce($2, credit_cost), active = coalesce($3, active) WHERE key = $1
       RETURNING key, label, credit_cost, active`,
      [key, body.creditCost ?? null, body.active ?? null],
    );
    if (!rows[0]) throw notFound('Engine not found');
    return { engine: { key: rows[0].key, label: rows[0].label, creditCost: rows[0].credit_cost, active: rows[0].active } };
  });

  app.patch('/v1/admin/plans/:key', guard, async (req) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(40) }), req.params);
    const body = parse(z.object({ monthlyCredits: z.number().int().min(0).max(100_000_000) }).strict(), req.body);
    const { rows } = await ownerPool.query(`UPDATE plans SET monthly_credits = $2 WHERE key = $1 RETURNING key, monthly_credits`, [key, body.monthlyCredits]);
    if (!rows[0]) throw notFound('Plan not found');
    return { plan: { key: rows[0].key, monthlyCredits: rows[0].monthly_credits } };
  });

  /** Adds (or, with a negative amount, removes) credits for the current month. */
  app.post('/v1/admin/agencies/:id/credits', guard, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ amount: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0), note: z.string().trim().max(200).optional() }).strict(), req.body);
    const agency = await ownerPool.query(`SELECT 1 FROM agencies WHERE id = $1`, [id]);
    if (agency.rows.length === 0) throw notFound('Agency not found');
    await ownerPool.query(
      `INSERT INTO credit_ledger (agency_id, delta, reason, note, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, body.amount, body.amount > 0 ? 'grant' : 'adjustment', body.note ?? null, req.user!.id],
    );
    const { rows } = await ownerPool.query(`SELECT credits_remaining($1) AS remaining`, [id]);
    reply.code(201);
    return { remaining: rows[0].remaining };
  });
}
