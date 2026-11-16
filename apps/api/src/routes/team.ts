import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, originFor } from '../config.js';
import { withSystem, withTenant } from '../db.js';
import {
  AGENCY_STAFF,
  HttpError,
  agencyOf,
  notFound,
  parse,
  requireRole,
  scope,
  startSession,
  toSessionUser,
  uuidParam,
} from '../http.js';
import { brandFor, inviteEmail } from '../emails.js';
import type { Mailer } from '../mailer.js';
import { hashPassword, hashToken, newToken } from '../security.js';
import { emailSchema, nameSchema, passwordSchema } from './auth.js';

const INVITE_TTL_DAYS = 7;

const inviteSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('agency_member'), email: emailSchema }),
  z.object({ role: z.literal('client_viewer'), email: emailSchema, clientId: z.string().uuid() }),
]);

const acceptSchema = z.object({ token: z.string().min(20).max(200), name: nameSchema, password: passwordSchema });

export async function teamRoutes(app: FastifyInstance, opts: { mailer: Mailer }): Promise<void> {
  app.get('/v1/team', { preHandler: requireRole(...AGENCY_STAFF) }, async (req) =>
    withTenant(scope(req), async (db) => {
      const users = await db.query(
        `SELECT u.id, u.name, u.email, u.role, u.client_id, c.name AS client_name, u.last_login_at
           FROM users u LEFT JOIN clients c ON c.id = u.client_id
          ORDER BY u.created_at`,
      );
      const invites = await db.query(
        `SELECT i.id, i.email, i.role, i.client_id, c.name AS client_name, i.expires_at
           FROM invites i LEFT JOIN clients c ON c.id = i.client_id
          WHERE i.accepted_at IS NULL AND i.expires_at > now()
          ORDER BY i.created_at DESC`,
      );
      return {
        users: users.rows.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          clientId: u.client_id,
          clientName: u.client_name,
          lastLoginAt: u.last_login_at,
        })),
        invites: invites.rows.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          clientId: i.client_id,
          clientName: i.client_name,
          expiresAt: i.expires_at,
        })),
      };
    }),
  );

  /**
   * Creates an invite, emails it, and returns its link as well, so the owner
   * can still share it by hand if the email does not arrive.
   */
  app.post('/v1/team/invites', { preHandler: requireRole('agency_owner') }, async (req, reply) => {
    const body = parse(inviteSchema, req.body);
    const agency = agencyOf(req);
    const token = newToken();
    let clientName: string | null = null;

    const invite = await withTenant(scope(req), async (db) => {
      const existing = await db.query(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
      if (existing.rows.length > 0) throw new HttpError(409, 'already_member', 'That person already has access');

      const clientId = body.role === 'client_viewer' ? body.clientId : null;
      if (clientId) {
        const client = await db.query(`SELECT name FROM clients WHERE id = $1`, [clientId]);
        if (client.rows.length === 0) throw notFound('Client not found');
        clientName = client.rows[0].name;
      }

      await db.query(`DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL`, [body.email]);
      const { rows } = await db.query(
        `INSERT INTO invites (agency_id, email, role, client_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
         RETURNING id, email, role, client_id, expires_at`,
        [agency.id, body.email, body.role, clientId, hashToken(token), req.user!.id, INVITE_TTL_DAYS],
      );
      return rows[0];
    });

    const inviteUrl = `${originFor(agencyHost(agency))}/invite/${token}`;
    let emailed = false;
    if (opts.mailer.enabled) {
      try {
        await opts.mailer.send(inviteEmail(brandFor(req.tenant), { to: invite.email, inviterName: req.user!.name, clientName, url: inviteUrl }));
        emailed = true;
      } catch (err) {
        // The invite still exists; the owner is told to share the link instead.
        req.log.error({ err }, 'invite email failed');
      }
    } else {
      await opts.mailer.send(inviteEmail(brandFor(req.tenant), { to: invite.email, inviterName: req.user!.name, clientName, url: inviteUrl }));
    }

    reply.code(201);
    return {
      invite: { id: invite.id, email: invite.email, role: invite.role, clientId: invite.client_id, expiresAt: invite.expires_at },
      inviteUrl,
      emailed,
    };
  });

  app.delete('/v1/team/invites/:id', { preHandler: requireRole('agency_owner') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const deleted = await withTenant(scope(req), (db) =>
      db.query(`DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL`, [id]),
    );
    if (deleted.rowCount === 0) throw notFound('Invite not found');
    return { ok: true };
  });

  app.delete('/v1/team/users/:id', { preHandler: requireRole('agency_owner') }, async (req) => {
    const { id } = parse(uuidParam, req.params);
    if (id === req.user!.id) throw new HttpError(400, 'cannot_remove_self', 'You cannot remove yourself');
    const deleted = await withTenant(scope(req), (db) =>
      db.query(`DELETE FROM users WHERE id = $1 AND role <> 'agency_owner'`, [id]),
    );
    if (deleted.rowCount === 0) throw notFound('User not found');
    return { ok: true };
  });

  // Invite acceptance: the visitor has no session yet, so the invite is looked
  // up with the owner role, always restricted to this hostname's agency.

  app.get('/v1/invites/:token', async (req) => {
    const agency = agencyOf(req);
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.params);
    const invite = await withSystem(async (db) => {
      const { rows } = await db.query(
        `SELECT email, role FROM invites
          WHERE token_hash = $1 AND agency_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
        [hashToken(token), agency.id],
      );
      return rows[0];
    });
    if (!invite) throw notFound('This invite is no longer valid');
    return { invite: { email: invite.email, role: invite.role } };
  });

  app.post(
    '/v1/invites/accept',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const agency = agencyOf(req);
      if (agency.status === 'suspended') throw new HttpError(403, 'agency_suspended', 'This workspace is suspended');
      const body = parse(acceptSchema, req.body);
      const passwordHash = await hashPassword(body.password);

      const user = await withSystem(async (db) => {
        const { rows: invites } = await db.query(
          `SELECT id, email, role, client_id FROM invites
            WHERE token_hash = $1 AND agency_id = $2 AND accepted_at IS NULL AND expires_at > now()
            FOR UPDATE`,
          [hashToken(body.token), agency.id],
        );
        const invite = invites[0];
        if (!invite) throw notFound('This invite is no longer valid');
        const { rows } = await db.query(
          `INSERT INTO users (agency_id, client_id, email, name, password_hash, role, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           RETURNING id, agency_id, client_id, email, name, role, session_epoch`,
          [agency.id, invite.client_id, invite.email, body.name, passwordHash, invite.role],
        );
        await db.query(`UPDATE invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
        return rows[0];
      });

      await startSession(reply, { id: user.id, agencyId: agency.id, sessionEpoch: user.session_epoch });
      reply.code(201);
      return { user: toSessionUser(user) };
    },
  );
}
