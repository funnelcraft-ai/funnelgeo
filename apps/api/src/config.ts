import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const platformDomain = (process.env.PLATFORM_DOMAIN ?? 'localhost').toLowerCase();
const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: required('DATABASE_URL'),
  databaseOwnerUrl: required('DATABASE_OWNER_URL'),
  sessionSecret,
  /** When set, the forwarded hostname is trusted only from callers that send this secret. */
  internalProxySecret: process.env.INTERNAL_PROXY_SECRET ?? '',
  rateLimitAuthPerMinute: Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? 20),
  platformDomain,
  platformName: process.env.PLATFORM_NAME ?? 'FunnelGeo',
  cnameTarget: (process.env.CNAME_TARGET ?? `domains.${platformDomain}`).toLowerCase(),
  publicScheme: process.env.PUBLIC_SCHEME ?? 'http',
  publicPort: process.env.PUBLIC_PORT ?? '',
  /** SMTP connection URL, e.g. smtps://user:pass@smtp.example.com:465. Unset: emails are logged, not sent. */
  smtpUrl: process.env.SMTP_URL ?? '',
  /** Address every email is sent from. The display name is the agency's. */
  mailFrom: process.env.MAIL_FROM ?? `no-reply@${platformDomain}`,
  /** Where uploaded logos and favicons are stored. */
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? 'data/uploads'),
  secureCookies: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
};

/** Public origin for a hostname, e.g. https://acme.example.com or http://acme.localhost:3000 */
export function originFor(hostname: string): string {
  const port = config.publicPort ? `:${config.publicPort}` : '';
  return `${config.publicScheme}://${hostname}${port}`;
}

export function agencyHost(agency: { slug: string; custom_domain: string | null; domain_status: string }): string {
  if (agency.custom_domain && agency.domain_status === 'verified') return agency.custom_domain;
  return `${agency.slug}.${config.platformDomain}`;
}
