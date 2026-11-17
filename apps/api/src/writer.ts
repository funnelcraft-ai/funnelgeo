import { config } from './config.js';
import { setting } from './settings.js';

/**
 * The one place generators call a language model. The provider, model and
 * key come from the API keys screen (or the environment) and are read on
 * every call, so a change takes effect at once.
 *
 * With no writing model set, it uses the OpenAI or Gemini key and model
 * already set for the answer engines, so nothing extra is needed to start.
 */

export type WriterProvider = 'openai' | 'anthropic' | 'gemini';
export const WRITER_PROVIDERS: WriterProvider[] = ['openai', 'anthropic', 'gemini'];
export const WRITER_LABEL: Record<WriterProvider, string> = { openai: 'OpenAI', anthropic: 'Claude (Anthropic)', gemini: 'Gemini (Google)' };

export interface WriteRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface Written {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface Writer {
  mode: 'live' | 'mock';
  /** Null when it can write; otherwise what is missing, in words for the screen. */
  missing(): string | null;
  write(request: WriteRequest, signal: AbortSignal): Promise<Written>;
}

interface Resolved {
  provider: WriterProvider;
  apiKey: string;
  model: string;
}

export function resolveWriter(): Resolved & { problem: string | null } {
  const raw = setting('WRITER_PROVIDER') || 'openai';
  const provider = (WRITER_PROVIDERS as string[]).includes(raw) ? (raw as WriterProvider) : 'openai';
  const apiKey = setting(provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY');
  // The engine models also write well enough; Claude has no engine model to fall back on.
  const model = setting('WRITER_MODEL') || (provider === 'openai' ? setting('OPENAI_MODEL') : provider === 'gemini' ? setting('GEMINI_MODEL') : '');
  const problem = !apiKey
    ? `No ${WRITER_LABEL[provider]} API key is set for writing.`
    : !model
      ? `No writing model is set for ${WRITER_LABEL[provider]}.`
      : null;
  return { provider, apiKey, model, problem };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Request and response formats per provider documentation (OpenAI Responses
// API, Anthropic Messages API, Gemini generateContent). Not yet run against
// the live services from here; the Test button on the API keys screen does that.
async function call({ provider, apiKey, model }: Resolved, request: WriteRequest, signal: AbortSignal): Promise<Written> {
  if (provider === 'openai') {
    const data = await postJson(
      `${config.engines.chatgpt.baseUrl}/v1/responses`,
      { authorization: `Bearer ${apiKey}` },
      { model, instructions: request.system, input: request.prompt, max_output_tokens: request.maxTokens },
      signal,
    );
    const parts: any[] = (data.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []);
    return { text: parts.map((p) => p.text ?? '').join(''), model, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0 };
  }
  if (provider === 'anthropic') {
    const data = await postJson(
      `${config.anthropicBaseUrl}/v1/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: request.maxTokens, system: request.system, messages: [{ role: 'user', content: request.prompt }] },
      signal,
    );
    const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    return { text, model, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0 };
  }
  const data = await postJson(
    `${config.engines.gemini.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': apiKey },
    { systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: 'user', parts: [{ text: request.prompt }] }], generationConfig: { maxOutputTokens: request.maxTokens } },
    signal,
  );
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  return { text, model, tokensIn: data.usageMetadata?.promptTokenCount ?? 0, tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0 };
}

/** A writer that always calls the real model, whatever the engine mode: used by the Test button. */
export function createLiveWriter(): Writer {
  return {
    mode: 'live',
    missing: () => resolveWriter().problem,
    async write(request, signal) {
      const resolved = resolveWriter();
      if (resolved.problem) throw new Error(resolved.problem);
      const written = await call(resolved, request, signal);
      if (!written.text.trim()) throw new Error('The writing model returned no text.');
      return written;
    },
  };
}

export function createWriter(): Writer {
  if (config.engineMode === 'mock') {
    return {
      mode: 'mock',
      missing: () => null,
      // Generators write their own stand-in text in mock mode; this is never reached for them.
      async write(request) {
        return { text: `Demo text. ${request.prompt.slice(0, 200)}`, model: 'mock', tokensIn: 0, tokensOut: 0 };
      },
    };
  }
  return createLiveWriter();
}
