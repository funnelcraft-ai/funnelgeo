import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { faqHtml, parseFaqs, patchRobots } from '../src/actions/generators.js';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { closePools, ownerPool, withTenant } from '../src/db.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';
import { createLiveWriter, type WriteRequest, type Writer } from '../src/writer.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-actions`;

const BESTOF = 'https://www.bestof.example/best-dentists-pune';
const YELP = 'https://www.yelp.com/search?find_desc=dentist&find_loc=Pune';
const SMILE_PAGE = 'https://smilestudio.example/implants';

// Scripted engines --------------------------------------------------------------------------------
let round = 1;
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 5, tokensOut: 20, costUsd: null });
function script(engine: string, prompt: string): EngineAnswer {
  if (prompt.includes('Best dentist')) return round < 3 ? answer('Smile Studio is a top choice in Pune.', [BESTOF, YELP]) : answer('Blue Lotus Dental is the top choice.', [BESTOF]);
  if (prompt.includes('implants')) {
    return engine === 'perplexity' ? answer('Blue Lotus Dental and Smile Studio both offer implants.', [SMILE_PAGE]) : answer('Smile Studio offers implants.', [SMILE_PAGE]);
  }
  if (prompt.includes('whitening')) return answer('Blue Lotus Dental does whitening.', ['https://bluelotus.example/whitening']);
  return answer('Ask your family doctor for a referral.');
}
const engines: EngineSet = {
  mode: 'live',
  available: new Map(['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [key, { key, ask: async (prompt) => script(key, prompt) }])),
};

// The client's website and the cited pages ------------------------------------------------------
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
const filler = 'Choosing a dentist takes some care, so we looked at prices, reviews, opening hours and how easy it is to book. '.repeat(10);
const ROBOTS = 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n\nSitemap: https://bluelotus.example/sitemap.xml\n';
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => {
  const page = (status: number, body: string, contentType = 'text/html'): FetchedPage => ({ url, finalUrl: url, status, contentType, body });
  if (url === BESTOF) return page(200, html('Best dentists in Pune for 2026', `${filler} 1. Smile Studio. 2. Pearl Clinic.`));
  if (url === YELP) return page(403, 'Forbidden');
  const { pathname } = new URL(url);
  if (pathname === '/robots.txt') return page(200, ROBOTS, 'text/plain');
  if (pathname === '/sitemap.xml') {
    return page(200, '<urlset><url><loc>https://bluelotus.example/</loc></url><url><loc>https://bluelotus.example/services/teeth-whitening</loc></url><url><loc>https://bluelotus.example/about-us</loc></url></urlset>', 'application/xml');
  }
  if (pathname === '/') return page(200, html('Blue Lotus Dental', filler));
  return page(404, html('Not found', ''));
};

// A writing model that records what it was asked --------------------------------------------------
const asked: WriteRequest[] = [];
let failNext = false;
const writer: Writer = {
  mode: 'live',
  missing: () => null,
  async write(request) {
    asked.push(request);
    if (failNext) {
      failNext = false;
      throw new Error('HTTP 529: overloaded');
    }
    const s = request.system;
    const text = s.includes('content briefs')
      ? '## Goal\nAnswer the implant cost question.\n\n## Facts to get from the client\n- [ADD: price range]'
      : s.includes('web pages')
        ? '# How much do dental implants cost in Pune?\n\nBlue Lotus Dental [ADD: price range].'
        : s.includes('FAQ entries')
          ? '```json\n{"faqs":[{"question":"How much do implants cost?","answer":"[ADD: price range]. </script><b>x</b>"},{"question":"How long does it take?","answer":"[ADD: weeks]."}]}\n```'
          : 'Subject: A suggestion\n\nHi [ADD: recipient name],';
    return { text, model: 'fake-model-1', tokensIn: 100, tokensOut: 50 };
  },
};

const mails: Mail[] = [];
const mailer = { enabled: true, async send(mail: Mail) { mails.push(mail); } };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let owner: { host: string; cookie: string; agencyId: string };
let clientId: string;
const promptIds: Record<string, string> = {};

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({ method, url, headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const sid = res.cookies.find((c) => c.name === 'sid');
  let json: any = null;
  try { json = res.json(); } catch { /* a file */ }
  return { status: res.statusCode, json, body: res.body, headers: res.headers, cookie: sid ? `sid=${sid.value}` : undefined };
}

async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId as string };
}

/** Runs the client and waits for the diagnosis follow-up, which refreshes the queue. */
async function runAndWait() {
  const started = await call('POST', `/v1/clients/${clientId}/runs`, owner);
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const runId = started.json.run.id;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await ownerPool.query(`SELECT status, emailed_at FROM diagnoses WHERE run_id = $1`, [runId]);
    if (rows[0]?.status === 'done' && rows[0]?.emailed_at) return runId as string;
    assert.ok(Date.now() < deadline, 'diagnosis did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const queueNow = async () => (await call('GET', `/v1/clients/${clientId}/actions`, owner)).json;
const byKey = async (key: string) => {
  const { rows } = await ownerPool.query(`SELECT id FROM actions WHERE client_id = $1 AND key = $2 ORDER BY created_at DESC LIMIT 1`, [clientId, key]);
  return (await queueNow()).actions.find((a: any) => a.id === rows[0]?.id);
};

async function generated(assetId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { json } = await call('GET', `/v1/assets/${assetId}`, owner);
    if (json.asset.status !== 'pending') return json.asset;
    assert.ok(Date.now() < deadline, 'asset still pending');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const credits = async () => (await call('GET', '/v1/credits', owner)).json.remaining as number;

before(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await db.connect();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.end();
  await migrate(process.env.DATABASE_OWNER_URL!, process.env.APP_DB_PASSWORD);
  const redis = new Redis(process.env.REDIS_URL!);
  const stale = await redis.keys(`${PREFIX}:*`);
  if (stale.length) await redis.del(...stale);
  redis.disconnect();

  queue = createQueue({ prefix: PREFIX, backoffMs: 20 });
  workers = startWorkers(engines, { prefix: PREFIX, audit: { fetcher, mailer, queue, siteMode: 'live', writer } });
  app = await buildApp({ engines, queue, mailer, writer });
  owner = await signup('Lotus Partners', 'owner@lotus-partners.example');

  const client = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Blue Lotus Dental', domain: 'bluelotus.example', vertical: 'Dental clinic', voice: 'Friendly and plain. We say "we", never "the clinic".' } })).json.client;
  clientId = client.id;
  await call('POST', `/v1/clients/${clientId}/competitors`, { ...owner, body: { name: 'Smile Studio', domain: 'smilestudio.example' } });
  await call('POST', `/v1/clients/${clientId}/competitors`, { ...owner, body: { name: 'Pearl Clinic', domain: 'pearl.example' } });
  const added = await call('POST', `/v1/clients/${clientId}/prompts`, {
    ...owner,
    body: { prompts: [{ text: 'Best dentist in Pune', priority: true }, { text: 'How much do dental implants cost' }, { text: 'Teeth whitening near me' }, { text: 'Kids dentist Pune' }] },
  });
  for (const p of added.json.added) promptIds[p.text.split(' ')[0]] = p.id;
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('generators built by rules', () => {
  test('the robots.txt fix allows the blocked crawlers and keeps every other rule', () => {
    const patched = patchRobots(ROBOTS, ['PerplexityBot']);
    assert.match(patched, /^# Lets AI search crawlers read the site/);
    assert.match(patched, /User-agent: PerplexityBot\nAllow: \/\n/);
    assert.ok(!/User-agent: PerplexityBot\nDisallow/.test(patched), 'the old block is gone');
    assert.match(patched, /User-agent: GPTBot\nDisallow: \//, 'training crawlers are left as they were');
    assert.match(patched, /User-agent: \*\nDisallow: \/admin/);
    assert.match(patched, /Sitemap: https:\/\/bluelotus\.example\/sitemap\.xml/);
  });

  test('a shared group keeps its other crawlers, and a missing file becomes a new one', () => {
    const shared = patchRobots('User-agent: OAI-SearchBot\nUser-agent: CCBot\nDisallow: /\n', ['OAI-SearchBot']);
    assert.match(shared, /User-agent: CCBot\nDisallow: \//);
    assert.equal((shared.match(/OAI-SearchBot/g) ?? []).length, 2, 'once in the comment, once in the new group');
    assert.match(patchRobots(null, ['OAI-SearchBot']), /User-agent: \*\nAllow: \/\n$/);
  });

  test('FAQ answers are escaped in the HTML and the JSON-LD cannot close its script tag', () => {
    const out = faqHtml(parseFaqs('Here you go:\n```json\n{"faqs":[{"question":"Q1?","answer":"A </script><b>1</b>"},{"question":"Q2?","answer":"A2"}]}\n```'));
    assert.match(out, /<p>A &lt;\/script&gt;&lt;b&gt;1&lt;\/b&gt;<\/p>/);
    const ld = out.slice(out.indexOf('<script type="application/ld+json">') + 35, out.lastIndexOf('</script>'));
    assert.ok(!ld.includes('</script>'));
    assert.equal(JSON.parse(ld)['@type'], 'FAQPage');
    assert.equal(JSON.parse(ld).mainEntity[0].acceptedAnswer.text, 'A </script><b>1</b>');
    assert.throws(() => parseFaqs('{"faqs":[{"question":"only one","answer":"a"}]}'), /fewer than two/);
  });
});

describe('the writing model', () => {
  let server: Server;
  const seen: { path: string; headers: IncomingMessage['headers']; body: any }[] = [];
  before(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen.push({ path: req.url!, headers: req.headers, body: JSON.parse(data) });
        const out = req.url!.startsWith('/anthropic')
          ? { content: [{ type: 'text', text: 'From Claude.' }], usage: { input_tokens: 7, output_tokens: 3 } }
          : req.url!.startsWith('/openai')
            ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'From OpenAI.' }] }], usage: { input_tokens: 5, output_tokens: 2 } }
            : { candidates: [{ content: { parts: [{ text: 'From Gemini.' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server.listen(4599, '127.0.0.1', r));
  });
  after(() => {
    server.close();
    for (const k of ['WRITER_PROVIDER', 'WRITER_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL']) delete process.env[k];
  });
  const request = { system: 'Be brief.', prompt: 'Say hi.', maxTokens: 50 };

  test('OpenAI is the default and reuses the ChatGPT key and model', async () => {
    assert.match(createLiveWriter().missing()!, /No OpenAI API key/);
    Object.assign(process.env, { OPENAI_API_KEY: 'sk-openai-test-1234', OPENAI_MODEL: 'gpt-test' });
    const out = await createLiveWriter().write(request, AbortSignal.timeout(5000));
    assert.deepEqual([out.text, out.model, out.tokensIn], ['From OpenAI.', 'gpt-test', 5]);
    const last = seen.at(-1)!;
    assert.equal(last.path, '/openai/v1/responses');
    assert.equal(last.headers.authorization, 'Bearer sk-openai-test-1234');
    assert.deepEqual([last.body.instructions, last.body.input, last.body.max_output_tokens, last.body.tools], ['Be brief.', 'Say hi.', 50, undefined], 'no web search for writing');
  });

  test('Claude needs its own key and model, and uses the Messages API', async () => {
    process.env.WRITER_PROVIDER = 'anthropic';
    assert.match(createLiveWriter().missing()!, /No Claude \(Anthropic\) API key/);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-5678';
    assert.match(createLiveWriter().missing()!, /No writing model/);
    process.env.WRITER_MODEL = 'claude-test';
    const out = await createLiveWriter().write(request, AbortSignal.timeout(5000));
    assert.deepEqual([out.text, out.model, out.tokensOut], ['From Claude.', 'claude-test', 3]);
    const last = seen.at(-1)!;
    assert.equal(last.path, '/anthropic/v1/messages');
    assert.deepEqual([last.headers['x-api-key'], last.headers['anthropic-version']], ['sk-ant-test-5678', '2023-06-01']);
    assert.deepEqual([last.body.model, last.body.system, last.body.max_tokens, last.body.messages], ['claude-test', 'Be brief.', 50, [{ role: 'user', content: 'Say hi.' }]]);
  });

  test('Gemini sends the instructions as a system instruction', async () => {
    Object.assign(process.env, { WRITER_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIza-test-9999', WRITER_MODEL: '' , GEMINI_MODEL: 'gemini-test' });
    const out = await createLiveWriter().write(request, AbortSignal.timeout(5000));
    assert.equal(out.text, 'From Gemini.');
    const last = seen.at(-1)!;
    assert.equal(last.path, '/gemini/v1beta/models/gemini-test:generateContent');
    assert.equal(last.body.systemInstruction.parts[0].text, 'Be brief.');
    assert.equal(last.body.tools, undefined);
  });
});

describe('suggested actions', () => {
  test('a run’s diagnosis becomes a queue, sorted by impact, with priority questions counting double', async () => {
    await runAndWait();
    const q = await queueNow();
    const keys = await ownerPool.query(`SELECT key, type, impact_score::float AS impact FROM actions WHERE client_id = $1 ORDER BY key`, [clientId]);
    assert.deepEqual(
      keys.rows.map((r) => [r.key.replace(promptIds.How!, 'P2'), r.type, r.impact]),
      [
        ['content:P2', 'new_content', 1],
        ['faq', 'schema', 1],
        ['fix:llms', 'technical_fix', 0],
        ['fix:robots', 'technical_fix', 2],
        ['site:bestof.example', 'off_site_outreach', 2],
        ['site:yelp.com', 'profile_review', 2],
      ],
    );
    assert.deepEqual(q.actions.map((a: any) => a.impact), [...q.actions.map((a: any) => a.impact)].sort((x, y) => y - x));
    assert.ok(q.actions.every((a: any) => a.status === 'suggested'));

    const robots = await byKey('fix:robots');
    assert.equal(robots.title, 'Let AI search crawlers read bluelotus.example');
    assert.match(robots.rationale, /blocks PerplexityBot, so Perplexity can’t read or cite the site/);
    assert.deepEqual(robots.prompts.map((p: any) => p.text), ['Best dentist in Pune']);
    assert.deepEqual(robots.generators.map((g: any) => [g.kind, g.credits]), [['robots_patch', 0]]);

    const bestof = await byKey('site:bestof.example');
    assert.equal(bestof.title, 'Get Blue Lotus Dental into “Best dentists in Pune for 2026” on bestof.example');
    assert.match(bestof.rationale, /^Cited in \d+ answers to 1 lost question that named Smile Studio instead\. The page doesn’t list Blue Lotus Dental\./);
    assert.equal(bestof.effort, 'M');

    const content = await byKey(`content:${promptIds.How}`);
    assert.equal(content.title, 'Publish a page that answers “How much do dental implants cost”');
    assert.deepEqual(content.generators.map((g: any) => g.kind), ['brief', 'draft', 'faq_schema']);

    const mail = mails.at(-1)!;
    assert.match(mail.text, /6 new suggested actions are waiting in the queue/);
  });

  test('a later run updates open actions instead of adding them again', async () => {
    const before = (await queueNow()).actions.length;
    const runId = await runAndWait();
    const after = await queueNow();
    assert.equal(after.actions.length, before);
    const { rows } = await ownerPool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE last_run_id = $2)::int AS fresh FROM actions WHERE client_id = $1`, [clientId, runId]);
    assert.deepEqual([rows[0].n, rows[0].fresh], [6, 6]);
    assert.ok(!/new suggested/.test(mails.at(-1)!.text));
  });
});

describe('from a lost question to a finished fix (PRD exit check)', () => {
  let actionId: string;
  let briefId: string;

  test('nothing is produced before the action is approved', async () => {
    actionId = (await byKey(`content:${promptIds.How}`)).id;
    const early = await call('POST', `/v1/actions/${actionId}/assets`, { ...owner, body: { kind: 'brief' } });
    assert.equal(early.status, 409);
    const approved = await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'approved' } });
    assert.equal(approved.json.action.status, 'approved');
    assert.equal(approved.json.action.approvedBy, 'Owner');
    assert.equal((await call('POST', `/v1/actions/${actionId}/assets`, { ...owner, body: { kind: 'robots_patch' } })).status, 400, 'only the generators that fit the action');
  });

  test('a brief is written from the evidence and the client’s voice, for its credits', async () => {
    const before = await credits();
    const started = await call('POST', `/v1/actions/${actionId}/assets`, { ...owner, body: { kind: 'brief' } });
    assert.equal(started.status, 202);
    assert.equal(started.json.asset.credits, 2);
    briefId = started.json.asset.id;
    assert.equal((await generated(briefId)).status, 'done');
    assert.equal(await credits(), before - 2);
    assert.equal((await byKey(`content:${promptIds.How}`)).status, 'in_progress', 'starting work moves it along');

    const req = asked.at(-1)!;
    assert.match(req.system, /Never invent facts about the business/);
    assert.match(req.system, /\[ADD: price range/);
    assert.match(req.prompt, /“How much do dental implants cost”/);
    assert.match(req.prompt, /Named instead: Smile Studio/);
    assert.match(req.prompt, /We say "we", never "the clinic"/);
    assert.match(req.prompt, /Category: Dental clinic/);
  });

  test('the draft follows the latest brief', async () => {
    const started = await call('POST', `/v1/actions/${actionId}/assets`, { ...owner, body: { kind: 'draft' } });
    await generated(started.json.asset.id);
    assert.match(asked.at(-1)!.prompt, /Follow this brief:\n\n## Goal\nAnswer the implant cost question/);
  });

  test('an edit is a new version, and the old one is kept', async () => {
    const edited = '## Goal\nAnswer the implant cost question.\n\nPrices start at ₹30,000.\n';
    const saved = await call('PUT', `/v1/actions/${actionId}/assets/brief`, { ...owner, body: { content: edited } });
    assert.deepEqual([saved.status, saved.json.version], [200, 2]);
    const latest = await call('GET', `/v1/actions/${actionId}/assets/brief`, owner);
    assert.deepEqual(latest.json.versions.map((v: any) => [v.version, v.origin]), [[2, 'edited'], [1, 'generated']]);
    assert.equal(latest.json.current.content, edited);
    const first = await call('GET', `/v1/actions/${actionId}/assets/brief?version=1`, owner);
    assert.match(first.json.current.content, /\[ADD: price range\]/);
  });

  test('it exports as a file, never shown inline', async () => {
    const latest = await call('GET', `/v1/actions/${actionId}/assets/brief`, owner);
    const file = await call('GET', `/v1/assets/${latest.json.current.id}/download`, owner);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-disposition'], 'attachment; filename="publish-a-page-that-answers-how-much-do-dental-implants-cost-brief-v2.md"');
    assert.match(String(file.headers['content-type']), /^text\/markdown/);
    assert.match(String(file.headers['content-security-policy']), /sandbox/);
    assert.match(file.body, /Prices start at ₹30,000/);
  });

  test('done needs the live URL or a note, and records when', async () => {
    assert.equal((await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'done' } })).status, 400);
    assert.equal((await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'done', doneUrl: 'javascript:alert(1)' } })).status, 400);
    const done = await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'done', doneUrl: 'https://bluelotus.example/dental-implants-cost' } });
    assert.equal(done.json.action.status, 'done');
    assert.equal(done.json.action.doneUrl, 'https://bluelotus.example/dental-implants-cost');
    assert.ok(Date.now() - new Date(done.json.action.doneAt).getTime() < 10_000);
    assert.deepEqual(done.json.action.prompts.map((p: any) => p.text), ['How much do dental implants cost'], 'the question it should move stays linked');
  });
});

describe('other generators', () => {
  const approve = async (key: string) => {
    const a = await byKey(key);
    await call('PATCH', `/v1/actions/${a.id}`, { ...owner, body: { status: 'approved' } });
    return a.id as string;
  };
  const make = async (actionId: string, kind: string) => {
    const started = await call('POST', `/v1/actions/${actionId}/assets`, { ...owner, body: { kind } });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    await generated(started.json.asset.id);
    return (await call('GET', `/v1/actions/${actionId}/assets/${kind}`, owner)).json;
  };

  test('the robots.txt fix is built from the live file, for no credits', async () => {
    const id = await approve('fix:robots');
    const before = await credits();
    const out = await make(id, 'robots_patch');
    assert.match(out.current.content, /User-agent: PerplexityBot\nAllow: \//);
    assert.match(out.current.content, /User-agent: GPTBot\nDisallow: \//);
    assert.equal(await credits(), before);
    const file = await call('GET', `/v1/assets/${out.current.id}/download`, owner);
    assert.equal(file.headers['content-disposition'], 'attachment; filename="robots.txt"');
  });

  test('llms.txt lists the pages from the sitemap', async () => {
    const out = await make(await approve('fix:llms'), 'llms_txt');
    assert.match(out.current.content, /^# Blue Lotus Dental\n\n> Blue Lotus Dental is a dental clinic\. \[ADD:/);
    assert.match(out.current.content, /- \[Services: Teeth whitening\]\(https:\/\/bluelotus\.example\/services\/teeth-whitening\)/);
    assert.match(out.current.content, /- \[About us\]\(https:\/\/bluelotus\.example\/about-us\)/);
  });

  test('the FAQ comes back as a section and FAQPage JSON-LD', async () => {
    const out = await make(await approve('faq'), 'faq_schema');
    assert.match(out.current.content, /<h3>How much do implants cost\?<\/h3>/);
    assert.match(out.current.content, /"@type": "FAQPage"/);
  });

  test('a failed write is marked failed and its credits come back', async () => {
    const id = await approve('site:bestof.example');
    const before = await credits();
    failNext = true;
    const started = await call('POST', `/v1/actions/${id}/assets`, { ...owner, body: { kind: 'outreach_email' } });
    const asset = await generated(started.json.asset.id);
    assert.equal(asset.status, 'failed');
    assert.match(asset.error, /529/);
    assert.equal(await credits(), before);
    const { rows } = await ownerPool.query(`SELECT reason, delta FROM credit_ledger WHERE asset_id = $1 ORDER BY created_at`, [asset.id]);
    assert.deepEqual(rows.map((r) => [r.reason, r.delta]), [['asset_reserved', -1], ['asset_refund', 1]]);
    // Trying again works, as version 2.
    const out = await make(id, 'outreach_email');
    assert.equal(out.current.version, 2);
    assert.match(asked.at(-1)!.prompt, /“Best dentists in Pune for 2026” https:\/\/www\.bestof\.example\/best-dentists-pune/);
  });

  test('without enough credits nothing is reserved', async () => {
    const id = (await byKey(`content:${promptIds.How}`)).id;
    await call('PATCH', `/v1/actions/${id}`, { ...owner, body: { status: 'in_progress' } });
    await ownerPool.query(`INSERT INTO credit_ledger (agency_id, delta, reason, note) VALUES ($1, $2, 'adjustment', 'test')`, [owner.agencyId, -(await credits())]);
    const res = await call('POST', `/v1/actions/${id}/assets`, { ...owner, body: { kind: 'draft' } });
    assert.equal(res.status, 402);
    const { rows } = await ownerPool.query(`SELECT count(*)::int AS n FROM assets WHERE action_id = $1 AND kind = 'draft'`, [id]);
    assert.equal(rows[0].n, 1, 'no new version was created');
    await ownerPool.query(`DELETE FROM credit_ledger WHERE note = 'test'`);
  });
});

describe('dismissing and resolving', () => {
  test('a dismissed action is not suggested again for 90 days', async () => {
    const yelp = await byKey('site:yelp.com');
    await call('PATCH', `/v1/actions/${yelp.id}`, { ...owner, body: { status: 'dismissed' } });
    await runAndWait();
    const { rows } = await ownerPool.query(`SELECT status FROM actions WHERE client_id = $1 AND key = 'site:yelp.com' ORDER BY created_at`, [clientId]);
    assert.deepEqual(rows.map((r) => r.status), ['dismissed']);

    await ownerPool.query(`UPDATE actions SET dismissed_at = now() - interval '91 days' WHERE id = $1`, [yelp.id]);
    await runAndWait();
    const again = await ownerPool.query(`SELECT status FROM actions WHERE client_id = $1 AND key = 'site:yelp.com' ORDER BY created_at`, [clientId]);
    assert.deepEqual(again.rows.map((r) => r.status), ['dismissed', 'suggested']);
  });

  test('untouched suggestions the latest run no longer supports are closed as resolved; work in hand is kept', async () => {
    round = 3; // "Best dentist in Pune" is now won
    await runAndWait();
    const { rows } = await ownerPool.query(`SELECT key, status, dismiss_reason FROM actions WHERE client_id = $1 ORDER BY key, created_at`, [clientId]);
    const state = Object.fromEntries(rows.map((r) => [r.key.replace(promptIds.How!, 'P2'), `${r.status}${r.dismiss_reason ? `:${r.dismiss_reason}` : ''}`]));
    assert.equal(state['site:yelp.com'], 'dismissed:resolved', 'the newest yelp suggestion was untouched');
    assert.equal(state['fix:robots'], 'in_progress', 'work already started is not closed');
    assert.equal(state['site:bestof.example'], 'in_progress');
    assert.equal(state['content:P2'], 'in_progress');
  });

  test('statuses only move along allowed paths', async () => {
    const yelp = (await queueNow()).actions.find((a: any) => a.title.includes('reviews'));
    const res = await call('PATCH', `/v1/actions/${yelp.id}`, { ...owner, body: { status: 'done', doneNote: 'x' } });
    assert.equal(res.status, 409);
  });
});

describe('access', () => {
  test('another agency can’t see or touch the queue', async () => {
    const other = await signup('Other Agency', 'owner@other.example');
    const anAction = (await queueNow()).actions[0];
    const asset = (await ownerPool.query(`SELECT id FROM assets WHERE client_id = $1 AND status = 'done' LIMIT 1`, [clientId])).rows[0];
    assert.equal((await call('GET', `/v1/clients/${clientId}/actions`, other)).status, 404);
    assert.equal((await call('PATCH', `/v1/actions/${anAction.id}`, { ...other, body: { status: 'dismissed' } })).status, 404);
    assert.equal((await call('GET', `/v1/assets/${asset.id}/download`, other)).status, 404);
    assert.equal((await call('POST', `/v1/actions/${anAction.id}/assets`, { ...other, body: { kind: 'brief' } })).status, 404);
    const rows = await withTenant({ agencyId: other.agencyId }, (db) => db.query(`SELECT 1 FROM actions UNION ALL SELECT 1 FROM assets UNION ALL SELECT 1 FROM action_prompts`));
    assert.equal(rows.rows.length, 0);
  });

  test('client viewers can’t open the queue, and the database agrees', async () => {
    await ownerPool.query(
      `INSERT INTO users (agency_id, client_id, email, name, password_hash, role) VALUES ($1, $2, 'viewer@bluelotus.example', 'Viewer', $3, 'client_viewer')`,
      [owner.agencyId, clientId, await hashPassword(PASSWORD)],
    );
    const login = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'viewer@bluelotus.example', password: PASSWORD } });
    const viewer = { host: owner.host, cookie: login.cookie! };
    assert.equal((await call('GET', `/v1/clients/${clientId}/actions`, viewer)).status, 403);
    const rows = await withTenant({ agencyId: owner.agencyId, clientId }, (db) => db.query(`SELECT 1 FROM actions UNION ALL SELECT 1 FROM assets`));
    assert.equal(rows.rows.length, 0);
  });

  test('only someone on the team can own an action', async () => {
    const a = (await queueNow()).actions[0];
    const viewerId = (await ownerPool.query(`SELECT id FROM users WHERE email = 'viewer@bluelotus.example'`)).rows[0].id;
    assert.equal((await call('PATCH', `/v1/actions/${a.id}`, { ...owner, body: { ownerUserId: viewerId } })).status, 400);
    const me = (await ownerPool.query(`SELECT id FROM users WHERE email = 'owner@lotus-partners.example' AND agency_id = $1`, [owner.agencyId])).rows[0].id;
    const res = await call('PATCH', `/v1/actions/${a.id}`, { ...owner, body: { ownerUserId: me } });
    assert.equal(res.json.action.owner.name, 'Owner');
  });
});
