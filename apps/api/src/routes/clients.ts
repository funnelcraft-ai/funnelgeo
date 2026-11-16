import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { AGENCY_STAFF, HttpError, notFound, parse, requireRole, scope, uuidParam } from '../http.js';

/** Accepts "https://www.Example.com/path" and stores "example.com". */
const domainField = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((value) => value.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0] ?? '')
  .refine((value) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), 'Enter a domain such as example.com');

const optionalText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v));

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    domain: domainField.nullable().optional(),
    brandAliases: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    vertical: optionalText(80).nullable().optional(),
    language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/).optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code').nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

const COLUMNS = 'id, name, domain, brand_aliases, vertical, language, country, status, created_at, updated_at';

function present(row: any) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    brandAliases: row.brand_aliases,
    vertical: row.vertical,
    language: row.language,
    country: row.country,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  // Every role may read; row-level security narrows a client viewer to one client.
  app.get('/v1/clients', { preHandler: requireRole('agency_owner', 'agency_member', 'client_viewer') }, async (req) =>
    withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM clients ORDER BY created_at DESC`);
      return { clients: rows.map(present) };
    }),
  );

  app.get('/v1/clients/:id', { preHandler: requireRole('agency_owner', 'agency_member', 'client_viewer') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM clients WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Client not found');
      return { client: present(rows[0]) };
    });
  });

  app.post('/v1/clients', { preHandler: requireRole(...AGENCY_STAFF) }, async (req, reply) => {
    const body = parse(createSchema, req.body);
    const ctx = scope(req);
    const client = await withTenant(ctx, async (db) => {
      // Lock the agency row so two concurrent creates cannot both pass the limit.
      const { rows: plan } = await db.query<{ client_limit: number }>(
        `SELECT p.client_limit FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id() FOR UPDATE OF a`,
      );
      const { rows: count } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM clients WHERE status = 'active'`,
      );
      if ((body.status ?? 'active') === 'active' && count[0]!.n >= plan[0]!.client_limit) {
        throw new HttpError(
          409,
          'plan_limit',
          `Your plan includes ${plan[0]!.client_limit} active clients. Pause a client or upgrade to add another.`,
        );
      }
      const { rows } = await db.query(
        `INSERT INTO clients (agency_id, name, domain, brand_aliases, vertical, language, country, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
        [
          ctx.agencyId,
          body.name,
          body.domain ?? null,
          body.brandAliases ?? [],
          body.vertical ?? null,
          body.language ?? 'en',
          body.country ?? null,
          body.status ?? 'active',
        ],
      );
      return rows[0];
    });
    reply.code(201);
    return { client: present(client) };
  });

  app.patch('/v1/clients/:id', { preHandler: requireRole(...AGENCY_STAFF) }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateSchema, req.body);
    const columns: Record<string, unknown> = {};
    if (body.name !== undefined) columns.name = body.name;
    if (body.domain !== undefined) columns.domain = body.domain;
    if (body.brandAliases !== undefined) columns.brand_aliases = body.brandAliases;
    if (body.vertical !== undefined) columns.vertical = body.vertical;
    if (body.language !== undefined) columns.language = body.language;
    if (body.country !== undefined) columns.country = body.country;
    if (body.status !== undefined) columns.status = body.status;
    const names = Object.keys(columns);
    if (names.length === 0) throw new HttpError(400, 'invalid_input', 'Nothing to update');

    return withTenant(scope(req), async (db) => {
      if (body.status === 'active') {
        const { rows: plan } = await db.query<{ client_limit: number }>(
          `SELECT p.client_limit FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = app_agency_id() FOR UPDATE OF a`,
        );
        const { rows: count } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM clients WHERE status = 'active' AND id <> $1`,
          [id],
        );
        if (count[0]!.n >= plan[0]!.client_limit) {
          throw new HttpError(409, 'plan_limit', `Your plan includes ${plan[0]!.client_limit} active clients.`);
        }
      }
      // Column names come from the fixed list above, never from the request.
      const assignments = names.map((name, i) => `${name} = $${i + 2}`).join(', ');
      const { rows } = await db.query(`UPDATE clients SET ${assignments} WHERE id = $1 RETURNING ${COLUMNS}`, [
        id,
        ...names.map((name) => columns[name]),
      ]);
      if (!rows[0]) throw notFound('Client not found');
      return { client: present(rows[0]) };
    });
  });

  app.delete('/v1/clients/:id', { preHandler: requireRole(...AGENCY_STAFF) }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const deleted = await withTenant(scope(req), (db) => db.query(`DELETE FROM clients WHERE id = $1`, [id]));
    if (deleted.rowCount === 0) throw notFound('Client not found');
    return { ok: true };
  });
}
