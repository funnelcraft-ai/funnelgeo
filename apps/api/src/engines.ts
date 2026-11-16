import { createHash } from 'node:crypto';
import { config } from './config.js';

export interface EngineAnswer {
  text: string;
  /** Source URLs in the order the engine returned them. */
  citations: string[];
  tokensIn: number;
  tokensOut: number;
  /** What the provider says the call cost in USD, when it reports that. */
  costUsd: number | null;
}

/** Only the mock engine reads this. It must never be sent to a real engine: naming the brands would bias the answer. */
export interface MockContext {
  brands: { name: string; domain: string | null }[];
  sampleNo: number;
}

export interface EngineAdapter {
  key: string;
  ask(prompt: string, signal: AbortSignal, mock?: MockContext): Promise<EngineAnswer>;
}

export type EngineKey = 'chatgpt' | 'perplexity' | 'gemini';
export const ENGINE_KEYS: EngineKey[] = ['chatgpt', 'perplexity', 'gemini'];

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const urls = (values: unknown[]): string[] => values.filter((v): v is string => typeof v === 'string' && v.length > 0);

// The three request and response formats below were checked against each
// provider's API documentation on 16 Nov 2026. They have not been run against
// the live services; spike/cost-spike.mjs uses the same formats and is the
// quickest way to confirm them with real keys.

function chatgpt(): EngineAdapter {
  const { apiKey, model, baseUrl } = config.engines.chatgpt;
  return {
    key: 'chatgpt',
    async ask(prompt, signal) {
      const data = await postJson(
        `${baseUrl}/v1/responses`,
        { authorization: `Bearer ${apiKey}` },
        { model, input: prompt, tools: [{ type: 'web_search' }] },
        signal,
      );
      const parts: any[] = (data.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []);
      return {
        text: parts.map((p) => p.text ?? '').join(''),
        citations: urls(parts.flatMap((p) => (p.annotations ?? []).map((a: any) => a.url))),
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
        costUsd: null,
      };
    },
  };
}

function perplexity(): EngineAdapter {
  const { apiKey, model, baseUrl } = config.engines.perplexity;
  return {
    key: 'perplexity',
    async ask(prompt, signal) {
      const data = await postJson(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        { model, messages: [{ role: 'user', content: prompt }] },
        signal,
      );
      const cost = data.usage?.cost?.total_cost;
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        citations: urls([...(data.citations ?? []), ...(data.search_results ?? []).map((r: any) => r?.url)]),
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
        costUsd: typeof cost === 'number' ? cost : null,
      };
    },
  };
}

function gemini(): EngineAdapter {
  const { apiKey, model, baseUrl } = config.engines.gemini;
  return {
    key: 'gemini',
    async ask(prompt, signal) {
      const data = await postJson(
        `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
        signal,
      );
      const candidate = data.candidates?.[0];
      return {
        text: (candidate?.content?.parts ?? []).map((p: any) => p.text ?? '').join(''),
        citations: urls((candidate?.groundingMetadata?.groundingChunks ?? []).map((c: any) => c?.web?.uri)),
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
        costUsd: null,
      };
    },
  };
}

/**
 * Development stand-in. Produces a plausible answer that names some of the
 * tracked brands, chosen by a hash of the prompt, engine and sample, so the
 * same call always gives the same answer. The numbers it leads to mean nothing.
 */
function mock(key: EngineKey): EngineAdapter {
  const FILLER = ['Local Favourite', 'City Central', 'Northside Group', 'The Original Co'];
  const SOURCES = ['https://www.bestof.example/top-10', 'https://reviews.example/guide', 'https://forum.example/thread/4821', 'https://news.example/roundup'];
  return {
    key,
    async ask(prompt, _signal, ctx) {
      const brands = ctx?.brands ?? [];
      const roll = (salt: string) => createHash('sha256').update(`${key}|${ctx?.sampleNo ?? 0}|${prompt}|${salt}`).digest().readUInt32BE(0) / 0xffffffff;
      // Each engine leans a little differently, and the first brand (the client) is named less often than not.
      const lean = { chatgpt: 0.5, perplexity: 0.42, gemini: 0.34 }[key];
      const named = brands
        .map((brand, i) => ({ brand, score: roll(`pick:${brand.name}`), chance: i === 0 ? lean : 0.62 }))
        .filter((x) => x.score < x.chance)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.brand);
      const names = [...named.map((b) => b.name), FILLER[Math.floor(roll('filler') * FILLER.length)]!];
      const lines = names.map((name, i) => `${i + 1}. ${name}: often recommended for this, with consistently good feedback.`);
      const citations = [
        ...named.filter((b) => b.domain && roll(`cite:${b.name}`) < 0.5).map((b) => `https://www.${b.domain}/`),
        ...SOURCES.filter((s) => roll(`src:${s}`) < 0.6),
      ];
      return {
        text: `[Mock answer, not from ${key}] For "${prompt}", these come up most often:\n\n${lines.join('\n')}`,
        citations,
        tokensIn: 20 + prompt.length,
        tokensOut: 60 + lines.length * 18,
        costUsd: null,
      };
    },
  };
}

export interface EngineSet {
  mode: 'live' | 'mock';
  /** Engines that can be called right now. */
  available: Map<string, EngineAdapter>;
}

/** In live mode an engine is available only when both its API key and model are set. */
export function createEngines(): EngineSet {
  const available = new Map<string, EngineAdapter>();
  if (config.engineMode === 'mock') {
    for (const key of ENGINE_KEYS) available.set(key, mock(key));
    return { mode: 'mock', available };
  }
  const live: Record<EngineKey, () => EngineAdapter> = { chatgpt, perplexity, gemini };
  for (const key of ENGINE_KEYS) {
    const settings = config.engines[key];
    if (settings.apiKey && settings.model) available.set(key, live[key]());
  }
  return { mode: 'live', available };
}
