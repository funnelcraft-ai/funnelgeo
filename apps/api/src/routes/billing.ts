import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyUsage, costReport } from '../billing/costs.js';
import { ownerPool, withTenant } from '../db.js';
import { AGENCY_STAFF, HttpError, notFound, parse, requireRole, scope } from '../http.js';

const month = z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/);
const provider = z.string().regex(/^[a-z0-9_]{2,30}$/);
const money = z.number().min(0).max(1_000_000);

/**
 * Credits for agencies, real costs for the super admin. An agency sees its
 * own credits only; costs, prices and invoices never leave the super admin's
 * screens.
 */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };
  const owner = { preHandler: requireRole('agency_owner') };
  const admin = { preHandler: requireRole('super_admin') };

  // Agencies ------------------------------------------------------------------

  app.get('/v1/usage', staff, async (req) => {
    const ctx = scope(req);
    return withTenant(ctx, (db) => agencyUsage(db, ctx.agencyId));
  });

  /** Lets the agency go past its allowance this month and after, up to a cap. Owners only. */
  app.patch('/v1/usage/topup', owner, async (req) => {
    const body = parse(z.object({ enabled: z.boolean(), limit: z.number().int().min(0).max(10_000_000) }).strict(), req.body);
    if (body.enabled && body.limit === 0) throw new HttpError(400, 'invalid_input', 'Set how many extra credits top-up may use each month.');
    const ctx = scope(req);
    return withTenant(ctx, async (db) => {
      await db.query(`UPDATE agencies SET topup_enabled = $1, topup_limit = $2 WHERE id = app_agency_id()`, [body.enabled, body.limit]);
      return agencyUsage(db, ctx.agencyId);
    });
  });

  // Super admin ---------------------------------------------------------------

  app.get('/v1/admin/costs', admin, async (req) => {
    const { month: m } = parse(z.object({ month: month.default(new Date().toISOString().slice(0, 7)) }), req.query);
    return costReport(m);
  });

  /** What a provider billed for a month, typed in from the invoice. */
  app.put('/v1/admin/invoices/:provider/:month', admin, async (req) => {
    const params = parse(z.object({ provider, month }), req.params);
    const body = parse(z.object({ amountUsd: money, note: z.string().trim().max(300).nullish() }).strict(), req.body);
    await ownerPool.query(
      `INSERT INTO provider_invoices (provider, month, amount_usd, note, entered_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, month) DO UPDATE SET amount_usd = EXCLUDED.amount_usd, note = EXCLUDED.note, entered_by = EXCLUDED.entered_by, entered_at = now()`,
      [params.provider, `${params.month}-01`, body.amountUsd, body.note ?? null, req.user!.id],
    );
    return { ok: true };
  });

  app.delete('/v1/admin/invoices/:provider/:month', admin, async (req) => {
    const params = parse(z.object({ provider, month }), req.params);
    await ownerPool.query(`DELETE FROM provider_invoices WHERE provider = $1 AND month = $2`, [params.provider, `${params.month}-01`]);
    return { ok: true };
  });

  /** A model's prices, from the provider's price page. model '*' covers the provider's other models. */
  app.put('/v1/admin/prices', admin, async (req) => {
    const body = parse(
      z.object({ provider, model: z.string().trim().min(1).max(120), inputPerMTok: money, outputPerMTok: money, perRequest: money }).strict(),
      req.body,
    );
    if (body.provider === 'mock') throw new HttpError(400, 'invalid_input', 'Stand-in answers are always free.');
    await ownerPool.query(
      `INSERT INTO model_prices (provider, model, input_per_mtok, output_per_mtok, per_request, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
         per_request = EXCLUDED.per_request, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [body.provider, body.model, body.inputPerMTok, body.outputPerMTok, body.perRequest, req.user!.id],
    );
    return { ok: true };
  });

  app.delete('/v1/admin/prices/:provider/:model', admin, async (req) => {
    const params = parse(z.object({ provider, model: z.string().min(1).max(120) }), req.params);
    if (params.provider === 'crawl' || params.provider === 'mock') throw new HttpError(400, 'invalid_input', 'This price is built in.');
    await ownerPool.query(`DELETE FROM model_prices WHERE provider = $1 AND model = $2`, [params.provider, params.model]);
    return { ok: true };
  });

  // Plans -----------------------------------------------------------------------

  const planFields = z.object({
    name: z.string().trim().min(2).max(60),
    monthlyCredits: z.number().int().min(0).max(100_000_000),
    clientLimit: z.number().int().min(1).max(10_000),
    promptsPerClient: z.number().int().min(1).max(500),
    samplesPerPrompt: z.number().int().min(1).max(10),
    auditsPerMonth: z.number().int().min(0).max(100_000),
    price: z.object({ amount: z.number().min(0).max(10_000_000), currency: z.enum(['INR', 'USD']) }).nullable(),
    active: z.boolean(),
  });
  const presentPlan = (p: any) => ({
    key: p.key,
    name: p.name,
    monthlyCredits: p.monthly_credits,
    clientLimit: p.client_limit,
    promptsPerClient: p.prompts_per_client,
    samplesPerPrompt: p.samples_per_prompt,
    auditsPerMonth: p.audits_per_month,
    price: p.price_cents === null ? null : { amount: p.price_cents / 100, currency: p.currency },
    active: p.active,
    agencies: Number(p.agencies ?? 0),
  });

  app.get('/v1/admin/plans/all', admin, async () => {
    const { rows } = await ownerPool.query(
      `SELECT p.*, (SELECT count(*) FROM agencies a WHERE a.plan_id = p.id) AS agencies FROM plans p ORDER BY p.monthly_credits, p.created_at`,
    );
    return { plans: rows.map(presentPlan) };
  });

  app.post('/v1/admin/plans', admin, async (req, reply) => {
    const body = parse(planFields.extend({ key: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/) }).strict(), req.body);
    try {
      const { rows } = await ownerPool.query(
        `INSERT INTO plans (key, name, monthly_credits, client_limit, prompts_per_client, samples_per_prompt, audits_per_month, price_cents, currency, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [body.key, body.name, body.monthlyCredits, body.clientLimit, body.promptsPerClient, body.samplesPerPrompt, body.auditsPerMonth,
          body.price ? Math.round(body.price.amount * 100) : null, body.price?.currency ?? null, body.active],
      );
      reply.code(201);
      return { plan: presentPlan(rows[0]) };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', 'A plan with that key exists.');
      throw err;
    }
  });

  /** Changes take effect at once for every agency on the plan, this month included. */
  app.patch('/v1/admin/plans/:key/details', admin, async (req) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(40) }), req.params);
    const body = parse(planFields.partial().strict(), req.body);
    const sets: string[] = [];
    const values: unknown[] = [key];
    const put = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.name !== undefined) put('name', body.name);
    if (body.monthlyCredits !== undefined) put('monthly_credits', body.monthlyCredits);
    if (body.clientLimit !== undefined) put('client_limit', body.clientLimit);
    if (body.promptsPerClient !== undefined) put('prompts_per_client', body.promptsPerClient);
    if (body.samplesPerPrompt !== undefined) put('samples_per_prompt', body.samplesPerPrompt);
    if (body.auditsPerMonth !== undefined) put('audits_per_month', body.auditsPerMonth);
    if (body.price !== undefined) {
      put('price_cents', body.price ? Math.round(body.price.amount * 100) : null);
      put('currency', body.price?.currency ?? null);
    }
    if (body.active !== undefined) {
      if (!body.active) {
        const { rows } = await ownerPool.query(`SELECT count(*)::int AS n FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE p.key = $1`, [key]);
        if (rows[0].n > 0) throw new HttpError(409, 'in_use', `${rows[0].n} ${rows[0].n === 1 ? 'agency is' : 'agencies are'} on this plan. Move them first.`);
      }
      put('active', body.active);
    }
    if (!sets.length) throw new HttpError(400, 'invalid_input', 'Nothing to update');
    const { rows } = await ownerPool.query(`UPDATE plans SET ${sets.join(', ')} WHERE key = $1 RETURNING *, (SELECT count(*) FROM agencies a WHERE a.plan_id = plans.id) AS agencies`, values);
    if (!rows[0]) throw notFound('Plan not found');
    return { plan: presentPlan(rows[0]) };
  });
}
