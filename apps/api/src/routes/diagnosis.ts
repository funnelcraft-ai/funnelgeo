import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import type { TaskQueue } from '../audits/pipeline.js';
import { diagnosisFor } from '../diagnosis/diagnose.js';
import { SOURCE_LABEL, THIRD_PARTY_TYPES } from '../diagnosis/sources.js';
import { AGENCY_STAFF, HttpError, notFound, parse, requireRole, scope, uuidParam } from '../http.js';
import { domainOf } from '../tracker/parse.js';
import { clientOr404, presentRun } from './tracker.js';

/**
 * Diagnosis is the agency's working view, so every route here is for agency
 * staff only; client viewers see results through reports instead.
 */
export async function diagnosisRoutes(app: FastifyInstance, opts: { tasks: TaskQueue; siteMode: 'live' | 'mock' }): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };

  app.get('/v1/clients/:id/diagnosis', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { run: wanted } = parse(z.object({ run: z.string().uuid().optional() }), req.query);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows } = wanted
        ? await db.query(`SELECT * FROM runs WHERE id = $1 AND client_id = $2 AND status = 'completed'`, [wanted, id])
        : await db.query(`SELECT * FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`, [id]);
      if (!rows[0]) {
        if (wanted) throw notFound('Completed run not found');
        return { run: null, diagnosis: null, sourceTypes: sourceTypes() };
      }
      return { run: presentRun(rows[0]), diagnosis: await diagnosisFor(db, id, rows[0].id), sourceTypes: sourceTypes() };
    });
  });

  /** Corrects the type of a cited site, for every client of the agency. */
  app.put('/v1/source-types/:domain', staff, async (req) => {
    const domain = domainParam(req.params);
    const { type } = parse(z.object({ type: z.enum(THIRD_PARTY_TYPES as [string, ...string[]]) }).strict(), req.body);
    await withTenant(scope(req), (db) =>
      db.query(
        `INSERT INTO source_overrides (agency_id, domain, source_type, created_by) VALUES (app_agency_id(), $1, $2, $3)
         ON CONFLICT (agency_id, domain) DO UPDATE SET source_type = EXCLUDED.source_type, created_by = EXCLUDED.created_by, created_at = now()`,
        [domain, type, req.user!.id],
      ),
    );
    return { domain, type };
  });

  /** Goes back to the built-in rules for a site. */
  app.delete('/v1/source-types/:domain', staff, async (req) => {
    const domain = domainParam(req.params);
    await withTenant(scope(req), (db) => db.query(`DELETE FROM source_overrides WHERE domain = $1`, [domain]));
    return { domain };
  });

  /** Checks the client's website again now, instead of waiting for the weekly check after a run. */
  app.post('/v1/clients/:id/site-check', { ...staff, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const ctx = scope(req);
    const siteAuditId = await withTenant(ctx, async (db) => {
      const client = await clientOr404(db, id);
      if (!client.domain) throw new HttpError(409, 'no_domain', 'Add the client’s website address first, under Brands.');
      const { rows: pending } = await db.query(`SELECT 1 FROM site_audits WHERE client_id = $1 AND status = 'pending' AND created_at > now() - interval '15 minutes'`, [id]);
      if (pending.length > 0) throw new HttpError(409, 'already_checking', 'A check of this website is already running.');
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO site_audits (agency_id, client_id, domain, mode) VALUES (app_agency_id(), $1, $2, $3) RETURNING id`,
        [id, client.domain, opts.siteMode],
      );
      return rows[0]!.id;
    });
    try {
      await opts.tasks.siteAudit(siteAuditId, ctx.agencyId);
    } catch {
      await withTenant(ctx, (db) => db.query(`UPDATE site_audits SET status = 'failed', error = 'Could not be queued', finished_at = now() WHERE id = $1`, [siteAuditId]));
      throw new HttpError(503, 'queue_unavailable', 'The check could not be started. Try again in a minute.');
    }
    reply.code(202);
    return { siteCheck: { id: siteAuditId, status: 'pending' } };
  });

  /** Status of one website check, for the screen to follow while it runs. */
  app.get('/v1/site-checks/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT id, status, error, finished_at FROM site_audits WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Check not found');
      return { siteCheck: { id: rows[0].id, status: rows[0].status, error: rows[0].error, finishedAt: rows[0].finished_at } };
    });
  });
}

const sourceTypes = () => THIRD_PARTY_TYPES.map((type) => ({ type, label: SOURCE_LABEL[type] }));

function domainParam(params: unknown): string {
  const { domain } = parse(z.object({ domain: z.string().min(1).max(253) }), params);
  const clean = domainOf(`https://${domain.trim().toLowerCase()}/`);
  if (!clean || !/^[a-z0-9.-]{1,253}$/.test(clean)) throw new HttpError(400, 'invalid_input', 'Enter a site such as reddit.com');
  return clean;
}
