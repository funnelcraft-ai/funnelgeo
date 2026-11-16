import pg from 'pg';
import { config } from './config.js';

/**
 * Two pools, two roles.
 *
 * appPool   - role geo_app. Row-level security applies. Use it for every
 *             request that acts inside one agency, always through withTenant().
 * ownerPool - owner role, bypasses row-level security. Use it only for the
 *             operations that have to cross tenants: signup, login lookup,
 *             hostname resolution, invite acceptance and super admin.
 */
export const appPool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const ownerPool = new pg.Pool({ connectionString: config.databaseOwnerUrl, max: 5 });

export type Db = pg.PoolClient;

export interface TenantContext {
  agencyId: string;
  /** Set for client viewers; narrows what the database will return to one client. */
  clientId?: string | null;
}

/** Runs fn in a transaction scoped to one agency (and optionally one client). */
export async function withTenant<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await appPool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.agency_id', $1, true), set_config('app.client_id', $2, true)`, [
      ctx.agencyId,
      ctx.clientId ?? '',
    ]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Runs fn in a transaction on the owner pool. Cross-tenant: use sparingly. */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await ownerPool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), ownerPool.end()]);
}
