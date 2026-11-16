import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agencyHost, config, originFor } from '../config.js';
import { ownerPool, withTenant } from '../db.js';
import { AGENCY_STAFF, HttpError, parse, requireRole, scope } from '../http.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as #1A73E8');
const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => u.startsWith('https://'), 'Must be an https:// URL');

/** null clears a field; an omitted field is left as it is. */
const brandingSchema = z
  .object({
    logoUrl: httpsUrl.nullable(),
    faviconUrl: httpsUrl.nullable(),
    primaryColor: hexColor.nullable(),
    accentColor: hexColor.nullable(),
    senderName: z.string().trim().min(1).max(80).nullable(),
  })
  .partial()
  .strict();

const patchSchema = z
  .object({ name: z.string().trim().min(2).max(120), branding: brandingSchema })
  .partial()
  .strict();

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN_RE, 'Enter a hostname such as seo.youragency.com'),
});

export type CnameResolver = (hostname: string) => Promise<string[]>;

const AGENCY_VIEW = `
  SELECT a.id, a.name, a.slug, a.custom_domain, a.domain_status, a.domain_checked_at, a.branding, a.status,
         p.key AS plan_key, p.name AS plan_name, p.client_limit, p.prompts_per_client, p.samples_per_prompt, p.audits_per_month
    FROM agencies a JOIN plans p ON p.id = a.plan_id
   WHERE a.id = app_agency_id()`;

function present(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    branding: row.branding,
    workspaceUrl: originFor(agencyHost(row)),
    defaultHost: `${row.slug}.${config.platformDomain}`,
    customDomain: row.custom_domain,
    domainStatus: row.domain_status,
    domainCheckedAt: row.domain_checked_at,
    cnameTarget: config.cnameTarget,
    plan: {
      key: row.plan_key,
      name: row.plan_name,
      clientLimit: row.client_limit,
      promptsPerClient: row.prompts_per_client,
      samplesPerPrompt: row.samples_per_prompt,
      auditsPerMonth: row.audits_per_month,
    },
  };
}

export async function agencyRoutes(app: FastifyInstance, opts: { resolveCname: CnameResolver }): Promise<void> {
  const load = (req: Parameters<typeof scope>[0]) =>
    withTenant(scope(req), async (db) => {
      const { rows } = await db.query(AGENCY_VIEW);
      return present(rows[0]);
    });

  app.get('/v1/agency', { preHandler: requireRole(...AGENCY_STAFF) }, async (req) => ({ agency: await load(req) }));

  app.patch('/v1/agency', { preHandler: requireRole('agency_owner') }, async (req) => {
    const body = parse(patchSchema, req.body);
    await withTenant(scope(req), async (db) => {
      if (body.name) await db.query(`UPDATE agencies SET name = $1 WHERE id = app_agency_id()`, [body.name]);
      if (body.branding) {
        // Merge, then drop keys that were set to null.
        await db.query(`UPDATE agencies SET branding = jsonb_strip_nulls(branding || $1::jsonb) WHERE id = app_agency_id()`, [
          JSON.stringify(body.branding),
        ]);
      }
    });
    return { agency: await load(req) };
  });

  /** Registers a custom domain. It serves the workspace only after verification. */
  app.put('/v1/agency/domain', { preHandler: requireRole('agency_owner') }, async (req) => {
    const { domain } = parse(domainSchema, req.body);
    if (domain === config.platformDomain || domain.endsWith(`.${config.platformDomain}`) || domain === config.cnameTarget) {
      throw new HttpError(400, 'invalid_input', 'Use a hostname on your own domain');
    }
    // Uniqueness spans all agencies, which the tenant-scoped role cannot see.
    const { rows: clash } = await ownerPool.query(`SELECT 1 FROM agencies WHERE custom_domain = $1 AND id <> $2`, [
      domain,
      req.user!.agencyId,
    ]);
    if (clash.length > 0) throw new HttpError(409, 'domain_taken', 'That domain is already connected to another workspace');

    await withTenant(scope(req), (db) =>
      db.query(`UPDATE agencies SET custom_domain = $1, domain_status = 'pending', domain_checked_at = NULL WHERE id = app_agency_id()`, [domain]),
    );
    return { agency: await load(req) };
  });

  /** Checks that the custom domain's CNAME points at the platform. */
  app.post('/v1/agency/domain/verify', { preHandler: requireRole('agency_owner') }, async (req) => {
    const current = await load(req);
    if (!current.customDomain) throw new HttpError(400, 'no_domain', 'Add a custom domain first');

    let verified = false;
    let detail: string;
    try {
      const targets = (await opts.resolveCname(current.customDomain)).map((t) => t.toLowerCase().replace(/\.$/, ''));
      verified = targets.includes(config.cnameTarget);
      detail = verified
        ? 'CNAME record found.'
        : `The CNAME points to ${targets.join(', ') || 'nothing'}; it should point to ${config.cnameTarget}.`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
      detail = `No CNAME record found yet (${code}). DNS changes can take up to an hour to appear.`;
    }

    await withTenant(scope(req), (db) =>
      db.query(`UPDATE agencies SET domain_status = $1, domain_checked_at = now() WHERE id = app_agency_id()`, [verified ? 'verified' : 'failed']),
    );
    return { agency: await load(req), verified, detail };
  });

  app.delete('/v1/agency/domain', { preHandler: requireRole('agency_owner') }, async (req) => {
    await withTenant(scope(req), (db) =>
      db.query(`UPDATE agencies SET custom_domain = NULL, domain_status = 'none', domain_checked_at = NULL WHERE id = app_agency_id()`),
    );
    return { agency: await load(req) };
  });

  /**
   * For the reverse proxy's on-demand TLS check: answers 200 only for
   * hostnames that should get a certificate. Keep this route off the public
   * internet.
   */
  app.get('/internal/domain-check', async (req, reply) => {
    const { domain } = parse(z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) }), req.query);
    if (domain === config.platformDomain) return { ok: true };
    const suffix = `.${config.platformDomain}`;
    const { rows } = domain.endsWith(suffix)
      ? await ownerPool.query(`SELECT 1 FROM agencies WHERE slug = $1`, [domain.slice(0, -suffix.length)])
      : await ownerPool.query(`SELECT 1 FROM agencies WHERE custom_domain = $1 AND domain_status = 'verified'`, [domain]);
    if (rows.length === 0) return reply.code(404).send({ ok: false });
    return { ok: true };
  });
}
