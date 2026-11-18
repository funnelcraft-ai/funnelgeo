import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const platformDomain = (process.env.PLATFORM_DOMAIN ?? 'localhost').toLowerCase();
const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

if (process.env.ENGINE_MODE && !['live', 'mock'].includes(process.env.ENGINE_MODE)) {
  throw new Error("ENGINE_MODE must be 'live' or 'mock'");
}
if (process.env.SITE_FETCH && !['live', 'mock'].includes(process.env.SITE_FETCH)) {
  throw new Error("SITE_FETCH must be 'live' or 'mock'");
}
if (process.env.SITE_FETCH === 'mock' && process.env.NODE_ENV === 'production') {
  throw new Error('SITE_FETCH=mock is not allowed in production: it would present a made-up website check as real');
}
if (process.env.ENGINE_MODE === 'mock' && process.env.NODE_ENV === 'production') {
  throw new Error('ENGINE_MODE=mock is not allowed in production: it would present generated answers as real');
}

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
  /** Used when no send-from address is set. The display name is always the agency's. */
  defaultMailFrom: `no-reply@${platformDomain}`,
  /** Where uploaded logos and favicons are stored. */
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? 'data/uploads'),
  /** Redis for the job queue (BullMQ). */
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  /** Namespaces queue keys, so several environments can share one Redis. */
  queuePrefix: process.env.QUEUE_PREFIX ?? 'funnelgeo',
  /**
   * 'live' calls the real answer engines. 'mock' answers with generated
   * stand-in text so the product can be exercised without API keys; it is
   * refused in production and every run made with it is labelled.
   */
  engineMode: (process.env.ENGINE_MODE ?? 'live') as 'live' | 'mock',
  /** 'live' fetches prospects' real websites; 'mock' checks a made-up site, for development without internet access. */
  siteFetch: (process.env.SITE_FETCH ?? 'live') as 'live' | 'mock',
  /** Requests one visitor may send through the website widget per hour. */
  widgetPerHour: Number(process.env.WIDGET_PER_HOUR ?? 5),
  /** Chrome or Chromium on the worker, for report PDFs. */
  chromePath: process.env.CHROME_PATH ?? '',
  /** Development only: Chrome --host-resolver-rules, so agency hostnames reach the local web app. */
  pdfHostRules: process.env.PDF_HOST_RULES ?? '',
  /** Visit collector: its port, and how many events one address may send per minute. */
  collectorPort: Number(process.env.COLLECTOR_PORT ?? 4100),
  collectorPerMinute: Number(process.env.COLLECTOR_PER_MINUTE ?? 120),
  engineTimeoutMs: Number(process.env.ENGINE_TIMEOUT_MS ?? 90_000),
  /** Calls per second allowed to each engine, across all workers. */
  engineCallsPerSecond: Number(process.env.ENGINE_CALLS_PER_SECOND ?? 2),
  /** Attempts per call before it is recorded as failed (and refunded). */
  engineAttempts: Number(process.env.ENGINE_ATTEMPTS ?? 3),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  /** Address of the Anthropic API, used when Claude is the writing model. Tests point it at a stand-in. */
  anthropicBaseUrl: process.env.WRITER_ANTHROPIC_URL ?? 'https://api.anthropic.com',
  engines: {
    chatgpt: { baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com' },
    perplexity: { baseUrl: process.env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai' },
    gemini: { baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com' },
  },
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
