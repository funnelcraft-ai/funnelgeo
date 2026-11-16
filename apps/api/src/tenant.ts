import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ownerPool } from './db.js';

export interface Agency {
  id: string;
  name: string;
  slug: string;
  custom_domain: string | null;
  domain_status: 'none' | 'pending' | 'verified' | 'failed';
  branding: Branding;
  status: 'active' | 'suspended';
  plan_id: string;
}

export interface Branding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  senderName?: string;
}

export type Tenant = { kind: 'platform' } | { kind: 'agency'; agency: Agency } | { kind: 'unknown' };

const AGENCY_COLUMNS = 'id, name, slug, custom_domain, domain_status, branding, status, plan_id';

/**
 * The hostname the visitor used. The web app forwards it in x-forwarded-host;
 * that header is honoured only when the caller proves it is our own proxy.
 */
export function requestHost(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = isTrustedProxy(req) && typeof forwarded === 'string' && forwarded ? forwarded : (req.headers.host ?? '');
  return (raw.split(',')[0] ?? '').trim().split(':')[0]!.toLowerCase();
}

export function isTrustedProxy(req: FastifyRequest): boolean {
  if (!config.internalProxySecret) return true;
  return req.headers['x-proxy-secret'] === config.internalProxySecret;
}

/** Maps a hostname to the platform itself, one agency, or nothing. */
export async function resolveTenant(host: string): Promise<Tenant> {
  if (!host) return { kind: 'unknown' };
  if (host === config.platformDomain) return { kind: 'platform' };

  const suffix = `.${config.platformDomain}`;
  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    if (slug.includes('.')) return { kind: 'unknown' };
    const { rows } = await ownerPool.query<Agency>(`SELECT ${AGENCY_COLUMNS} FROM agencies WHERE slug = $1`, [slug]);
    return rows[0] ? { kind: 'agency', agency: rows[0] } : { kind: 'unknown' };
  }

  // A custom domain serves the workspace only once its CNAME has been verified.
  const { rows } = await ownerPool.query<Agency>(
    `SELECT ${AGENCY_COLUMNS} FROM agencies WHERE custom_domain = $1 AND domain_status = 'verified'`,
    [host],
  );
  return rows[0] ? { kind: 'agency', agency: rows[0] } : { kind: 'unknown' };
}

/** Subdomains an agency may not claim. */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'domains', 'mail', 'smtp', 'ftp', 'cdn', 'static', 'assets',
  'status', 'help', 'support', 'docs', 'blog', 'login', 'signup', 'auth', 'billing', 'track', 't',
]);

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'agency';
}
