#!/usr/bin/env node
// Milestone 1: cost spike.
//
// Runs a set of prompts on each answer engine several times and reports, per
// engine: success rate, latency, tokens, how many answers came back with
// citations, and (if you supply prices) the estimated cost per call and per
// client per month. No dependencies; needs Node 22.
//
//   node --env-file=spike/.env spike/cost-spike.mjs [--prompts 25] [--samples 3] [--file spike/prompts.json]
//
// An engine is skipped unless both its API key and its model are set. Model
// names are deliberately not defaulted: use the current model each provider
// recommends for search-grounded answers.
//
// NOTE: the request and response shapes below follow each provider's public
// API as understood when this was written and have not been run against the
// live services. If a provider returns an error on the first call, check its
// current API reference and adjust the matching function; each is ~20 lines.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

const SAMPLES = num(args.samples, 3);
const PROMPT_LIMIT = num(args.prompts, 25);
const CONCURRENCY = num(env.SPIKE_CONCURRENCY, 3);
const TIMEOUT_MS = num(env.SPIKE_TIMEOUT_MS, 90_000);

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const unique = (urls) => [...new Set(urls.filter(Boolean))];

const engines = [
  {
    key: 'openai',
    label: 'ChatGPT (OpenAI API + web search)',
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    priceIn: num(env.OPENAI_PRICE_IN_PER_MTOK),
    priceOut: num(env.OPENAI_PRICE_OUT_PER_MTOK),
    priceCall: num(env.OPENAI_PRICE_PER_SEARCH_CALL, 0),
    async ask(prompt) {
      const data = await postJson(
        `${env.OPENAI_BASE_URL ?? 'https://api.openai.com'}/v1/responses`,
        { authorization: `Bearer ${this.apiKey}` },
        { model: this.model, input: prompt, tools: [{ type: 'web_search' }] },
      );
      const parts = (data.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
      return {
        text: parts.map((p) => p.text ?? '').join(''),
        citations: unique(parts.flatMap((p) => (p.annotations ?? []).map((a) => a.url))),
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
      };
    },
  },
  {
    key: 'perplexity',
    label: 'Perplexity (Sonar API)',
    apiKey: env.PERPLEXITY_API_KEY,
    model: env.PERPLEXITY_MODEL,
    priceIn: num(env.PERPLEXITY_PRICE_IN_PER_MTOK),
    priceOut: num(env.PERPLEXITY_PRICE_OUT_PER_MTOK),
    priceCall: num(env.PERPLEXITY_PRICE_PER_SEARCH_CALL, 0),
    async ask(prompt) {
      const data = await postJson(
        `${env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai'}/chat/completions`,
        { authorization: `Bearer ${this.apiKey}` },
        { model: this.model, messages: [{ role: 'user', content: prompt }] },
      );
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        citations: unique([...(data.citations ?? []), ...(data.search_results ?? []).map((r) => r.url)]),
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
      };
    },
  },
  {
    key: 'gemini',
    label: 'Gemini (API + Google Search grounding)',
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    priceIn: num(env.GEMINI_PRICE_IN_PER_MTOK),
    priceOut: num(env.GEMINI_PRICE_OUT_PER_MTOK),
    priceCall: num(env.GEMINI_PRICE_PER_SEARCH_CALL, 0),
    async ask(prompt) {
      const base = env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com';
      const data = await postJson(
        `${base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        { 'x-goog-api-key': this.apiKey },
        { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] },
      );
      const candidate = data.candidates?.[0];
      return {
        text: (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
        citations: unique((candidate?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web?.uri)),
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  },
];

const active = engines.filter((e) => e.apiKey && e.model);
for (const e of engines.filter((x) => !active.includes(x))) {
  console.log(`Skipping ${e.key}: set ${e.key.toUpperCase()}_API_KEY and ${e.key.toUpperCase()}_MODEL to include it.`);
}
if (active.length === 0) {
  console.error('\nNo engines configured. Copy spike/.env.example to spike/.env and fill it in.');
  process.exit(1);
}

const promptFile = args.file ?? path.join(here, 'prompts.json');
let prompts;
try {
  prompts = JSON.parse(await readFile(promptFile, 'utf8'));
} catch {
  console.error(`Could not read ${promptFile}. Copy spike/prompts.example.json to spike/prompts.json and edit it.`);
  process.exit(1);
}
prompts = prompts.slice(0, PROMPT_LIMIT);

const jobs = [];
for (const engine of active) for (const [i, prompt] of prompts.entries()) for (let s = 1; s <= SAMPLES; s++) jobs.push({ engine, prompt, promptNo: i + 1, sample: s });
console.log(`\n${prompts.length} prompts x ${active.length} engines x ${SAMPLES} samples = ${jobs.length} calls\n`);

const rows = [];
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const started = performance.now();
    const row = { engine: job.engine.key, promptNo: job.promptNo, sample: job.sample, ok: false, ms: 0, tokensIn: 0, tokensOut: 0, citations: 0, chars: 0, error: '' };
    try {
      const answer = await job.engine.ask(job.prompt);
      Object.assign(row, { ok: true, tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, citations: answer.citations.length, chars: answer.text.length });
    } catch (err) {
      row.error = String(err.message ?? err).replace(/\s+/g, ' ').slice(0, 200);
    }
    row.ms = Math.round(performance.now() - started);
    rows.push(row);
    process.stdout.write(row.ok ? '.' : 'x');
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
console.log('\n');

// Report ------------------------------------------------------------------------

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const CALLS_PER_CLIENT_MONTH = 25 * 3 * 4; // prompts x samples x weekly runs, per engine

const summary = active.map((engine) => {
  const all = rows.filter((r) => r.engine === engine.key);
  const ok = all.filter((r) => r.ok);
  const tokensIn = mean(ok.map((r) => r.tokensIn));
  const tokensOut = mean(ok.map((r) => r.tokensOut));
  const priced = Number.isFinite(engine.priceIn) && Number.isFinite(engine.priceOut);
  const costPerCall = priced ? (tokensIn * engine.priceIn + tokensOut * engine.priceOut) / 1e6 + engine.priceCall : null;
  return {
    engine: engine.key,
    model: engine.model,
    'ok/calls': `${ok.length}/${all.length}`,
    'median s': (median(ok.map((r) => r.ms)) / 1000).toFixed(1),
    'avg tokens in': Math.round(tokensIn),
    'avg tokens out': Math.round(tokensOut),
    'with citations': ok.length ? `${Math.round((100 * ok.filter((r) => r.citations > 0).length) / ok.length)}%` : '-',
    'cost/call': costPerCall === null ? 'set prices' : costPerCall.toFixed(4),
    'cost/client/month': costPerCall === null ? 'set prices' : (costPerCall * CALLS_PER_CLIENT_MONTH).toFixed(2),
  };
});
console.table(summary);

const totals = summary.map((s) => Number(s['cost/client/month'])).filter(Number.isFinite);
if (totals.length === summary.length) {
  console.log(`All engines, one client, one month (25 prompts, 3 samples, weekly): ${totals.reduce((a, b) => a + b, 0).toFixed(2)} in your price currency`);
} else {
  console.log('Add the *_PRICE_* values from each provider\'s pricing page to spike/.env to get cost estimates.');
}
const failures = rows.filter((r) => !r.ok);
if (failures.length) console.log(`\n${failures.length} failed calls. First error per engine:`, Object.fromEntries(active.map((e) => [e.key, failures.find((f) => f.engine === e.key)?.error ?? 'none'])));

const outDir = path.join(here, 'results');
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `spike-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
const columns = ['engine', 'promptNo', 'sample', 'ok', 'ms', 'tokensIn', 'tokensOut', 'citations', 'chars', 'error'];
await writeFile(outFile, [columns.join(','), ...rows.map((r) => columns.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n') + '\n');
console.log(`\nPer-call results: ${outFile}`);
