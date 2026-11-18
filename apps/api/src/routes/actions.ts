import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, type Db } from '../db.js';
import { ASSET_CREDITS, ASSET_FILE, ASSET_LABEL } from '../actions/generators.js';
import { ACTION_TYPE_LABEL, generatorsFor, refreshActions, type ActionDetails, type ActionType, type AssetKind } from '../actions/rules.js';
import { failAsset, requestAsset } from '../actions/service.js';
import type { TaskQueue } from '../audits/pipeline.js';
import { diagnosisFor } from '../diagnosis/diagnose.js';
import { AGENCY_STAFF, HttpError, notFound, parse, requireRole, scope, uuidParam } from '../http.js';
import type { Writer } from '../writer.js';
import { WRITER_LABEL, resolveWriter } from '../writer.js';
import { clientOr404 } from './tracker.js';
import { comparisonFor, type Comparison } from '../proof/compare.js';

type Status = 'suggested' | 'approved' | 'in_progress' | 'done' | 'dismissed';

/** Where an action may go from each status. */
const NEXT: Record<Status, Status[]> = {
  suggested: ['approved', 'dismissed'],
  approved: ['in_progress', 'done', 'dismissed', 'suggested'],
  in_progress: ['done', 'dismissed', 'approved'],
  done: ['in_progress'],
  dismissed: ['suggested'],
};

const KINDS = ['brief', 'draft', 'faq_schema', 'llms_txt', 'robots_patch', 'outreach_email', 'listing', 'review_request'] as const;

const ACTION_SQL = `
  SELECT a.*, o.name AS owner_name, ap_user.name AS approved_by_name,
         coalesce((SELECT json_agg(json_build_object('id', p.id, 'text', p.text, 'priority', p.priority) ORDER BY p.priority DESC, p.created_at)
                     FROM action_prompts x JOIN prompts p ON p.id = x.prompt_id WHERE x.action_id = a.id), '[]') AS prompts,
         coalesce((SELECT json_agg(s ORDER BY s.kind) FROM (
                     SELECT DISTINCT ON (kind) id, kind, version, status, origin, mode, error, created_at
                       FROM assets WHERE action_id = a.id ORDER BY kind, version DESC) s), '[]') AS assets
    FROM actions a
    LEFT JOIN users o ON o.id = a.owner_user_id
    LEFT JOIN users ap_user ON ap_user.id = a.approved_by`;

function present(row: any, comparison: Comparison | null = null) {
  const details = row.details as ActionDetails;
  return {
    comparison,
    id: row.id as string,
    type: row.type as ActionType,
    typeLabel: ACTION_TYPE_LABEL[row.type as ActionType],
    title: row.title as string,
    rationale: row.rationale as string,
    impact: Number(row.impact_score),
    effort: row.effort as 'S' | 'M' | 'L',
    status: row.status as Status,
    dismissReason: row.dismiss_reason as 'member' | 'resolved' | null,
    owner: row.owner_user_id ? { id: row.owner_user_id as string, name: row.owner_name as string } : null,
    approvedBy: row.approved_by_name as string | null,
    approvedAt: row.approved_at as string | null,
    dismissedAt: row.dismissed_at as string | null,
    doneAt: row.done_at as string | null,
    doneUrl: row.done_url as string | null,
    doneNote: row.done_note as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    details: { domain: details.domain ?? null, pages: details.pages ?? [], competitors: details.competitors ?? [], url: details.url ?? null },
    prompts: row.prompts as { id: string; text: string; priority: boolean }[],
    generators: generatorsFor(row.type, details).map((kind) => ({ kind, label: ASSET_LABEL[kind], credits: ASSET_CREDITS[kind] })),
    assets: (row.assets as any[]).map((a) => ({
      id: a.id as string,
      kind: a.kind as AssetKind,
      label: ASSET_LABEL[a.kind as AssetKind],
      version: a.version as number,
      status: a.status as 'pending' | 'done' | 'failed',
      origin: a.origin as 'generated' | 'edited',
      mode: a.mode as 'live' | 'mock',
      error: a.error as string | null,
      createdAt: a.created_at as string,
    })),
  };
}

/** Finished actions carry their before and after; the rest don't need it. */
async function withComparison(db: Db, row: any) {
  if (row.status !== 'done') return present(row);
  const { rows } = await db.query(`SELECT name FROM clients WHERE id = $1`, [row.client_id]);
  return present(row, await comparisonFor(db, row, rows[0]?.name ?? 'The client'));
}

async function actionOr404(db: Db, id: string) {
  const { rows } = await db.query(`${ACTION_SQL} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw notFound('Action not found');
  return withComparison(db, rows[0]);
}

const slugify = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'asset';

/**
 * The action queue. Agency staff only: client approval of actions is a phase 2 feature.
 */
export async function actionRoutes(app: FastifyInstance, opts: { tasks: TaskQueue; writer: Writer }): Promise<void> {
  const staff = { preHandler: requireRole(...AGENCY_STAFF) };

  app.get('/v1/clients/:id/actions', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows } = await db.query(
        `${ACTION_SQL} WHERE a.client_id = $1
           AND NOT (a.status = 'dismissed' AND a.dismissed_at < now() - interval '90 days')
         ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'approved' THEN 1 WHEN 'suggested' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
                  a.impact_score DESC, a.created_at`,
        [id],
      );
      const { rows: team } = await db.query(`SELECT id, name FROM users WHERE role IN ('agency_owner', 'agency_member') ORDER BY name`);
      const { rows: credits } = await db.query<{ remaining: number }>(`SELECT credits_remaining(app_agency_id()) AS remaining`);
      const { rows: latest } = await db.query(`SELECT id FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`, [id]);
      const writer = opts.writer.mode === 'mock' ? { ready: true, problem: null, label: 'Demo writer' } : (() => {
        const w = resolveWriter();
        return { ready: !w.problem, problem: w.problem, label: `${WRITER_LABEL[w.provider]}${w.model ? ` · ${w.model}` : ''}` };
      })();
      return {
        actions: await Promise.all(rows.map((row) => withComparison(db, row))),
        team: team.map((u) => ({ id: u.id as string, name: u.name as string })),
        credits: credits[0]!.remaining,
        writer: { mode: opts.writer.mode, ...writer },
        hasRun: latest.length > 0,
      };
    });
  });

  /** Rebuilds the suggestions from the latest completed run, e.g. after correcting source types. */
  app.post('/v1/clients/:id/actions/refresh', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      await clientOr404(db, id);
      const { rows } = await db.query(`SELECT id FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`, [id]);
      if (!rows[0]) throw new HttpError(409, 'no_run', 'Suggestions come from a completed run. Run this client first.');
      return refreshActions(db, id, rows[0].id, await diagnosisFor(db, id, rows[0].id));
    });
  });

  app.patch('/v1/actions/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z
        .object({
          status: z.enum(['suggested', 'approved', 'in_progress', 'done', 'dismissed']),
          ownerUserId: z.string().uuid().nullable(),
          doneUrl: z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), 'Use a web address starting with http:// or https://').nullable(),
          doneNote: z.string().trim().max(2000).nullable(),
        })
        .partial()
        .strict(),
      req.body,
    );
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT status FROM actions WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw notFound('Action not found');
      const from = rows[0].status as Status;

      if (body.ownerUserId !== undefined) {
        if (body.ownerUserId) {
          const { rows: owner } = await db.query(`SELECT 1 FROM users WHERE id = $1 AND role IN ('agency_owner', 'agency_member')`, [body.ownerUserId]);
          if (!owner.length) throw new HttpError(400, 'invalid_input', 'Choose someone on your team.');
        }
        await db.query(`UPDATE actions SET owner_user_id = $2, updated_at = now() WHERE id = $1`, [id, body.ownerUserId]);
      }

      if (body.status && body.status !== from) {
        const to = body.status;
        if (!NEXT[from].includes(to)) throw new HttpError(409, 'invalid_status', `A ${from.replace('_', ' ')} action can’t be moved to ${to.replace('_', ' ')}.`);
        if (to === 'done' && !body.doneUrl && !body.doneNote) {
          throw new HttpError(400, 'invalid_input', 'Add the live URL or a note on what was done. The date it was done starts the before and after comparison.');
        }
        try {
          await db.query(
            `UPDATE actions SET status = $2, updated_at = now(),
                    approved_by = CASE WHEN $2 = 'approved' AND approved_by IS NULL THEN $3::uuid ELSE approved_by END,
                    approved_at = CASE WHEN $2 = 'approved' AND approved_at IS NULL THEN now() ELSE approved_at END,
                    dismiss_reason = CASE WHEN $2 = 'dismissed' THEN 'member' ELSE NULL END,
                    dismissed_at = CASE WHEN $2 = 'dismissed' THEN now() ELSE NULL END,
                    done_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END,
                    done_url = CASE WHEN $2 = 'done' THEN $4 ELSE NULL END,
                    done_note = CASE WHEN $2 = 'done' THEN $5 ELSE NULL END
              WHERE id = $1`,
            [id, to, req.user!.id, body.doneUrl ?? null, body.doneNote ?? null],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', 'There is already an open action for this; work on that one instead.');
          throw err;
        }
      }
      return { action: await actionOr404(db, id) };
    });
  });

  /** Starts writing an asset. The worker fills it in; the screen polls the asset. */
  app.post('/v1/actions/:id/assets', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(KINDS) }).strict(), req.body);
    if (opts.writer.mode === 'live' && !['robots_patch', 'llms_txt'].includes(kind)) {
      const problem = opts.writer.missing();
      if (problem) throw new HttpError(409, 'no_writer', `${problem} Your platform administrator can set it on the API keys screen.`);
    }
    const ctx = scope(req);
    const asset = await withTenant(ctx, (db) => requestAsset(db, { actionId: id, kind, userId: req.user!.id, mode: opts.writer.mode }));
    try {
      await opts.tasks.generate(asset.id, ctx.agencyId);
    } catch {
      await failAsset(asset.id, 'Could not be queued');
      throw new HttpError(503, 'queue_unavailable', 'Writing could not be started. Try again in a minute; no credits were used.');
    }
    reply.code(202);
    return { asset };
  });

  /** One version of an asset with its text: the latest unless ?version= is given. */
  app.get('/v1/actions/:id/assets/:kind', staff, async (req) => {
    const { id, kind } = parse(z.object({ id: z.string().uuid(), kind: z.enum(KINDS) }), req.params);
    const { version } = parse(z.object({ version: z.coerce.number().int().min(1).optional() }), req.query);
    return withTenant(scope(req), async (db) => {
      const { rows: versions } = await db.query(
        `SELECT s.id, s.version, s.status, s.origin, s.mode, s.model, s.credits, s.error, s.created_at, u.name AS created_by
           FROM assets s LEFT JOIN users u ON u.id = s.created_by WHERE s.action_id = $1 AND s.kind = $2 ORDER BY s.version DESC`,
        [id, kind],
      );
      if (!versions.length) throw notFound('Nothing has been produced yet');
      const chosen = version ? versions.find((v) => v.version === version) : versions[0];
      if (!chosen) throw notFound('Version not found');
      const { rows } = await db.query(`SELECT content FROM assets WHERE id = $1`, [chosen.id]);
      return {
        kind,
        label: ASSET_LABEL[kind],
        versions: versions.map((v) => ({
          id: v.id as string, version: v.version as number, status: v.status, origin: v.origin, mode: v.mode, model: v.model,
          credits: v.credits as number, error: v.error, createdAt: v.created_at, createdBy: v.created_by,
        })),
        current: { id: chosen.id as string, version: chosen.version as number, status: chosen.status as string, content: rows[0]?.content as string | null },
      };
    });
  });

  /** Saves an edit as a new version. Earlier versions are kept. */
  app.put('/v1/actions/:id/assets/:kind', staff, async (req) => {
    const { id, kind } = parse(z.object({ id: z.string().uuid(), kind: z.enum(KINDS) }), req.params);
    const { content } = parse(z.object({ content: z.string().min(1).max(200_000) }).strict(), req.body);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT agency_id, client_id, status FROM actions WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw notFound('Action not found');
      if (rows[0].status === 'dismissed' || rows[0].status === 'suggested') throw new HttpError(409, 'not_approved', 'Approve the action before working on it.');
      const { rows: latest } = await db.query(`SELECT version, status, content FROM assets WHERE action_id = $1 AND kind = $2 ORDER BY version DESC LIMIT 1`, [id, kind]);
      if (!latest.length) throw new HttpError(409, 'nothing_to_edit', 'Generate it first, then edit.');
      if (latest[0].status === 'pending') throw new HttpError(409, 'already_generating', 'Wait for the new version to finish first.');
      if (latest[0].content === content) return { version: latest[0].version as number, unchanged: true };
      const { rows: saved } = await db.query(
        `INSERT INTO assets (agency_id, client_id, action_id, kind, version, status, origin, mode, content, created_by, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'done', 'edited', 'live', $6, $7, now()) RETURNING version`,
        [rows[0].agency_id, rows[0].client_id, id, kind, latest[0].version + 1, content, req.user!.id],
      );
      await db.query(`UPDATE actions SET updated_at = now() WHERE id = $1`, [id]);
      return { version: saved[0].version as number, unchanged: false };
    });
  });

  app.get('/v1/assets/:id', staff, async (req) => {
    const { id } = parse(uuidParam, req.params);
    return withTenant(scope(req), async (db) => {
      const { rows } = await db.query(`SELECT id, action_id, kind, version, status, error FROM assets WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Not found');
      return { asset: { id: rows[0].id, actionId: rows[0].action_id, kind: rows[0].kind, version: rows[0].version, status: rows[0].status, error: rows[0].error } };
    });
  });

  /** The asset as a file. Never served inline, so an HTML asset can't run in the app's origin. */
  app.get('/v1/assets/:id/download', staff, async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const row = await withTenant(scope(req), async (db) => {
      const { rows } = await db.query(
        `SELECT s.kind, s.version, s.content, s.status, a.title FROM assets s JOIN actions a ON a.id = s.action_id WHERE s.id = $1`,
        [id],
      );
      return rows[0];
    });
    if (!row) throw notFound('Not found');
    if (row.status !== 'done') throw new HttpError(409, 'not_ready', 'This version is not ready.');
    const file = ASSET_FILE[row.kind as AssetKind];
    const name = file.name(slugify(row.title)).replace(/(\.\w+)$/, row.kind === 'robots_patch' || row.kind === 'llms_txt' ? '$1' : `-v${row.version}$1`);
    reply
      .header('content-type', file.type)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return row.content;
  });
}
