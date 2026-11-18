import type { FastifyInstance } from 'fastify';
import { withTenant } from '../db.js';
import { ANYONE, requireRole, scope } from '../http.js';
import { overviewFor } from '../overview.js';

/** The dashboard. Client viewers get the same view, limited to their own client by row-level security. */
export async function overviewRoutes(app: FastifyInstance) {
  app.get('/v1/overview', { preHandler: requireRole(...ANYONE) }, async (req) =>
    withTenant(scope(req), (db) => overviewFor(db, { staff: req.user!.role !== 'client_viewer' })),
  );
}
