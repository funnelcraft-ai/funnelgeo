import { ownerPool } from '../db.js';

/**
 * One row per call that costs the platform money (or could): engine calls,
 * writing calls, suggestions, crawled pages and Test buttons. Priced later from
 * the model prices, so a corrected price fixes past months too. Recording
 * never fails the work it describes: a lost row is logged, not thrown.
 */

export type UsageKind = 'engine_call' | 'writer_call' | 'suggestion_call' | 'page_fetch' | 'test_call';

/** Which provider bills for each answer engine. */
export const ENGINE_PROVIDER: Record<string, string> = { chatgpt: 'openai', perplexity: 'perplexity', gemini: 'gemini' };

export interface UsageEvent {
  agencyId: string | null;
  clientId?: string | null;
  kind: UsageKind;
  provider: string;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  requests?: number;
  providerCostUsd?: number | null;
  refId?: string | null;
}

export async function recordUsage(e: UsageEvent): Promise<void> {
  try {
    await ownerPool.query(
      `INSERT INTO usage_events (agency_id, client_id, kind, provider, model, tokens_in, tokens_out, requests, provider_cost_usd, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.agencyId,
        e.clientId ?? null,
        e.kind,
        e.provider,
        (e.model || '*').slice(0, 120),
        Math.max(0, Math.round(e.tokensIn ?? 0)),
        Math.max(0, Math.round(e.tokensOut ?? 0)),
        Math.max(0, Math.round(e.requests ?? 1)),
        e.providerCostUsd ?? null,
        e.refId ?? null,
      ],
    );
  } catch (err) {
    console.error(JSON.stringify({ message: 'usage not recorded', kind: e.kind, provider: e.provider, error: String((err as Error)?.message ?? err) }));
  }
}

/** The provider and model behind the configured writer, for recording its calls. */
export function writerProvider(mode: 'live' | 'mock', provider: string): string {
  return mode === 'mock' ? 'mock' : provider;
}

/**
 * Counts every page a fetcher opens, successful or not, so crawling is
 * recorded wherever it happens: website checks, cited-page checks and file
 * generators.
 */
export function countingFetcher<F extends (url: string) => Promise<unknown>>(fetcher: F): { fetcher: F; count: () => number } {
  let n = 0;
  const wrapped = (async (url: string) => {
    n++;
    return fetcher(url);
  }) as F;
  return { fetcher: wrapped, count: () => n };
}

export async function recordPages(agencyId: string, clientId: string | null, pages: number, refId: string | null): Promise<void> {
  if (pages > 0) await recordUsage({ agencyId, clientId, kind: 'page_fetch', provider: 'crawl', requests: pages, refId });
}
