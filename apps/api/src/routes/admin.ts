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
              (SELECT count(*)::int FROM clients c WHERE c.agency_id = a.id) AS client_count,
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
}
