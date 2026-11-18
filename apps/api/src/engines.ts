import { createHash } from 'node:crypto';
import { config } from './config.js';
import { setting, settingsVersion } from './settings.js';

export interface EngineAnswer {
  text: string;
  /** Source URLs in the order the engine returned them. */
  citations: string[];
  tokensIn: number;
  tokensOut: number;
  /** What the provider says the call cost in USD, when it reports that. */
  costUsd: number | null;
  /** The model that answered, for costing. */
  model?: string;
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

function chatgpt({ apiKey, model, baseUrl }: EngineCredentials): EngineAdapter {
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
        model,
      };
    },
  };
}

function perplexity({ apiKey, model, baseUrl }: EngineCredentials): EngineAdapter {
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
        model,
      };
    },
  };
}

function gemini({ apiKey, model, baseUrl }: EngineCredentials): EngineAdapter {
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
        model,
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
      // Without context (a request for competitor names) it lists the stand-in businesses.
      const names = ctx ? [...named.map((b) => b.name), FILLER[Math.floor(roll('filler') * FILLER.length)]!] : [...FILLER];
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
        model: 'mock',
      };
    },
  };
}

export interface EngineSet {
  mode: 'live' | 'mock';
  /** Engines that can be called right now. */
  available: Map<string, EngineAdapter>;
}

export interface EngineCredentials {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const SETTING_PREFIX: Record<EngineKey, string> = { chatgpt: 'OPENAI', perplexity: 'PERPLEXITY', gemini: 'GEMINI' };

/** An engine's key and model as currently set: saved by the super admin, or else from the environment. */
export function credentialsFor(key: EngineKey): EngineCredentials {
  const prefix = SETTING_PREFIX[key];
  return { apiKey: setting(`${prefix}_API_KEY`), model: setting(`${prefix}_MODEL`), baseUrl: config.engines[key].baseUrl };
}

/** A live adapter for one engine with its current credentials, or null when its key or model is missing. */
export function liveEngine(key: EngineKey): EngineAdapter | null {
  const credentials = credentialsFor(key);
  if (!credentials.apiKey || !credentials.model) return null;
  return ({ chatgpt, perplexity, gemini })[key](credentials);
}

/**
 * In live mode an engine is available only when both its API key and model
 * are set. The set is rebuilt whenever the saved settings change, so a key
 * entered on the API keys screen is used from the next call on.
 */
export function createEngines(): EngineSet {
  if (config.engineMode === 'mock') {
    const available = new Map<string, EngineAdapter>();
    for (const key of ENGINE_KEYS) available.set(key, mock(key));
    return { mode: 'mock', available };
  }
  let builtFor = -1;
  let available = new Map<string, EngineAdapter>();
  const signature = () => ENGINE_KEYS.map((k) => JSON.stringify(credentialsFor(k))).join('|');
  let builtSignature = '';
  return {
    mode: 'live',
    get available() {
      // Rebuild when saved settings change, or when the environment does (in tests).
      if (builtFor !== settingsVersion() || builtSignature !== signature()) {
        available = new Map();
        for (const key of ENGINE_KEYS) {
          const engine = liveEngine(key);
          if (engine) available.set(key, engine);
        }
        builtFor = settingsVersion();
        builtSignature = signature();
      }
      return available;
    },
  };
}
