import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

// Passwords ------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A valid hash of a random password, used to keep login timing even when the email is unknown. */
export const dummyHash = await hashPassword(randomBytes(16).toString('hex'));

// Opaque tokens (invites) -------------------------------------------------------

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Signed tokens (sessions and the signup hand-off) -----------------------------

const key = new TextEncoder().encode(config.sessionSecret);

export type Role = 'super_admin' | 'agency_owner' | 'agency_member' | 'client_viewer';

export interface TokenPayload {
  sub: string;
  /** Agency id, or null for a super admin. */
  aid: string | null;
  typ: 'session' | 'handoff';
  /** The user's session epoch when the token was issued. */
  ep: number;
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const HANDOFF_TTL_SECONDS = 60;

export async function signToken(payload: TokenPayload): Promise<string> {
  const ttl = payload.typ === 'session' ? SESSION_TTL_SECONDS : HANDOFF_TTL_SECONDS;
  return new SignJWT({ aid: payload.aid, typ: payload.typ, ep: payload.ep })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key);
}

export async function verifyToken(token: string, typ: TokenPayload['typ']): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    if (payload.typ !== typ || typeof payload.sub !== 'string') return null;
    const aid = typeof payload.aid === 'string' ? payload.aid : null;
    const ep = typeof payload.ep === 'number' ? payload.ep : 0;
    return { sub: payload.sub, aid, typ, ep };
  } catch {
    return null;
  }
}
