import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { closePools, ownerPool } from '../src/db.js';
import type { EngineAdapter, EngineSet } from '../src/engines.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-overview`;

// Every answer names the client while `naming` is on; switched off to make visibility drop.
let naming = true;
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [
      key,
      {
        key,
        ask: async () => ({
          text: naming ? 'Blue Lotus Dental and Smile Studio are both good.' : 'Smile Studio is the top choice.',
          citations: [],
          tokensIn: 10,
          tokensOut: 10,
          costUsd: null,
          model: 'test',
        }),
      },
    ]),
  ),
};
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => ({ url, finalUrl: url, status: 404, contentType: 'text/html', body: '' });
const mailer = { enabled: false, async send() {} };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let owner: { host: string; cookie: string; agencyId: string };
let lotus: string;
let coral: string;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({ method, url, headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, cookie: sid ? `sid=${sid.value}` : undefined };
}

async function runAndWait(id: string) {
  const started = await call('POST', `/v1/clients/${id}/runs`, owner);
  assert.equal(started.status, 202);
  for (let i = 0; i < 600; i++) {
    const { rows } = await ownerPool.query(`SELECT status FROM runs WHERE id = $1`, [started.json.run.id]);
    if (rows[0].status === 'completed') return started.json.run.id as string;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}
const overview = async (who = owner) => (await call('GET', '/v1/overview', who)).json;

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

  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName: 'Lumen Partners', name: 'Owner', email: 'owner@lumen-partners.example', password: PASSWORD } });
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  owner = { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId };
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('dashboard overview', () => {
  test('an empty workspace has zeros, not errors, and eight empty weeks', async () => {
    const o = await overview();
    assert.equal(o.kpis.visibility.rate, null);
    assert.deepEqual([o.kpis.visits.last28, o.kpis.questions.active, o.kpis.attention.clients], [0, 0, 0]);
    assert.equal(o.trend.weeks.length, 8);
    assert.deepEqual(o.health, { healthy: 0, watch: 0, attention: 0 });
    assert.deepEqual([o.clients, o.activity], [[], []]);
  });

  test('a client with questions but no run needs attention, with the reason', async () => {
    lotus = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Blue Lotus Dental', domain: 'bluelotus.example' } })).json.client.id;
    await call('POST', `/v1/clients/${lotus}/competitors`, { ...owner, body: { name: 'Smile Studio', domain: 'smilestudio.example' } });
    await call('POST', `/v1/clients/${lotus}/prompts`, { ...owner, body: { prompts: [{ text: 'Best dentist in Pune' }, { text: 'Dental implants cost' }] } });
    const o = await overview();
    assert.deepEqual([o.clients[0].health, o.clients[0].reason], ['attention', 'No completed run yet']);
    assert.equal(o.kpis.questions.active, 2);
  });

  test('after a run: visibility matches the tracker’s own count, and the run shows in the trend and activity', async () => {
    const runId = await runAndWait(lotus);
    const o = await overview();
    const vis = (await call('GET', `/v1/clients/${lotus}/visibility`, owner)).json.visibility.totals;
    assert.deepEqual([o.kpis.visibility.answers, o.kpis.visibility.mentioned], [vis.answers, vis.mentioned]);
    assert.equal(o.kpis.visibility.rate, 1);
    assert.equal(o.clients[0].health, 'healthy');
    assert.equal(o.clients[0].shareOfVoice, 0.5, 'named alongside one competitor in every answer');
    const thisWeek = o.trend.weeks.at(-1);
    assert.deepEqual(thisWeek.engines.chatgpt, { answers: 6, mentioned: 6 });
    assert.deepEqual([o.activity[0].kind, o.activity[0].ref, o.activity[0].mentioned], ['run', runId, 18]);
  });

  test('a drop of 10 points or more since the previous run needs attention', async () => {
    naming = false;
    await runAndWait(lotus);
    naming = true;
    const o = await overview();
    const c = o.clients[0];
    assert.equal(c.visibility, 0);
    assert.equal(c.change, -1);
    assert.deepEqual([c.health, c.reason], ['attention', 'Visibility down 100 points']);
    assert.equal(o.kpis.visibility.previous, 1);
    assert.equal(o.kpis.attention.clients, 1);
  });

  test('no completed run for 14 days needs attention; paused clients are left out', async () => {
    await runAndWait(lotus);
    assert.equal((await overview()).clients[0].health, 'healthy');
    await ownerPool.query(`UPDATE runs SET finished_at = now() - interval '20 days', created_at = now() - interval '20 days' WHERE client_id = $1`, [lotus]);
    const o = await overview();
    assert.deepEqual([o.clients[0].health, o.clients[0].reason], ['attention', 'No run for 20 days']);

    coral = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Coral Smiles', domain: 'coral.example' } })).json.client.id;
    await call('PATCH', `/v1/clients/${coral}`, { ...owner, body: { status: 'paused' } });
    assert.deepEqual((await overview()).clients.map((c: any) => c.name), ['Blue Lotus Dental']);
  });

  test('AI visits count the last 28 days against the 28 before, test visits excluded', async () => {
    const insert = (daysAgo: number, isTest = false) =>
      ownerPool.query(
        `INSERT INTO ai_visits (agency_id, client_id, occurred_at, source_engine, via, landing_url, landing_path, session_hash, is_test)
         VALUES ($1, $2, now() - make_interval(days => $3), 'chatgpt', 'referrer', 'https://bluelotus.example/', '/', repeat('a', 64), $4)`,
        [owner.agencyId, lotus, daysAgo, isTest],
      );
    await Promise.all([insert(1), insert(5), insert(27), insert(3, true), insert(30), insert(60)]);
    const o = await overview();
    assert.deepEqual(o.kpis.visits, { last28: 3, previous28: 1 });
    assert.equal(o.clients[0].visits, 3);
  });

  test('a client viewer sees only their own client', async () => {
    await call('PATCH', `/v1/clients/${coral}`, { ...owner, body: { status: 'active' } });
    await ownerPool.query(
      `INSERT INTO users (agency_id, client_id, email, name, password_hash, role) VALUES ($1, $2, 'viewer@coral.example', 'Viewer', $3, 'client_viewer')`,
      [owner.agencyId, coral, await hashPassword(PASSWORD)],
    );
    const viewer = { host: owner.host, cookie: (await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'viewer@coral.example', password: PASSWORD } })).cookie! };
    const o = await overview(viewer as typeof owner);
    assert.deepEqual(o.clients.map((c: any) => c.name), ['Coral Smiles']);
    assert.equal(o.kpis.visits.last28, 0);
    assert.ok(o.activity.every((a: any) => a.client === 'Coral Smiles'));
    assert.equal((await call('GET', '/v1/overview', { host: owner.host })).status, 401);
  });
});
