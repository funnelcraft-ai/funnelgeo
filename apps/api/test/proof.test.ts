import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { appPool, closePools, ownerPool, withTenant } from '../src/db.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { labelFor } from '../src/proof/compare.js';
import { buildCollector } from '../src/proof/collector.js';
import { detectSource } from '../src/proof/sources.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-proof`;
const SMILE_PAGE = 'https://smilestudio.example/best-dentist-pune';

// Round 1: the client is never named. Round 2: it is named everywhere.
let round = 1;
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 5, tokensOut: 20, costUsd: null });
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [
      key,
      { key, ask: async () => (round === 1 ? answer('Smile Studio is the top choice.', [SMILE_PAGE]) : answer('Blue Lotus Dental is the top choice.', ['https://bluelotus.example/best-dentist-pune'])) },
    ]),
  ),
};
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => ({ url, finalUrl: url, status: 404, contentType: 'text/html', body: '' });
const mails: Mail[] = [];
const mailer = { enabled: true, async send(mail: Mail) { mails.push(mail); } };

let app: FastifyInstance;
let collector: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let owner: { host: string; cookie: string; agencyId: string };
let clientId: string;
let siteKey: string;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({ method, url, headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, cookie: sid ? `sid=${sid.value}` : undefined };
}

/** What the snippet sends, as the browser's sendBeacon would: text/plain. */
async function beacon(body: Record<string, unknown>, ip = '203.0.113.7') {
  const res = await collector.inject({ method: 'POST', url: '/c', headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': ip }, payload: JSON.stringify(body) });
  return res.statusCode;
}
const view = (u: string, r: string, i = 'tab-aaaaaa', extra: Record<string, unknown> = {}) => beacon({ s: siteKey, e: 'view', u, r, i, ...extra });
const visits = async (who = owner, id = clientId) => (await call('GET', `/v1/clients/${id}/visits`, who)).json;

async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId as string };
}

async function runAndWait() {
  const started = await call('POST', `/v1/clients/${clientId}/runs`, owner);
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const runId = started.json.run.id;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await ownerPool.query(`SELECT status FROM diagnoses WHERE run_id = $1`, [runId]);
    if (rows[0]?.status === 'done') return runId as string;
    assert.ok(Date.now() < deadline, 'run did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
  workers = startWorkers(engines, { prefix: PREFIX, audit: { fetcher, mailer, queue, siteMode: 'live' } });
  app = await buildApp({ engines, queue, mailer });
  collector = await buildCollector();
  owner = await signup('Lotus Partners', 'owner@lotus-partners.example');
  const client = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Blue Lotus Dental', domain: 'bluelotus.example' } })).json.client;
  clientId = client.id;
  await call('POST', `/v1/clients/${clientId}/competitors`, { ...owner, body: { name: 'Smile Studio', domain: 'smilestudio.example' } });
  await call('POST', `/v1/clients/${clientId}/prompts`, { ...owner, body: { prompts: [{ text: 'Best dentist in Pune' }] } });
  siteKey = (await visits()).snippet.tag.match(/data-site="([a-f0-9]{32})"/)[1];
});

after(async () => {
  await workers.close();
  await queue.close();
  await collector.close();
  await app.close();
  await closePools();
});

describe('recognising AI assistants', () => {
  test('by referring site, including subdomains, or by utm_source', () => {
    assert.deepEqual(detectSource('https://chatgpt.com/', 'https://x.example/'), { key: 'chatgpt', via: 'referrer' });
    assert.deepEqual(detectSource('https://www.perplexity.ai/search/abc', 'https://x.example/'), { key: 'perplexity', via: 'referrer' });
    assert.deepEqual(detectSource('https://gemini.google.com/app', 'https://x.example/'), { key: 'gemini', via: 'referrer' });
    assert.deepEqual(detectSource('', 'https://x.example/page?utm_source=chatgpt.com'), { key: 'chatgpt', via: 'utm' });
    assert.deepEqual(detectSource('https://claude.ai/chat/1', 'https://x.example/'), { key: 'claude', via: 'referrer' });
  });

  test('ordinary search and look-alike hosts are not', () => {
    assert.equal(detectSource('https://www.google.com/', 'https://x.example/'), null, 'AI Overviews can’t be told apart from search');
    assert.equal(detectSource('https://notchatgpt.com/', 'https://x.example/'), null);
    assert.equal(detectSource('https://chatgpt.com.evil.example/', 'https://x.example/'), null);
    assert.equal(detectSource('not a url', 'https://x.example/?utm_source=newsletter'), null);
  });
});

describe('the tracking snippet', () => {
  test('the script is small, uses no cookies and carries the same list of AI sites', async () => {
    const res = await collector.inject({ method: 'GET', url: '/t.js' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^application\/javascript/);
    assert.ok(res.body.length < 4000, `${res.body.length} bytes`);
    assert.ok(!res.body.includes('document.cookie'));
    assert.match(res.body, /"chatgpt\.com"/);
    assert.match(res.body, /sendBeacon/);
  });

  test('the dashboard confirms the install from the first ping', async () => {
    assert.equal((await visits()).snippet.seenAt, null);
    assert.equal(await beacon({ s: siteKey, e: 'ping', u: 'https://bluelotus.example/', r: '', i: 'tab-ping01' }), 204);
    assert.ok((await visits()).snippet.seenAt);
  });

  test('a test visit from an AI referrer appears in the dashboard within a minute, outside the totals (PRD exit check)', async () => {
    const sent = Date.now();
    assert.equal(await view('https://bluelotus.example/?utm_source=chatgpt.com&fg_test=1', '', 'tab-test01', { t: 1 }), 204);
    const v = await visits();
    assert.ok(Date.now() - sent < 60_000);
    assert.deepEqual([v.recent[0].engine, v.recent[0].isTest, v.recent[0].path, v.recent[0].via], ['chatgpt', true, '/', 'utm']);
    assert.equal(v.totals.visits, 0, 'test visits are left out of the totals');
    assert.equal((await visits()).snippet.testUrl, 'https://bluelotus.example/?utm_source=chatgpt.com&fg_test=1');
  });

  test('a real visit keeps the page but drops the query string, except utm_source', async () => {
    await view('https://www.bluelotus.example/implants?gclid=secret&email=a%40b.c&utm_source=chatgpt.com', 'https://chatgpt.com/', 'tab-real01');
    const { rows } = await ownerPool.query(`SELECT * FROM ai_visits WHERE NOT is_test ORDER BY occurred_at DESC LIMIT 1`);
    assert.equal(rows[0].landing_url, 'https://www.bluelotus.example/implants?utm_source=chatgpt.com');
    assert.equal(rows[0].landing_path, '/implants');
    assert.equal(rows[0].via, 'referrer');
    assert.match(rows[0].session_hash, /^[a-f0-9]{64}$/);
    assert.ok(!Object.keys(rows[0]).some((k) => /ip|address|agent/.test(k)), 'no IP address or user agent is stored');
  });

  test('only AI visits that land on the client’s own site are kept', async () => {
    await view('https://bluelotus.example/', 'https://www.google.com/', 'tab-goog01');
    await view('https://attacker.example/', 'https://chatgpt.com/', 'tab-spoof1');
    await view('https://bluelotus.example.attacker.example/', 'https://chatgpt.com/', 'tab-spoof2');
    await view('javascript:alert(1)', 'https://chatgpt.com/', 'tab-spoof3');
    assert.equal(await beacon({ s: 'f'.repeat(32), e: 'view', u: 'https://bluelotus.example/', r: 'https://chatgpt.com/', i: 'tab-nokey1' }), 204, 'unknown keys get the same answer');
    assert.equal(await beacon({ junk: true }), 204);
    const big = await collector.inject({ method: 'POST', url: '/c', headers: { 'content-type': 'text/plain' }, payload: 'x'.repeat(10_000) });
    assert.equal(big.statusCode, 413);
    assert.equal((await visits()).totals.visits, 1);
  });

  test('a reload of the same page in the same tab is one visit; another tab is another', async () => {
    await view('https://bluelotus.example/pricing', 'https://www.perplexity.ai/', 'tab-perp01');
    await view('https://bluelotus.example/pricing', 'https://www.perplexity.ai/', 'tab-perp01');
    await view('https://bluelotus.example/pricing', 'https://www.perplexity.ai/', 'tab-perp02');
    const v = await visits();
    assert.deepEqual(v.byEngine.map((e: any) => [e.key, e.visits]), [['perplexity', 2], ['chatgpt', 1]]);
    assert.equal(v.totals.sessions, 3);
    assert.deepEqual(v.pages.map((p: any) => [p.path, p.visits]), [['/pricing', 2], ['/implants', 1]]);
    assert.equal(v.byDay.length, 30);
    assert.equal(v.byDay.at(-1).visits, 3);
  });

  test('a conversion counts only during a visit that came from AI', async () => {
    await beacon({ s: siteKey, e: 'convert', u: 'https://bluelotus.example/thanks', r: '', i: 'tab-perp02', n: 'Booking' });
    await beacon({ s: siteKey, e: 'convert', u: 'https://bluelotus.example/thanks', r: '', i: 'tab-nobody', n: 'Booking' });
    const v = await visits();
    assert.equal(v.totals.conversions, 1);
    assert.deepEqual(v.byEngine.find((e: any) => e.key === 'perplexity').conversions, 1);
    assert.equal(v.recent.find((r: any) => r.converted).conversionName, 'Booking');
  });

  test('prospects are not tracked, and a new site key stops the old snippet', async () => {
    const { rows } = await ownerPool.query(`INSERT INTO clients (agency_id, name, domain, status) VALUES ($1, 'Prospect', 'prospect.example', 'prospect') RETURNING site_key`, [owner.agencyId]);
    await beacon({ s: rows[0].site_key, e: 'view', u: 'https://prospect.example/', r: 'https://chatgpt.com/', i: 'tab-prosp1' });
    assert.equal((await ownerPool.query(`SELECT count(*)::int AS n FROM ai_visits WHERE landing_url LIKE '%prospect.example%'`)).rows[0].n, 0);

    const oldKey = siteKey;
    assert.equal((await call('POST', `/v1/clients/${clientId}/site-key`, owner)).status, 200);
    const fresh = (await visits()).snippet;
    assert.equal(fresh.seenAt, null);
    await beacon({ s: oldKey, e: 'view', u: 'https://bluelotus.example/old', r: 'https://chatgpt.com/', i: 'tab-old001' });
    assert.ok(!(await visits()).recent.some((r: any) => r.path === '/old'));
    siteKey = fresh.tag.match(/data-site="([a-f0-9]{32})"/)[1];
  });
});

describe('who can see visits', () => {
  test('another agency can’t, and no tenant can write visits', async () => {
    const other = await signup('Other Agency', 'owner@other.example');
    assert.equal((await call('GET', `/v1/clients/${clientId}/visits`, other)).status, 404);
    assert.equal((await withTenant({ agencyId: other.agencyId }, (db) => db.query(`SELECT * FROM ai_visits`))).rows.length, 0);
    await assert.rejects(
      withTenant({ agencyId: owner.agencyId }, (db) => db.query(`INSERT INTO ai_visits (agency_id, client_id, source_engine, via, landing_url, landing_path, session_hash) VALUES ($1, $2, 'chatgpt', 'utm', 'https://x', '/', $3)`, [owner.agencyId, clientId, 'a'.repeat(64)])),
      (err: any) => err.code === '42501',
    );
    void appPool;
  });

  test('the client’s viewers see their own visits but not the install details', async () => {
    await ownerPool.query(
      `INSERT INTO users (agency_id, client_id, email, name, password_hash, role) VALUES ($1, $2, 'viewer@bluelotus.example', 'Viewer', $3, 'client_viewer')`,
      [owner.agencyId, clientId, await hashPassword(PASSWORD)],
    );
    const login = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'viewer@bluelotus.example', password: PASSWORD } });
    const viewer = { host: owner.host, cookie: login.cookie!, agencyId: owner.agencyId };
    const v = await visits(viewer);
    assert.equal(v.snippet, null);
    assert.equal(v.totals.visits, 3);
    assert.equal((await call('POST', `/v1/clients/${clientId}/site-key`, viewer)).status, 403);
  });
});

describe('before and after a finished action', () => {
  test('labels need enough answers, a real change, and a change unlikely to be noise', () => {
    const s = (answers: number, named: number) => ({ answers, named, runs: 1, rate: answers ? named / answers : null });
    assert.equal(labelFor(s(5, 0), s(9, 9)), 'too_early');
    assert.equal(labelFor(s(9, 3), s(9, 4)), 'no_change');
    assert.equal(labelFor(s(9, 0), s(9, 6)), 'improved');
    assert.equal(labelFor(s(9, 9), s(9, 2)), 'declined');
    assert.equal(labelFor(s(100, 30), s(100, 41)), 'no_change', 'eleven points over 100 answers is still within noise');
    assert.equal(labelFor(s(100, 30), s(100, 44)), 'improved');
    assert.equal(labelFor(s(100, 30), s(100, 36)), 'no_change', 'six points is under the minimum change');
  });

  let actionId: string;

  test('a done action waits for the next run, then shows its comparison (PRD exit check)', async () => {
    await runAndWait();
    const { rows } = await ownerPool.query(`SELECT id FROM actions WHERE client_id = $1 AND key LIKE 'content:%'`, [clientId]);
    actionId = rows[0].id;
    await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'approved' } });
    const done = await call('PATCH', `/v1/actions/${actionId}`, { ...owner, body: { status: 'done', doneUrl: 'https://bluelotus.example/best-dentist-pune' } });
    const waiting = done.json.action.comparison;
    assert.equal(waiting.label, 'too_early');
    assert.equal(waiting.sentence, 'Waiting for the first completed run after the done date.');
    assert.equal(waiting.before.answers, 9);
    assert.equal(waiting.before.named, 0);

    // An AI visit to the published page, after the done date.
    await view('https://bluelotus.example/best-dentist-pune', 'https://chatgpt.com/', 'tab-after1');

    round = 2;
    await runAndWait();
    const list = await call('GET', `/v1/clients/${clientId}/actions`, owner);
    const c = list.json.actions.find((a: any) => a.id === actionId).comparison;
    assert.equal(c.label, 'improved');
    assert.equal(c.sentence, 'Blue Lotus Dental was named more often after this action: 0% of 9 answers before, 100% of 9 after so far.');
    assert.deepEqual([c.before.runs, c.after.runs, c.complete, c.windowDays], [1, 1, false, 28]);
    assert.deepEqual(c.byEngine.map((e: any) => [e.key, e.before.answers, e.after.named]), [['chatgpt', 3, 3], ['perplexity', 3, 3], ['gemini', 3, 3]]);
    assert.deepEqual(c.visits, { path: '/best-dentist-pune', before: 0, after: 1 });
  });

  test('only runs inside the four-week windows count', async () => {
    // Move the first run to six weeks before the done date: it falls out of the "before" window.
    const { rows } = await ownerPool.query(`SELECT done_at FROM actions WHERE id = $1`, [actionId]);
    const first = await ownerPool.query(`SELECT id FROM runs WHERE client_id = $1 ORDER BY created_at LIMIT 1`, [clientId]);
    await ownerPool.query(`UPDATE runs SET created_at = $2::timestamptz - interval '42 days' WHERE id = $1`, [first.rows[0].id, rows[0].done_at]);
    const list = await call('GET', `/v1/clients/${clientId}/actions`, owner);
    const c = list.json.actions.find((a: any) => a.id === actionId).comparison;
    assert.equal(c.label, 'too_early');
    assert.match(c.sentence, /^Too few answers from the four weeks before the done date to compare \(0; at least 6 needed\)\.$/);
  });
});
