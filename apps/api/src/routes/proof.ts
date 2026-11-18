import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, originFor } from '../config.js';
import { withTenant } from '../db.js';
import { AGENCY_STAFF, ANYONE, agencyOf, parse, requireRole, scope, uuidParam } from '../http.js';
import { sourceLabel } from '../proof/sources.js';
import { clientOr404 } from './tracker.js';

/**
 * AI visits recorded by the tracking snippet. Readable by the agency and by
 * viewers of that client; the install details are for the agency only.
 */
export async function proofRoutes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };
  const anyone = { preHandler: requireRole(...ANYONE) };

  app.get('/v1/clients/:id/visits', anyone, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { days } = parse(z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }), req.query);
    const isStaff = req.user!.role !== 'client_viewer';
    const agency = agencyOf(req);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows: clientRows } = await db.query(`SELECT domain, site_key, snippet_seen_at FROM clients WHERE id = $1`, [id]);
      const client = clientRows[0];
      const since = `now() - make_interval(days => ${days})`;

      const { rows: engines } = await db.query<{ source_engine: string; visits: number; conversions: number }>(
        `SELECT source_engine, count(*)::int AS visits, count(*) FILTER (WHERE converted)::int AS conversions
           FROM ai_visits WHERE client_id = $1 AND NOT is_test AND occurred_at > ${since}
          GROUP BY 1 ORDER BY 2 DESC`,
        [id],
      );
      const { rows: daily } = await db.query<{ day: string; visits: number }>(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(v.id)::int AS visits
           FROM generate_series(date_trunc('day', now()) - make_interval(days => $2 - 1), date_trunc('day', now()), interval '1 day') AS d(day)
           LEFT JOIN ai_visits v ON v.client_id = $1 AND NOT v.is_test AND date_trunc('day', v.occurred_at) = d.day
          GROUP BY d.day ORDER BY d.day`,
        [id, days],
      );
      const { rows: pages } = await db.query<{ landing_path: string; visits: number; conversions: number }>(
        `SELECT landing_path, count(*)::int AS visits, count(*) FILTER (WHERE converted)::int AS conversions
           FROM ai_visits WHERE client_id = $1 AND NOT is_test AND occurred_at > ${since}
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
        [id],
      );
      const { rows: sessions } = await db.query<{ n: number }>(
        `SELECT count(DISTINCT session_hash)::int AS n FROM ai_visits WHERE client_id = $1 AND NOT is_test AND occurred_at > ${since}`,
        [id],
      );
      const { rows: recent } = await db.query(
        `SELECT id, occurred_at, source_engine, via, landing_path, converted, conversion_name, is_test
           FROM ai_visits WHERE client_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
        [id],
      );

      const origin = originFor(agencyHost(agency));
      return {
        days,
        snippet: isStaff
          ? {
              tag: `<script async src="${origin}/t.js" data-site="${client.site_key}"></script>`,
              convert: `funnelgeo('convert', 'Booking')`,
              seenAt: client.snippet_seen_at as string | null,
              testUrl: client.domain ? `https://${client.domain}/?utm_source=chatgpt.com&fg_test=1` : null,
              domain: client.domain as string | null,
            }
          : null,
        totals: {
          visits: engines.reduce((s, e) => s + e.visits, 0),
          conversions: engines.reduce((s, e) => s + e.conversions, 0),
          sessions: sessions[0]?.n ?? 0,
        },
        byEngine: engines.map((e) => ({ key: e.source_engine, label: sourceLabel(e.source_engine), visits: e.visits, conversions: e.conversions })),
        byDay: daily,
        pages: pages.map((p) => ({ path: p.landing_path, visits: p.visits, conversions: p.conversions })),
        recent: recent.map((v) => ({
          id: v.id as string,
          occurredAt: v.occurred_at as string,
          engine: v.source_engine as string,
          engineLabel: sourceLabel(v.source_engine),
          via: v.via as 'referrer' | 'utm',
          path: v.landing_path as string,
          converted: v.converted as boolean,
          conversionName: v.conversion_name as string | null,
          isTest: v.is_test as boolean,
        })),
      };
    });
  });

  /** A new site key, for when the old one was copied somewhere it shouldn't be. The old snippet stops recording. */
  app.post('/v1/clients/:id/site-key', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      await db.query(`UPDATE clients SET site_key = replace(gen_random_uuid()::text, '-', ''), snippet_seen_at = NULL WHERE id = $1`, [id]);
      return { ok: true };
    });
  });
}
