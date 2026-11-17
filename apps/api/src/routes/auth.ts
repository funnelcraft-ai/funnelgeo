import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, config, originFor } from '../config.js';
import { ownerPool, withSystem, withTenant } from '../db.js';
import {
  HttpError,
  agencyOf,
  endSession,
  notFound,
  parse,
  requireRole,
  startSession,
  toSessionUser,
} from '../http.js';
import { brandFor, resetEmail } from '../emails.js';
import type { Mailer } from '../mailer.js';
import { dummyHash, hashPassword, hashToken, newToken, signToken, verifyPassword, verifyToken } from '../security.js';
import { RESERVED_SLUGS, slugify } from '../tenant.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);
export const nameSchema = z.string().trim().min(1).max(120);

const signupSchema = z.object({
  agencyName: z.string().trim().min(2).max(120),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

const RESET_TTL_MINUTES = 60;

interface ResetRow {
  id: string;
  user_id: string;
  email: string;
  session_epoch: number;
}
interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: any[] }>;
}
const tokenParam = z.object({ token: z.string().min(20).max(200) });

export async function authRoutes(app: FastifyInstance, opts: { mailer: Mailer }): Promise<void> {
  const authLimit = {
    config: { rateLimit: { max: config.rateLimitAuthPerMinute, timeWindow: '1 minute' } },
  };

  app.get('/healthz', async () => {
    await ownerPool.query('SELECT 1');
    return { ok: true };
  });

  /** What the web app needs to theme itself for this hostname. Public. */
  app.get('/v1/tenant', async (req) => {
    if (req.tenant.kind === 'platform') return { kind: 'platform', name: config.platformName };
    const agency = agencyOf(req);
    return { kind: 'agency', name: agency.name, branding: agency.branding, suspended: agency.status === 'suspended', widgetEnabled: agency.widget_enabled };
  });

  /** Creates an agency and its owner. Only on the platform's own hostname. */
  app.post('/v1/signup', authLimit, async (req, reply) => {
    if (req.tenant.kind !== 'platform') throw notFound();
    const body = parse(signupSchema, req.body);
    const passwordHash = await hashPassword(body.password);

    const created = await withSystem(async (db) => {
      // Serialise slug allocation so two signups with the same name cannot collide.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('agency_slug'))`);
      const base = slugify(body.agencyName);
      const { rows: taken } = await db.query<{ slug: string }>(
        `SELECT slug FROM agencies WHERE slug = $1 OR slug LIKE $2`,
        [base, `${base}-%`],
      );
      const used = new Set(taken.map((r) => r.slug));
      let slug = base;
      for (let n = 2; used.has(slug) || RESERVED_SLUGS.has(slug); n++) slug = `${base}-${n}`;

      const { rows: agencies } = await db.query<{ id: string; slug: string }>(
        `INSERT INTO agencies (name, slug, plan_id)
         VALUES ($1, $2, (SELECT id FROM plans WHERE key = 'starter'))
         RETURNING id, slug`,
        [body.agencyName, slug],
      );
      const agency = agencies[0]!;
      const { rows: users } = await db.query<{ id: string }>(
        `INSERT INTO users (agency_id, email, name, password_hash, role, last_login_at)
         VALUES ($1, $2, $3, $4, 'agency_owner', now()) RETURNING id`,
        [agency.id, body.email, body.name, passwordHash],
      );
      return { agency, userId: users[0]!.id };
    });

    // The session cookie has to be set on the workspace's own hostname, so the
    // browser is sent there with a one-minute hand-off token.
    const handoff = await signToken({ sub: created.userId, aid: created.agency.id, typ: 'handoff', ep: 0 });
    const host = `${created.agency.slug}.${config.platformDomain}`;
    reply.code(201);
    return {
      slug: created.agency.slug,
      workspaceUrl: `${originFor(host)}/auth/handoff?token=${encodeURIComponent(handoff)}`,
    };
  });

  app.post('/v1/auth/handoff', authLimit, async (req, reply) => {
    const agency = agencyOf(req);
    const { token } = parse(z.object({ token: z.string().min(1) }), req.body);
    const payload = await verifyToken(token, 'handoff');
    if (!payload || payload.aid !== agency.id) throw new HttpError(401, 'invalid_token', 'This link has expired. Sign in instead.');
    const user = await withTenant({ agencyId: agency.id }, async (db) => {
      const { rows } = await db.query(`SELECT id, agency_id, client_id, email, name, role, session_epoch FROM users WHERE id = $1`, [payload.sub]);
      return rows[0];
    });
    if (!user) throw new HttpError(401, 'invalid_token', 'This link has expired. Sign in instead.');
    await startSession(reply, { id: user.id, agencyId: agency.id, sessionEpoch: user.session_epoch });
    return { user: toSessionUser(user) };
  });

  /**
   * Signs in on whichever hostname the request arrived at: agency users on
   * their workspace, super admins on the platform host.
   */
  app.post('/v1/auth/login', authLimit, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    let agencyId: string | null = null;
    if (req.tenant.kind === 'agency') {
      if (req.tenant.agency.status === 'suspended') {
        throw new HttpError(403, 'agency_suspended', 'This workspace is suspended');
      }
      agencyId = req.tenant.agency.id;
    } else if (req.tenant.kind !== 'platform') {
      throw notFound('Workspace not found');
    }

    const { rows } = await ownerPool.query(
      `SELECT id, agency_id, client_id, email, name, role, password_hash, session_epoch
         FROM users
        WHERE email = $1 AND agency_id IS NOT DISTINCT FROM $2::uuid`,
      [body.email, agencyId],
    );
    const row = rows[0];
    const ok = await verifyPassword(body.password, row?.password_hash ?? dummyHash);
    if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

    await ownerPool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
    await startSession(reply, { id: row.id, agencyId, sessionEpoch: row.session_epoch });
    return { user: toSessionUser(row) };
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    endSession(reply);
    return { ok: true };
  });

  app.get('/v1/me', { preHandler: requireRole() }, async (req) => {
    const user = req.user!;
    if (req.tenant.kind !== 'agency') return { user, agency: null };
    const agency = req.tenant.agency;
    return {
      user,
      agency: { name: agency.name, slug: agency.slug, host: agencyHost(agency) },
    };
  });

  // Password reset ---------------------------------------------------------------

  /** The agency this hostname signs users into: an agency id, or null for the platform. */
  const loginScope = (req: Parameters<typeof agencyOf>[0]): string | null => {
    if (req.tenant.kind === 'platform') return null;
    const agency = agencyOf(req);
    if (agency.status === 'suspended') throw new HttpError(403, 'agency_suspended', 'This workspace is suspended');
    return agency.id;
  };

  /**
   * Emails a reset link if the address has an account on this hostname.
   * The response is the same either way, so it cannot be used to find out
   * who has an account.
   */
  app.post('/v1/auth/forgot', authLimit, async (req) => {
    const agencyId = loginScope(req);
    const { email } = parse(z.object({ email: emailSchema }), req.body);
    const { rows } = await ownerPool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND agency_id IS NOT DISTINCT FROM $2::uuid`,
      [email, agencyId],
    );
    const user = rows[0];
    if (user) {
      const token = newToken();
      await withSystem(async (db) => {
        await db.query(`DELETE FROM password_resets WHERE user_id = $1`, [user.id]);
        await db.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + make_interval(mins => $3))`,
          [user.id, hashToken(token), RESET_TTL_MINUTES],
        );
      });
      const brand = brandFor(req.tenant);
      // Not awaited: the response must not take longer when the account exists.
      void opts.mailer
        .send(resetEmail(brand, { to: email, url: `${brand.origin}/reset/${token}` }))
        .catch((err) => req.log.error({ err }, 'reset email failed'));
    }
    return { ok: true };
  });

  const findReset = (db: Queryable, token: string, agencyId: string | null, lock = ''): Promise<{ rows: ResetRow[] }> =>
    db.query(
      `SELECT r.id, r.user_id, u.email, u.session_epoch
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()
          AND u.agency_id IS NOT DISTINCT FROM $2::uuid ${lock}`,
      [hashToken(token), agencyId],
    );

  app.get('/v1/auth/reset/:token', async (req) => {
    const agencyId = loginScope(req);
    const { token } = parse(tokenParam, req.params);
    const { rows } = await findReset(ownerPool, token, agencyId);
    if (!rows[0]) throw notFound('This link is no longer valid');
    return { email: rows[0].email };
  });

  /** Sets a new password, signs the user in and ends every other session of theirs. */
  app.post('/v1/auth/reset', authLimit, async (req, reply) => {
    const agencyId = loginScope(req);
    const body = parse(z.object({ token: tokenParam.shape.token, password: passwordSchema }), req.body);
    const passwordHash = await hashPassword(body.password);

    const user = await withSystem(async (db) => {
      const { rows } = await findReset(db, body.token, agencyId, 'FOR UPDATE OF r');
      const reset = rows[0];
      if (!reset) throw notFound('This link is no longer valid');
      await db.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [reset.id]);
      const updated = await db.query<{ id: string; session_epoch: number }>(
        `UPDATE users SET password_hash = $1, session_epoch = session_epoch + 1, last_login_at = now()
          WHERE id = $2 RETURNING id, session_epoch`,
        [passwordHash, reset.user_id],
      );
      return updated.rows[0]!;
    });

    await startSession(reply, { id: user.id, agencyId, sessionEpoch: user.session_epoch });
    return { ok: true };
  });
}
