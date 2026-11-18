import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { withSystem } from '../db.js';
import { isTrustedProxy } from '../tenant.js';
import { detectSource, trackingScript } from './sources.js';

/**
 * The collector: the tracking script and the endpoint it posts to. It runs as
 * its own small process, so traffic on clients' websites never competes with
 * the dashboard. It always answers 204 to a post, accepted or not, so it
 * can't be used to probe which site keys exist.
 */

const event = z.object({
  s: z.string().regex(/^[a-f0-9]{32}$/),
  e: z.enum(['view', 'ping', 'convert']),
  u: z.string().max(2000),
  r: z.string().max(2000).optional().default(''),
  i: z.string().min(6).max(64),
  t: z.literal(1).optional(),
  n: z.string().max(80).optional(),
});

/** A repeat view of the same page in the same tab within this many minutes is one visit. */
const DEDUPE_MINUTES = 30;
/** A conversion counts for an AI visit in the same tab within this many hours. */
const CONVERT_HOURS = 24;

const onHost = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** The landing page without its query string, except utm_source. */
function cleanLanding(raw: string): { url: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const utm = url.searchParams.get('utm_source');
  const path = url.pathname.slice(0, 1000) || '/';
  return { url: `${url.origin}${path}${utm ? `?utm_source=${encodeURIComponent(utm.slice(0, 60))}` : ''}`, path };
}

export async function buildCollector(): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.isTest ? false : { level: 'warn' }, bodyLimit: 4096 });

  await app.register(rateLimit, {
    max: config.collectorPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const forwarded = req.headers['x-forwarded-for'];
      if (isTrustedProxy(req) && typeof forwarded === 'string' && forwarded) return (forwarded.split(',')[0] ?? '').trim() || req.ip;
      return req.ip;
    },
  });

  // sendBeacon posts text/plain; keep it a "simple" request so browsers send no preflight.
  app.addContentTypeParser(['text/plain', 'application/json'], { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, null);
    }
  });

  const script = trackingScript();
  app.get('/t.js', { config: { rateLimit: false } }, async (_req, reply) => {
    reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .header('access-control-allow-origin', '*')
      .header('x-content-type-options', 'nosniff');
    return script;
  });

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.post('/c', async (req, reply) => {
    reply.code(204).header('access-control-allow-origin', '*');
    const parsed = event.safeParse(req.body);
    if (!parsed.success) return;
    await record(parsed.data);
  });

  return app;
}

/** Stores one event, if it belongs to a tracked client's own website. */
export async function record(e: z.infer<typeof event>): Promise<'stored' | 'ignored' | 'ping' | 'converted'> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; agency_id: string; domain: string | null; status: string; snippet_seen_at: Date | null }>(
      `SELECT c.id, c.agency_id, c.domain, c.status, c.snippet_seen_at FROM clients c JOIN agencies a ON a.id = c.agency_id
        WHERE c.site_key = $1 AND a.status = 'active'`,
      [e.s],
    );
    const client = rows[0];
    // Prospects aren't tracked; and a visit must land on the client's own site.
    if (!client || client.status === 'prospect' || !client.domain) return 'ignored';
    const landing = cleanLanding(e.u);
    if (!landing || !onHost(new URL(landing.url).hostname.toLowerCase(), client.domain)) return 'ignored';

    // Any event confirms the snippet is installed. At most one write an hour.
    if (!client.snippet_seen_at || Date.now() - client.snippet_seen_at.getTime() > 3_600_000) {
      await db.query(`UPDATE clients SET snippet_seen_at = now() WHERE id = $1`, [client.id]);
    }
    if (e.e === 'ping') return 'ping';

    // Hashed with the site key, so the same browser tab can't be linked across clients.
    const session = createHash('sha256').update(`${e.s}:${e.i}`).digest('hex');

    if (e.e === 'convert') {
      const done = await db.query(
        `UPDATE ai_visits SET converted = true, conversion_name = $2, converted_at = now()
          WHERE id = (SELECT id FROM ai_visits WHERE client_id = $1 AND session_hash = $3
                         AND occurred_at > now() - make_interval(hours => $4) AND NOT converted
                       ORDER BY occurred_at DESC LIMIT 1)`,
        [client.id, e.n ?? 'Conversion', session, CONVERT_HOURS],
      );
      return done.rowCount ? 'converted' : 'ignored';
    }

    const source = detectSource(e.r, e.u);
    if (!source) return 'ignored';
    const { rows: recent } = await db.query(
      `SELECT 1 FROM ai_visits WHERE client_id = $1 AND session_hash = $2 AND landing_path = $3
          AND occurred_at > now() - make_interval(mins => $4) LIMIT 1`,
      [client.id, session, landing.path, DEDUPE_MINUTES],
    );
    if (recent.length) return 'ignored';
    await db.query(
      `INSERT INTO ai_visits (agency_id, client_id, source_engine, via, landing_url, landing_path, session_hash, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [client.agency_id, client.id, source.key, source.via, landing.url, landing.path, session, e.t === 1],
    );
    return 'stored';
  });
}

/** Visits older than 13 months are deleted, so a year-on-year view still works. */
export async function pruneVisits(): Promise<number> {
  const { rowCount } = await withSystem((db) => db.query(`DELETE FROM ai_visits WHERE occurred_at < now() - interval '13 months'`));
  return rowCount ?? 0;
}
