import type { SiteFetcher } from '../audits/fetch.js';
import type { SiteFindings } from '../audits/site.js';
import { withSystem, withTenant, type Db } from '../db.js';
import { HttpError, notFound } from '../http.js';
import { resolveWriter, type Writer } from '../writer.js';
import { countingFetcher, recordPages, recordUsage } from '../billing/usage.js';
import { ASSET_CREDITS, ASSET_LABEL, generate, type GenContext } from './generators.js';
import { generatorsFor, type ActionDetails, type ActionType, type AssetKind } from './rules.js';

const GENERATION_TIMEOUT_MS = 120_000;

export interface GenerationDeps {
  writer: Writer;
  fetcher: SiteFetcher;
}

/**
 * Queues one generated asset: checks the action allows it, reserves its
 * credits with the agency row locked (so two requests can't overspend), and
 * stores a pending version. The worker fills it in or refunds it.
 */
export async function requestAsset(db: Db, input: { actionId: string; kind: AssetKind; userId: string; mode: 'live' | 'mock' }) {
  const { rows } = await db.query(`SELECT id, client_id, agency_id, type, status, details FROM actions WHERE id = $1 FOR UPDATE`, [input.actionId]);
  const action = rows[0];
  if (!action) throw notFound('Action not found');
  if (!['approved', 'in_progress'].includes(action.status)) {
    throw new HttpError(409, 'not_approved', 'Approve the action before generating anything for it.');
  }
  if (!generatorsFor(action.type as ActionType, action.details as ActionDetails).includes(input.kind)) {
    throw new HttpError(400, 'invalid_input', `A ${ASSET_LABEL[input.kind].toLowerCase()} isn’t available for this action.`);
  }
  const { rows: busy } = await db.query(`SELECT 1 FROM assets WHERE action_id = $1 AND kind = $2 AND status = 'pending'`, [input.actionId, input.kind]);
  if (busy.length) throw new HttpError(409, 'already_generating', `A ${ASSET_LABEL[input.kind].toLowerCase()} is already being written.`);

  const credits = ASSET_CREDITS[input.kind];
  if (credits > 0) {
    await db.query(`SELECT 1 FROM agencies WHERE id = app_agency_id() FOR UPDATE`);
    const { rows: balance } = await db.query<{ remaining: number }>(`SELECT credits_spendable(app_agency_id()) AS remaining`);
    if (credits > balance[0]!.remaining) {
      throw new HttpError(402, 'insufficient_credits', `This needs ${credits} ${credits === 1 ? 'credit' : 'credits'} and ${Math.max(balance[0]!.remaining, 0)} are left this month.`);
    }
  }
  const { rows: created } = await db.query(
    `INSERT INTO assets (agency_id, client_id, action_id, kind, version, status, origin, mode, credits, created_by)
     VALUES ($1, $2, $3, $4,
             (SELECT coalesce(max(version), 0) + 1 FROM assets WHERE action_id = $3 AND kind = $4),
             'pending', 'generated', $5, $6, $7)
     RETURNING id, version`,
    [action.agency_id, action.client_id, input.actionId, input.kind, input.mode, credits, input.userId],
  );
  const asset = created[0]!;
  if (credits > 0) {
    await db.query(
      `INSERT INTO credit_ledger (agency_id, delta, reason, asset_id, created_by, note) VALUES ($1, $2, 'asset_reserved', $3, $4, $5)`,
      [action.agency_id, -credits, asset.id, input.userId, ASSET_LABEL[input.kind]],
    );
  }
  // Starting work moves an approved action along.
  if (action.status === 'approved') await db.query(`UPDATE actions SET status = 'in_progress', updated_at = now() WHERE id = $1`, [input.actionId]);
  return { id: asset.id as string, version: asset.version as number, credits };
}

async function contextFor(db: Db, actionId: string, kind: AssetKind): Promise<GenContext> {
  const { rows } = await db.query(
    `SELECT a.type, a.title, a.rationale, a.details, c.id AS client_id, c.name, c.domain, coalesce(c.category, c.vertical) AS category, c.location, c.voice
       FROM actions a JOIN clients c ON c.id = a.client_id WHERE a.id = $1`,
    [actionId],
  );
  const a = rows[0];
  const { rows: prompts } = await db.query<{ text: string }>(
    `SELECT p.text FROM action_prompts ap JOIN prompts p ON p.id = ap.prompt_id WHERE ap.action_id = $1 ORDER BY p.priority DESC, p.created_at`,
    [actionId],
  );
  const { rows: competitors } = await db.query<{ name: string }>(`SELECT name FROM competitors WHERE client_id = $1 ORDER BY created_at`, [a.client_id]);
  const { rows: site } = await db.query(`SELECT findings FROM site_audits WHERE client_id = $1 AND status = 'done' ORDER BY created_at DESC LIMIT 1`, [a.client_id]);
  const { rows: brief } =
    kind === 'draft'
      ? await db.query<{ content: string }>(`SELECT content FROM assets WHERE action_id = $1 AND kind = 'brief' AND status = 'done' ORDER BY version DESC LIMIT 1`, [actionId])
      : { rows: [] as { content: string }[] };
  const details = a.details as ActionDetails;
  return {
    client: { name: a.name, domain: a.domain, category: a.category, location: a.location, voice: a.voice },
    action: { type: a.type, title: a.title, rationale: a.rationale, details },
    questions: prompts.length ? prompts.map((p) => p.text) : details.questions ?? [],
    competitors: competitors.map((c) => c.name),
    site: (site[0]?.findings as SiteFindings | undefined) ?? null,
    brief: brief[0]?.content ?? null,
  };
}

/** The worker's half: writes the asset, or marks it failed and refunds its credits. Safe to run twice. */
export async function runGeneration(deps: GenerationDeps, assetId: string, agencyId: string): Promise<void> {
  const ctx = { agencyId };
  const job = await withTenant(ctx, async (db) => {
    const { rows } = await db.query(`SELECT id, action_id, client_id, kind, credits FROM assets WHERE id = $1 AND status = 'pending'`, [assetId]);
    if (!rows[0]) return null;
    return {
      asset: rows[0] as { id: string; action_id: string; kind: AssetKind; credits: number },
      clientId: rows[0].client_id as string,
      context: await contextFor(db, rows[0].action_id, rows[0].kind),
    };
  });
  if (!job) return;
  try {
    const counted = countingFetcher(deps.fetcher);
    const out = await generate(job.asset.kind, job.context, deps.writer, counted.fetcher, AbortSignal.timeout(GENERATION_TIMEOUT_MS));
    await recordPages(agencyId, job.clientId, counted.count(), assetId);
    if (out.model) {
      await recordUsage({
        agencyId,
        clientId: job.clientId,
        kind: 'writer_call',
        provider: deps.writer.mode === 'mock' ? 'mock' : resolveWriter().provider,
        model: out.model,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        refId: assetId,
      });
    }
    await withTenant(ctx, (db) =>
      db.query(
        `UPDATE assets SET status = 'done', content = $2, model = $3, tokens_in = $4, tokens_out = $5, mode = $6, finished_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [assetId, out.content.slice(0, 200_000), out.model, out.tokensIn, out.tokensOut, out.mode],
      ),
    );
  } catch (err) {
    await failAsset(assetId, String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 300));
  }
}

/** Marks a pending asset failed and gives its credits back, once. */
export async function failAsset(assetId: string, reason: string): Promise<void> {
  await withSystem(async (db) => {
    const { rows } = await db.query(
      `UPDATE assets SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'pending' RETURNING agency_id, credits, kind`,
      [assetId, reason],
    );
    const a = rows[0];
    if (a && a.credits > 0) {
      await db.query(`INSERT INTO credit_ledger (agency_id, delta, reason, asset_id, note) VALUES ($1, $2, 'asset_refund', $3, $4)`, [
        a.agency_id,
        a.credits,
        assetId,
        `${ASSET_LABEL[a.kind as AssetKind]} failed`,
      ]);
    }
  });
}

/** Generations whose job was lost: failed and refunded after this long. */
export async function closeStuckAssets(olderThanMinutes = 15): Promise<number> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(`SELECT id FROM assets WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1)`, [olderThanMinutes]),
  );
  for (const row of rows) await failAsset(row.id, 'Timed out waiting to be written');
  return rows.length;
}
