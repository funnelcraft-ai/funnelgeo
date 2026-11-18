import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { ownerPool, withTenant, type TenantContext } from './db.js';
import { SESSION_TTL_SECONDS, signToken, verifyToken, type Role } from './security.js';
import type { Agency, Tenant } from './tenant.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);

export interface SessionUser {
  id: string;
  agencyId: string | null;
  clientId: string | null;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
    user: SessionUser | null;
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.');
    throw new HttpError(400, 'invalid_input', field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid input'));
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.string().uuid() });

/** The agency this request's hostname belongs to, or a 404. */
export function agencyOf(req: FastifyRequest): Agency {
  if (req.tenant.kind !== 'agency') throw notFound('Workspace not found');
  return req.tenant.agency;
}

/** Database scope for the signed-in user. Client viewers are narrowed to their client. */
export function scope(req: FastifyRequest): TenantContext {
  const user = req.user;
  if (!user || !user.agencyId) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
  return { agencyId: user.agencyId, clientId: user.role === 'client_viewer' ? user.clientId : null };
}

// Sessions ---------------------------------------------------------------------

const COOKIE = 'sid';

export async function startSession(
  reply: FastifyReply,
  user: { id: string; agencyId: string | null; sessionEpoch: number },
): Promise<void> {
  const token = await signToken({ sub: user.id, aid: user.agencyId, typ: 'session', ep: user.sessionEpoch });
  // Host-only cookie: it is never sent to another agency's hostname.
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function endSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

interface UserRow {
  id: string;
  agency_id: string | null;
  client_id: string | null;
  email: string;
  name: string;
  role: Role;
  session_epoch?: number;
}

export function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, agencyId: row.agency_id, clientId: row.client_id, email: row.email, name: row.name, role: row.role };
}

/**
 * Resolves the signed-in user for this hostname. A session is valid only on
 * the host it was issued for: an agency session on its own workspace, a super
 * admin session on the platform host. The user row is re-read on every
 * request, so removing a user ends their access immediately, and so does a
 * password change (the session epoch no longer matches).
 */
async function authenticate(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const payload = await verifyToken(token, 'session');
  if (!payload) return null;
  const columns = 'id, agency_id, client_id, email, name, role, session_epoch';
  const current = (row: UserRow | undefined) => (row && row.session_epoch === payload.ep ? toSessionUser(row) : null);

  if (req.tenant.kind === 'platform') {
    if (payload.aid !== null) return null;
    const { rows } = await ownerPool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE id = $1 AND agency_id IS NULL AND role = 'super_admin'`,
      [payload.sub],
    );
    return current(rows[0]);
  }

  if (req.tenant.kind === 'agency') {
    const agency = req.tenant.agency;
    if (payload.aid !== agency.id) return null;
    if (agency.status === 'suspended') throw new HttpError(403, 'agency_suspended', 'This workspace is suspended');
    const row = await withTenant({ agencyId: agency.id }, async (db) => {
      const { rows } = await db.query<UserRow>(`SELECT ${columns} FROM users WHERE id = $1`, [payload.sub]);
      return rows[0];
    });
    return current(row);
  }

  return null;
}

/** preHandler: requires a signed-in user, optionally with one of the given roles. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = await authenticate(req);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
    if (roles.length > 0 && !roles.includes(user.role)) {
      throw new HttpError(403, 'forbidden', 'You do not have access to this');
    }
    req.user = user;
  };
}

export const AGENCY_STAFF: Role[] = ['agency_owner', 'agency_member'];
/** Everyone in an agency's workspace, client viewers included. */
export const ANYONE: Role[] = ['agency_owner', 'agency_member', 'client_viewer'];
