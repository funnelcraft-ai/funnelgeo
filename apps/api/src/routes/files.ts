import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withTenant } from '../db.js';
import { HttpError, notFound, parse, requireRole, scope } from '../http.js';

export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const KINDS = { logo: 'logoUrl', favicon: 'faviconUrl' } as const;
const kindParam = z.object({ kind: z.enum(['logo', 'favicon']) });
const FILE_RE = /^(logo|favicon)-[A-Za-z0-9_-]{16}\.(png|jpg|webp)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/**
 * The file type is taken from the bytes, never from the header or name the
 * browser sent. SVG is deliberately not accepted: it can carry scripts.
 */
function sniff(bytes: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const urlFor = (agencyId: string, file: string) => `/api/v1/files/${agencyId}/${file}`;

/** Deletes the file behind a branding URL, if it is one of this agency's uploads. */
async function removeUpload(agencyId: string, url: unknown): Promise<void> {
  const prefix = urlFor(agencyId, '');
  if (typeof url !== 'string' || !url.startsWith(prefix)) return;
  const file = url.slice(prefix.length);
  if (FILE_RE.test(file)) await rm(path.join(config.uploadDir, agencyId, file), { force: true });
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Raw image bodies, capped at 1 MB.
  app.addContentTypeParser(UPLOAD_TYPES, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  /** Uploads the agency's logo or favicon and points its branding at the new file. */
  app.put('/v1/agency/branding/:kind', { preHandler: requireRole('agency_owner') }, async (req) => {
    const { kind } = parse(kindParam, req.params);
    const ext = Buffer.isBuffer(req.body) ? sniff(req.body) : null;
    if (!ext) throw new HttpError(400, 'invalid_image', 'Upload a PNG, JPEG or WebP image');

    const ctx = scope(req);
    const file = `${kind}-${randomBytes(12).toString('base64url')}.${ext}`;
    const dir = path.join(config.uploadDir, ctx.agencyId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), req.body as Buffer);

    const key = KINDS[kind];
    const previous = await withTenant(ctx, async (db) => {
      const { rows } = await db.query(`SELECT branding FROM agencies WHERE id = app_agency_id() FOR UPDATE`);
      await db.query(`UPDATE agencies SET branding = branding || $1::jsonb WHERE id = app_agency_id()`, [
        JSON.stringify({ [key]: urlFor(ctx.agencyId, file) }),
      ]);
      return rows[0]?.branding?.[key];
    });
    await removeUpload(ctx.agencyId, previous);
    return { url: urlFor(ctx.agencyId, file) };
  });

  app.delete('/v1/agency/branding/:kind', { preHandler: requireRole('agency_owner') }, async (req) => {
    const { kind } = parse(kindParam, req.params);
    const ctx = scope(req);
    const key = KINDS[kind];
    const previous = await withTenant(ctx, async (db) => {
      const { rows } = await db.query(`SELECT branding FROM agencies WHERE id = app_agency_id() FOR UPDATE`);
      await db.query(`UPDATE agencies SET branding = branding - $1 WHERE id = app_agency_id()`, [key]);
      return rows[0]?.branding?.[key];
    });
    await removeUpload(ctx.agencyId, previous);
    return { ok: true };
  });

  /**
   * Serves an uploaded logo or favicon. Public, because the sign-in page and
   * emails show it. The strict name pattern is what prevents path tricks.
   */
  app.get('/v1/files/:agencyId/:file', async (req, reply) => {
    const { agencyId, file } = parse(z.object({ agencyId: z.string().uuid(), file: z.string().regex(FILE_RE) }), req.params);
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(config.uploadDir, agencyId, file));
    } catch {
      throw notFound();
    }
    return reply
      .header('content-type', MIME[file.split('.').pop()!]!)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(bytes);
  });
}
