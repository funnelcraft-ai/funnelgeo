import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerPool } from '../src/db.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { closeStuckRuns, runDueSchedules } from '../src/scheduler.js';
import { hashPassword } from '../src/security.js';
import { cleanUrl, domainOf, firstIndex, parseAnswer } from '../src/tracker/parse.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = process.env.QUEUE_PREFIX!;

// Scripted stand-ins for the three engines. Each test sets how they answer.
type Behaviour = (prompt: string, call: number) => EngineAnswer | Promise<EngineAnswer>;
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 10, tokensOut: 40, costUsd: null });
const numberOf = (prompt: string) => Number(prompt.match(/\d+/)?.[0] ?? 0);
const DEFAULTS: Record<string, Behaviour> = {
  // Names the competitor first, and the client on even-numbered prompts.
  chatgpt: (p) => answer(numberOf(p) % 2 === 0 ? 'Smile Studio is popular. Blue Lotus Dental is also recommended.' : 'Smile Studio is popular.'),
  // Uses an alias, and cites the client's site, on every fifth prompt.
  perplexity: (p) =>
    numberOf(p) % 5 === 0
      ? answer('Many people choose BlueLotus for this.', ['https://www.bluelotus.example/implants?utm_source=perplexity', 'https://reviews.example/top'])
      : answer('There are several good options nearby.', ['https://reviews.example/top']),
  // Never names the client; "Blue Lotusville" must not count as a mention.
  gemini: () => answer('Try Lotus Clinic, or drive out to Blue Lotusville.', ['https://www.smilestudio.example/', 'not a url']),
};
const behaviours: Record<string, Behaviour> = { ...DEFAULTS };
const calls = new Map<string, number>();
let sawMockContext = false;

const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [
      key,
      {
        key,
        async ask(prompt, _signal, mock) {
          if (mock) sawMockContext = true;
          const id = `${key}|${prompt}`;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          return behaviours[key]!(prompt, calls.get(id)!);
        },
      },
    ]),
  ),
};

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;

interface Who {
  host: string;
  cookie: string;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, opts: { host: string; cookie?: string; body?: unknown }, on = app) {
  const res = await on.inject({
    method,
    url,
    headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, cookie: sid ? `sid=${sid.value}` : undefined };
}

async function signup(agencyName: string, email: string): Promise<Who & { agencyId: string }> {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId };
}

/** A client set up like the PRD's exit check: one competitor, an alias and n prompts. */
async function setUpClient(who: Who, name: string, promptCount: number) {
  const client = (await call('POST', '/v1/clients', { ...who, body: { name, domain: 'bluelotus.example', brandAliases: ['BlueLotus'] } })).json.client;
  const competitor = (await call('POST', `/v1/clients/${client.id}/competitors`, { ...who, body: { name: 'Smile Studio', domain: 'https://www.smilestudio.example/' } })).json.competitor;
  const prompts = Array.from({ length: promptCount }, (_, i) => ({ text: `Prompt ${i + 1} about dentists`, ...(i === 0 ? { priority: true, intent: 'comparison' } : {}) }));
  const added = await call('POST', `/v1/clients/${client.id}/prompts`, { ...who, body: { prompts } });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  return { id: client.id as string, competitorId: competitor.id as string, promptIds: added.json.added.map((p: any) => p.id as string) };
}

async function startRun(who: Who, clientId: string) {
  const res = await call('POST', `/v1/clients/${clientId}/runs`, who);
  assert.equal(res.status, 202, JSON.stringify(res.json));
  return res.json.run as { id: string; totalCalls: number; credits: number };
}

async function finished(who: Who, runId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await call('GET', `/v1/runs/${runId}`, who);
    if (!['queued', 'running'].includes(json.run.status)) return json.run;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${json.run.status}: ${json.run.okCalls}+${json.run.failedCalls}/${json.run.totalCalls}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const remaining = async (who: Who) => (await call('GET', '/v1/credits', who)).json.remaining as number;
const visibility = async (who: Who, clientId: string, runId?: string) =>
  (await call('GET', `/v1/clients/${clientId}/visibility${runId ? `?run=${runId}` : ''}`, who)).json;

before(async () => {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await owner.connect();
  await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await owner.end();
  await migrate(process.env.DATABASE_OWNER_URL!, process.env.APP_DB_PASSWORD);

  const redis = new Redis(process.env.REDIS_URL!);
  const stale = await redis.keys(`${PREFIX}:*`);
  if (stale.length) await redis.del(...stale);
  redis.disconnect();

  queue = createQueue({ prefix: PREFIX, backoffMs: 20 });
  workers = startWorkers(engines, { prefix: PREFIX });
  app = await buildApp({ engines, queue, mailer: { enabled: false, async send() {} } });
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('answer parsing', () => {
  test('a name matches as a whole word, in any case, across line breaks', () => {
    assert.equal(firstIndex('I like Acme.', 'acme'), 7);
    assert.equal(firstIndex("Acme's team (ACME) is good", 'Acme'), 0);
    assert.equal(firstIndex('Visit Acmeville or MyAcme today', 'Acme'), -1);
    assert.equal(firstIndex('Blue\n  Lotus Dental', 'Blue Lotus Dental'), 0);
    assert.equal(firstIndex('C++ and A.B. Co (really)', 'A.B. Co'), 8);
    assert.equal(firstIndex('anything', 'a'), -1, 'one-letter names are ignored');
  });

  test('web addresses are cleaned and reduced to a site', () => {
    assert.equal(domainOf('https://WWW.Example.com/a?b=1'), 'example.com');
    assert.equal(domainOf('ftp://example.com'), null);
    assert.equal(domainOf('nonsense'), null);
    assert.equal(cleanUrl('https://example.com/a?utm_source=openai&x=1#top'), 'https://example.com/a?x=1');
  });

  test('brands are ranked by first appearance and citations de-duplicated', () => {
    const entities = [
      { competitorId: null, name: 'Blue Lotus Dental', aliases: ['BlueLotus'], domain: 'bluelotus.example' },
      { competitorId: 'k1', name: 'Smile Studio', aliases: [], domain: 'smilestudio.example' },
      { competitorId: 'k2', name: 'Never Named', aliases: [], domain: null },
    ];
    const parsed = parseAnswer('Smile Studio leads, then BlueLotus.', ['https://shop.bluelotus.example/x?utm_campaign=a', 'https://shop.bluelotus.example/x', 'https://other.example/', 42, 'mailto:a@b.c'], entities);
    assert.deepEqual(parsed.mentions, [{ competitorId: 'k1', position: 1 }, { competitorId: null, position: 2 }]);
    assert.deepEqual(parsed.citations, [
      { position: 1, url: 'https://shop.bluelotus.example/x', domain: 'shop.bluelotus.example', isClient: true },
      { position: 2, url: 'https://other.example/', domain: 'other.example', isClient: false },
    ]);
    // A bare domain in the text counts as naming the brand.
    assert.deepEqual(parseAnswer('See www.bluelotus.example for details', [], entities).mentions, [{ competitorId: null, position: 1 }]);
    assert.deepEqual(parseAnswer('', [], entities), { mentions: [], citations: [] });
  });
});

describe('tracking runs', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let client: Awaited<ReturnType<typeof setUpClient>>;
  let runId: string;

  before(async () => {
    a = await signup('Track Agency', 'owner@track.test');
    client = await setUpClient(a, 'Blue Lotus Dental', 25);
  });

  test('the workspace shows what a run will cost before it starts', async () => {
    const { json } = await call('GET', `/v1/clients/${client.id}/tracker`, a);
    assert.equal(json.prompts.length, 25);
    assert.equal(json.prompts[0].priority, true, 'priority prompts are listed first');
    assert.deepEqual(json.estimate, { callsPerRun: 225, creditsPerRun: 225, creditsPerMonth: 975 });
    assert.deepEqual(json.credits, { allowance: 5000, remaining: 5000 });
    assert.deepEqual(json.limits, { prompts: 25, competitors: 5, samples: 3 });
    assert.equal(json.engineMode, 'live');
  });

  test('a 25-prompt run completes unattended with the expected counts', async () => {
    const run = await startRun(a, client.id);
    assert.deepEqual({ totalCalls: run.totalCalls, credits: run.credits }, { totalCalls: 225, credits: 225 });
    runId = run.id;
    const done = await finished(a, run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual([done.okCalls, done.failedCalls], [225, 0]);
    assert.equal(await remaining(a), 5000 - 225);

    const { visibility: v, run: shown } = await visibility(a, client.id);
    assert.equal(shown.id, run.id);
    assert.deepEqual(v.totals, { answers: 225, mentioned: 51, cited: 15, failed: 0, pending: 0 });
    assert.deepEqual(
      v.engines.map((e: any) => [e.key, e.answers, e.mentioned, e.cited]),
      [['chatgpt', 75, 36, 0], ['perplexity', 75, 15, 15], ['gemini', 75, 0, 0]],
    );
    // Share of voice: the competitor is named in every ChatGPT answer, first.
    assert.deepEqual(v.brands.map((b: any) => [b.name, b.isClient, b.mentions, b.avgPosition]), [
      ['Smile Studio', false, 75, 1],
      ['Blue Lotus Dental', true, 51, 1.7],
    ]);
    const prompt10 = v.prompts.find((p: any) => p.text === 'Prompt 10 about dentists');
    assert.deepEqual(prompt10.engines, { chatgpt: { answers: 3, mentioned: 3 }, perplexity: { answers: 3, mentioned: 3 }, gemini: { answers: 3, mentioned: 0 } });
    assert.deepEqual([prompt10.answers, prompt10.mentioned], [9, 6]);
    assert.deepEqual(v.domains, [
      { domain: 'reviews.example', answers: 75, isClient: false, competitor: null },
      { domain: 'smilestudio.example', answers: 75, isClient: false, competitor: 'Smile Studio' },
      { domain: 'bluelotus.example', answers: 15, isClient: true, competitor: null },
    ]);
    assert.equal(sawMockContext, false, 'brand names are never handed to a live engine');
  });

  test('stored answers can be opened, with what was found in each', async () => {
    const promptId = (await visibility(a, client.id)).visibility.prompts.find((p: any) => p.text === 'Prompt 10 about dentists').id;
    const { json } = await call('GET', `/v1/runs/${runId}/answers?prompt=${promptId}`, a);
    assert.equal(json.answers.length, 9);
    const first = json.answers[0];
    assert.equal(first.engineKey, 'chatgpt');
    assert.equal(first.text, 'Smile Studio is popular. Blue Lotus Dental is also recommended.');
    assert.deepEqual(first.mentions, [{ name: 'Smile Studio', isClient: false, position: 1 }, { name: 'Blue Lotus Dental', isClient: true, position: 2 }]);
    const cited = json.answers.find((x: any) => x.engineKey === 'perplexity');
    assert.deepEqual(cited.citations[0], { url: 'https://www.bluelotus.example/implants', domain: 'bluelotus.example', isClient: true });
  });

  test('re-reading stored answers gives the same counts, and picks up a new alias', async () => {
    const before = await visibility(a, client.id);
    const again = await call('POST', `/v1/runs/${runId}/reparse`, a);
    assert.deepEqual(again.json, { reparsed: 225 });
    assert.deepEqual(await visibility(a, client.id), before);

    await call('PATCH', `/v1/clients/${client.id}`, { ...a, body: { brandAliases: ['BlueLotus', 'Lotus Clinic'] } });
    assert.deepEqual((await visibility(a, client.id)).visibility.totals, before.visibility.totals, 'nothing changes until the run is re-read');
    await call('POST', `/v1/runs/${runId}/reparse`, a);
    const after = await visibility(a, client.id);
    assert.equal(after.visibility.engines.find((e: any) => e.key === 'gemini').mentioned, 75);
    assert.equal(after.visibility.totals.mentioned, 126);
    await call('PATCH', `/v1/clients/${client.id}`, { ...a, body: { brandAliases: ['BlueLotus'] } });
    await call('POST', `/v1/runs/${runId}/reparse`, a);
    assert.deepEqual(await visibility(a, client.id), before);
  });

  test('a call that fails once is retried; one that keeps failing is refunded', async () => {
    const b = await signup('Retry Agency', 'owner@retry.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 4);
    behaviours.chatgpt = (p, n) => {
      if (n === 1) throw new Error('HTTP 503: try again');
      return DEFAULTS.chatgpt!(p, n);
    };
    behaviours.gemini = () => {
      throw new Error('HTTP 401: bad key');
    };
    behaviours.perplexity = (p, n) => (numberOf(p) === 1 ? answer('   ') : DEFAULTS.perplexity!(p, n));
    try {
      const run = await startRun(b, c.id);
      assert.equal(run.credits, 36);
      assert.equal(await remaining(b), 5000 - 36, 'the full cost is reserved up front');
      const done = await finished(b, run.id);
      assert.equal(done.status, 'completed');
      // ChatGPT recovers on retry (12 ok); Gemini fails all 12; Perplexity's empty answers fail 3.
      assert.deepEqual([done.okCalls, done.failedCalls, done.credits], [21, 15, 21]);
      assert.equal(done.note, '15 of 36 calls failed and were refunded');
      assert.equal(await remaining(b), 5000 - 21);

      const { json } = await call('GET', '/v1/credits', b);
      assert.deepEqual(json.entries.map((e: any) => [e.reason, e.delta, e.clientName]), [['run_refund', 15, 'Blue Lotus Dental'], ['run_reserved', -36, 'Blue Lotus Dental']]);
      const v = (await visibility(b, c.id)).visibility;
      assert.deepEqual(v.totals, { answers: 21, mentioned: 6, cited: 0, failed: 15, pending: 0 });
      const failedAnswer = (await call('GET', `/v1/runs/${run.id}/answers?prompt=${c.promptIds[0]}`, b)).json.answers.find((x: any) => x.engineKey === 'gemini');
      assert.deepEqual([failedAnswer.status, failedAnswer.error], ['failed', 'HTTP 401: bad key']);
    } finally {
      Object.assign(behaviours, DEFAULTS);
    }
  });

  test('a run where every call fails is marked failed and costs nothing', async () => {
    const b = await signup('Down Agency', 'owner@down.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 2);
    for (const key of Object.keys(behaviours)) behaviours[key] = () => { throw new Error('HTTP 500'); };
    try {
      const done = await finished(b, (await startRun(b, c.id)).id);
      assert.deepEqual([done.status, done.okCalls, done.failedCalls, done.credits], ['failed', 0, 18, 0]);
      assert.equal(await remaining(b), 5000);
      assert.deepEqual(await visibility(b, c.id), { run: null, visibility: null }, 'a failed run is not shown as the latest result');
    } finally {
      Object.assign(behaviours, DEFAULTS);
    }
  });

  test('only one run at a time per client, and none without credits, prompts or engines', async () => {
    const b = await signup('Guard Agency', 'owner@guard.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    behaviours.chatgpt = async (p, n) => {
      await gate;
      return DEFAULTS.chatgpt!(p, n);
    };
    try {
      const run = await startRun(b, c.id);
      const second = await call('POST', `/v1/clients/${c.id}/runs`, b);
      assert.deepEqual([second.status, second.json.error.code], [409, 'run_in_progress']);
      assert.equal((await call('POST', `/v1/runs/${run.id}/reparse`, b)).status, 409);
      release();
      assert.equal((await finished(b, run.id)).status, 'completed');
    } finally {
      release();
      Object.assign(behaviours, DEFAULTS);
    }

    // Drain the balance: 27 credits are needed, 20 are left.
    await ownerPool.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, $2, 'adjustment')`, [b.agencyId, -(5000 - 27 - 20)]);
    const broke = await call('POST', `/v1/clients/${c.id}/runs`, b);
    assert.deepEqual([broke.status, broke.json.error.code], [402, 'insufficient_credits']);
    assert.equal(broke.json.error.message, 'This run needs 27 credits and 20 are left this month. An owner can turn on top-up on the Usage page to go past the allowance.');
    assert.equal(await remaining(b), 20, 'a refused run reserves nothing');

    const empty = (await call('POST', '/v1/clients', { ...b, body: { name: 'No Prompts Co' } })).json.client;
    assert.equal((await call('POST', `/v1/clients/${empty.id}/runs`, b)).json.error.code, 'no_prompts');
    await call('PATCH', `/v1/clients/${c.id}`, { ...b, body: { status: 'paused' } });
    assert.equal((await call('POST', `/v1/clients/${c.id}/runs`, b)).json.error.code, 'client_paused');

    const noEngines = await buildApp({ engines: { mode: 'live', available: new Map() }, queue, mailer: { enabled: false, async send() {} } });
    await call('PATCH', `/v1/clients/${c.id}`, { ...b, body: { status: 'active' } });
    const refused = await call('POST', `/v1/clients/${c.id}/runs`, b, noEngines);
    assert.deepEqual([refused.status, refused.json.error.code], [409, 'no_engines']);
    await noEngines.close();
  });

  test('if the queue is down the run is cancelled and nothing is charged', async () => {
    const b = await signup('Queue Agency', 'owner@queue.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 2);
    const broken = await buildApp({ engines, queue: { async enqueue() { throw new Error('redis down'); } }, mailer: { enabled: false, async send() {} } });
    const res = await call('POST', `/v1/clients/${c.id}/runs`, b, broken);
    assert.deepEqual([res.status, res.json.error.code], [503, 'queue_unavailable']);
    assert.equal(await remaining(b), 5000);
    const runs = (await call('GET', `/v1/clients/${c.id}/tracker`, b)).json.runs;
    assert.deepEqual(runs.map((r: any) => [r.status, r.failedCalls, r.credits]), [['failed', 18, 0]]);
    // The client is free to run again straight away.
    assert.equal((await finished(b, (await startRun(b, c.id)).id)).status, 'completed');
    await broken.close();
  });
});

describe('prompts and competitors', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let client: Awaited<ReturnType<typeof setUpClient>>;

  before(async () => {
    a = await signup('List Agency', 'owner@list.test');
    client = await setUpClient(a, 'Blue Lotus Dental', 24);
  });

  test('prompts respect the plan limit, skip duplicates and cannot be reworded', async () => {
    const mixed = await call('POST', `/v1/clients/${client.id}/prompts`, { ...a, body: { prompts: [{ text: '  PROMPT 1   about dentists ' }, { text: 'A new question?' }] } });
    assert.deepEqual([mixed.status, mixed.json.added.length, mixed.json.skipped], [201, 1, 1]);
    const over = await call('POST', `/v1/clients/${client.id}/prompts`, { ...a, body: { prompts: [{ text: 'One too many' }] } });
    assert.deepEqual([over.status, over.json.error.code], [409, 'plan_limit']);

    const id = mixed.json.added[0].id;
    assert.equal((await call('PATCH', `/v1/prompts/${id}`, { ...a, body: { text: 'Reworded' } })).status, 400);
    assert.equal((await call('PATCH', `/v1/prompts/${id}`, { ...a, body: { active: false, intent: 'problem' } })).json.prompt.active, false);
    // Pausing one frees a slot; reactivating is refused once the slot is taken.
    assert.equal((await call('POST', `/v1/clients/${client.id}/prompts`, { ...a, body: { prompts: [{ text: 'Takes the slot' }] } })).status, 201);
    assert.equal((await call('PATCH', `/v1/prompts/${id}`, { ...a, body: { active: true } })).json.error.code, 'plan_limit');
  });

  test('removing a prompt keeps its past results', async () => {
    const b = await signup('Archive Agency', 'owner@archive.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 2);
    const run = await startRun(b, c.id);
    await finished(b, run.id);
    assert.equal((await call('DELETE', `/v1/prompts/${c.promptIds[0]}`, b)).status, 200);
    assert.equal((await call('DELETE', `/v1/prompts/${c.promptIds[0]}`, b)).status, 404);
    assert.equal((await call('GET', `/v1/clients/${c.id}/tracker`, b)).json.prompts.length, 1);
    assert.equal((await visibility(b, c.id, run.id)).visibility.prompts.length, 2);
    // The same wording can be added again as a new prompt.
    assert.equal((await call('POST', `/v1/clients/${c.id}/prompts`, { ...b, body: { prompts: [{ text: 'Prompt 1 about dentists' }] } })).json.added.length, 1);
  });

  test('competitors are capped at five and normalised', async () => {
    for (const name of ['Two', 'Three', 'Four', 'Five']) {
      assert.equal((await call('POST', `/v1/clients/${client.id}/competitors`, { ...a, body: { name: `Rival ${name}` } })).status, 201);
    }
    assert.equal((await call('POST', `/v1/clients/${client.id}/competitors`, { ...a, body: { name: 'Rival Six' } })).json.error.code, 'limit_reached');
    const edited = await call('PATCH', `/v1/competitors/${client.competitorId}`, { ...a, body: { domain: 'HTTPS://www.Smile-Studio.example/about', aliases: ['Smile'] } });
    assert.deepEqual([edited.json.competitor.domain, edited.json.competitor.aliases], ['smile-studio.example', ['Smile']]);
    assert.equal((await call('DELETE', `/v1/competitors/${client.competitorId}`, a)).status, 200);
    assert.equal((await call('POST', `/v1/clients/${client.id}/competitors`, { ...a, body: { name: 'rival two' } })).status, 409);
  });
});

describe('tenant isolation for tracking data', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let b: Awaited<ReturnType<typeof signup>>;
  let clientA: Awaited<ReturnType<typeof setUpClient>>;
  let runA: string;

  before(async () => {
    a = await signup('Iso One', 'owner@iso1.test');
    b = await signup('Iso Two', 'owner@iso2.test');
    clientA = await setUpClient(a, 'Blue Lotus Dental', 2);
    runA = (await startRun(a, clientA.id)).id;
    await finished(a, runA);
  });

  test("another agency cannot read or act on a client's tracking data", async () => {
    for (const [method, url, body] of [
      ['GET', `/v1/clients/${clientA.id}/tracker`],
      ['GET', `/v1/clients/${clientA.id}/visibility`],
      ['GET', `/v1/clients/${clientA.id}/visibility?run=${runA}`],
      ['GET', `/v1/runs/${runA}`],
      ['GET', `/v1/runs/${runA}/answers?prompt=${clientA.promptIds[0]}`],
      ['POST', `/v1/runs/${runA}/reparse`],
      ['POST', `/v1/clients/${clientA.id}/runs`],
      ['POST', `/v1/clients/${clientA.id}/prompts`, { prompts: [{ text: 'Planted prompt' }] }],
      ['POST', `/v1/clients/${clientA.id}/competitors`, { name: 'Planted' }],
      ['PUT', `/v1/clients/${clientA.id}/schedule`, { schedule: 'weekly' }],
      ['PATCH', `/v1/prompts/${clientA.promptIds[0]}`, { active: false }],
      ['DELETE', `/v1/prompts/${clientA.promptIds[0]}`],
      ['DELETE', `/v1/competitors/${clientA.competitorId}`],
    ] as const) {
      const res = await call(method, url, { ...b, body });
      if (url.includes('/answers')) assert.deepEqual(res.json, { answers: [] }, url);
      else assert.equal(res.status, 404, `${method} ${url}`);
    }
    assert.equal((await call('GET', `/v1/clients/${clientA.id}/tracker`, a)).json.prompts.length, 2);
    assert.deepEqual((await call('GET', '/v1/credits', b)).json.entries, []);
  });

  test('the database refuses cross-tenant access and protects the ledger', async () => {
    const tables = ['competitors', 'prompts', 'runs', 'prompt_results', 'result_mentions', 'citations', 'credit_ledger'];
    for (const table of tables) {
      assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} with no tenant set`);
      assert.ok((await ownerPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE agency_id = $1`, [a.agencyId])).rows[0].n > 0, `${table} has rows to hide`);
    }
    const db = await appPool.connect();
    const inTenant = async (agencyId: string, fn: () => Promise<unknown>) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.agency_id', $1, true)`, [agencyId]);
      try {
        return await fn();
      } finally {
        await db.query('ROLLBACK');
      }
    };
    try {
      await inTenant(b.agencyId, async () => {
        for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
        assert.equal((await db.query(`UPDATE prompt_results SET answer_text = 'tampered' WHERE run_id = $1`, [runA])).rowCount, 0);
        assert.equal((await db.query(`DELETE FROM runs WHERE id = $1`, [runA])).rowCount, 0);
      });
      const refused = (err: any) => err.code === '42501';
      // Planting rows in another agency, and every way of inventing credits, is an error.
      await assert.rejects(inTenant(b.agencyId, () => db.query(`INSERT INTO prompts (agency_id, client_id, text) VALUES ($1, $2, 'planted')`, [a.agencyId, clientA.id])), refused);
      await assert.rejects(inTenant(b.agencyId, () => db.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, 500, 'grant')`, [b.agencyId])), refused);
      await assert.rejects(inTenant(b.agencyId, () => db.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, 500, 'run_refund')`, [b.agencyId])), refused);
      await assert.rejects(inTenant(b.agencyId, () => db.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, -5, 'run_reserved')`, [a.agencyId])), refused);
      await assert.rejects(inTenant(a.agencyId, () => db.query(`UPDATE credit_ledger SET delta = -1`)), refused);
      await assert.rejects(inTenant(a.agencyId, () => db.query(`DELETE FROM credit_ledger`)), refused);
      await assert.rejects(inTenant(a.agencyId, () => db.query(`UPDATE engines SET credit_cost = 0`)), refused);
    } finally {
      db.release();
    }
    assert.equal(await remaining(a), 5000 - 18);
  });

  test('a client viewer reads their own results and can start or change nothing', async () => {
    const other = await setUpClient(a, 'Second Client', 1);
    const created = await call('POST', '/v1/team/invites', { ...a, body: { role: 'client_viewer', email: 'viewer@bluelotus.test', clientId: clientA.id } });
    const token = new URL(created.json.inviteUrl).pathname.split('/').pop()!;
    const accepted = await call('POST', '/v1/invites/accept', { host: a.host, body: { token, name: 'Viewer', password: PASSWORD } });
    const viewer = { host: a.host, cookie: accepted.cookie! };

    const tracker = (await call('GET', `/v1/clients/${clientA.id}/tracker`, viewer)).json;
    assert.equal(tracker.runs.length, 1);
    assert.deepEqual([tracker.credits, tracker.estimate, tracker.engines], [undefined, undefined, undefined], 'credits and costs are not shown to clients');
    assert.equal((await visibility(viewer, clientA.id)).visibility.totals.answers, 18);
    assert.equal((await call('GET', `/v1/runs/${runA}/answers?prompt=${clientA.promptIds[0]}`, viewer)).json.answers.length, 9);

    assert.equal((await call('GET', `/v1/clients/${other.id}/tracker`, viewer)).status, 404);
    assert.equal((await call('GET', `/v1/clients/${other.id}/visibility`, viewer)).status, 404);
    for (const [method, url, body] of [
      ['POST', `/v1/clients/${clientA.id}/runs`],
      ['POST', `/v1/clients/${clientA.id}/prompts`, { prompts: [{ text: 'Viewer prompt' }] }],
      ['POST', `/v1/clients/${clientA.id}/competitors`, { name: 'X Co' }],
      ['PUT', `/v1/clients/${clientA.id}/schedule`, { schedule: 'weekly' }],
      ['POST', `/v1/runs/${runA}/reparse`],
      ['DELETE', `/v1/prompts/${clientA.promptIds[0]}`],
      ['GET', '/v1/credits'],
    ] as const) {
      assert.equal((await call(method, url, { ...viewer, body })).status, 403, `${method} ${url}`);
    }
  });
});

describe('weekly schedule and housekeeping', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let client: Awaited<ReturnType<typeof setUpClient>>;
  const deps = () => ({ engines, queue });

  before(async () => {
    a = await signup('Weekly Agency', 'owner@weekly.test');
    client = await setUpClient(a, 'Blue Lotus Dental', 2);
  });

  test('a weekly client runs when due, once, and is moved a week ahead', async () => {
    const on = await call('PUT', `/v1/clients/${client.id}/schedule`, { ...a, body: { schedule: 'weekly' } });
    assert.equal(on.json.schedule, 'weekly');
    assert.ok(Math.abs(new Date(on.json.nextRunAt).getTime() - Date.now()) < 5000, 'a client that has never run is due straight away');

    const [first, second] = await Promise.all([runDueSchedules(deps()), runDueSchedules(deps())]);
    assert.equal(first.started + second.started, 1, 'two workers ticking together start it once');
    const tracker = (await call('GET', `/v1/clients/${client.id}/tracker`, a)).json;
    assert.deepEqual(tracker.runs.map((r: any) => r.trigger), ['scheduled']);
    const days = (new Date(tracker.client.nextRunAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.99 && days < 7.01, `next run in ${days} days`);
    assert.equal((await finished(a, tracker.runs[0].id)).status, 'completed');
    assert.deepEqual(await runDueSchedules(deps()), { started: 0, skipped: 0 });

    const off = await call('PUT', `/v1/clients/${client.id}/schedule`, { ...a, body: { schedule: 'off' } });
    assert.deepEqual(off.json, { schedule: 'off', nextRunAt: null });
  });

  test('a scheduled run that cannot start is recorded as skipped, with the reason', async () => {
    await call('PUT', `/v1/clients/${client.id}/schedule`, { ...a, body: { schedule: 'weekly' } });
    await ownerPool.query(`UPDATE clients SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [client.id]);
    await ownerPool.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, $2, 'adjustment')`, [a.agencyId, -(await remaining(a)) + 5]);
    assert.deepEqual(await runDueSchedules(deps()), { started: 0, skipped: 1 });
    const latest = (await call('GET', `/v1/clients/${client.id}/tracker`, a)).json.runs[0];
    assert.deepEqual([latest.status, latest.note], ['skipped', 'This run needs 18 credits and 5 are left this month. An owner can turn on top-up on the Usage page to go past the allowance.']);
    assert.equal(await remaining(a), 5);
    assert.deepEqual(await runDueSchedules(deps()), { started: 0, skipped: 0 }, 'it is not retried every minute');
  });

  test('a suspended agency or paused client is left alone', async () => {
    const b = await signup('Sleepy Agency', 'owner@sleepy.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 1);
    await call('PUT', `/v1/clients/${c.id}/schedule`, { ...b, body: { schedule: 'weekly' } });
    await ownerPool.query(`UPDATE agencies SET status = 'suspended' WHERE id = $1`, [b.agencyId]);
    assert.deepEqual(await runDueSchedules(deps()), { started: 0, skipped: 0 });
    await ownerPool.query(`UPDATE agencies SET status = 'active' WHERE id = $1`, [b.agencyId]);
    await call('PATCH', `/v1/clients/${c.id}`, { ...b, body: { status: 'paused' } });
    assert.deepEqual(await runDueSchedules(deps()), { started: 0, skipped: 0 });
  });

  test('a run whose calls were lost is closed and refunded after two hours', async () => {
    const b = await signup('Lost Agency', 'owner@lost.test');
    const c = await setUpClient(b, 'Blue Lotus Dental', 1);
    // Queue nothing, as if the queue's data had been wiped after the run was created.
    const silent = await buildApp({ engines, queue: { async enqueue() {} }, mailer: { enabled: false, async send() {} } });
    const run = (await call('POST', `/v1/clients/${c.id}/runs`, b, silent)).json.run;
    await silent.close();
    assert.equal(await closeStuckRuns(), 0, 'a recent run is left to finish');
    await ownerPool.query(`UPDATE runs SET created_at = now() - interval '3 hours' WHERE id = $1`, [run.id]);
    assert.equal(await closeStuckRuns(), 1);
    const closed = (await call('GET', `/v1/runs/${run.id}`, b)).json.run;
    assert.deepEqual([closed.status, closed.failedCalls, closed.credits], ['failed', 9, 0]);
    assert.equal(await remaining(b), 5000);
  });
});

describe('credit settings', () => {
  test('the super admin sets engine costs, plan allowances and grants', async () => {
    await ownerPool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ('root@platform.test', 'Root', $1, 'super_admin')`, [await hashPassword(PASSWORD)]);
    const admin = { host: PLATFORM, cookie: (await call('POST', '/v1/auth/login', { host: PLATFORM, body: { email: 'root@platform.test', password: PASSWORD } })).cookie! };
    const a = await signup('Priced Agency', 'owner@priced.test');
    const c = await setUpClient(a, 'Blue Lotus Dental', 2);

    assert.equal((await call('PATCH', '/v1/admin/engines/chatgpt', { ...a, body: { creditCost: 0 } })).status, 403);
    assert.equal((await call('PATCH', '/v1/admin/engines/chatgpt', { ...admin, body: { creditCost: 3 } })).json.engine.creditCost, 3);
    assert.equal((await call('PATCH', '/v1/admin/engines/gemini', { ...admin, body: { active: false } })).json.engine.active, false);
    try {
      // 2 prompts x 3 samples x (3 + 1) credits, on the two engines still active.
      const tracker = (await call('GET', `/v1/clients/${c.id}/tracker`, a)).json;
      assert.deepEqual(tracker.estimate, { callsPerRun: 12, creditsPerRun: 24, creditsPerMonth: 104 });
      assert.deepEqual(tracker.engines.map((e: any) => e.key), ['chatgpt', 'perplexity']);
      const done = await finished(a, (await startRun(a, c.id)).id);
      assert.deepEqual([done.totalCalls, done.credits, done.engineKeys], [12, 24, ['chatgpt', 'perplexity']]);
    } finally {
      await call('PATCH', '/v1/admin/engines/chatgpt', { ...admin, body: { creditCost: 1 } });
      await call('PATCH', '/v1/admin/engines/gemini', { ...admin, body: { active: true } });
    }

    assert.equal((await call('POST', `/v1/admin/agencies/${a.agencyId}/credits`, { ...admin, body: { amount: 1000, note: 'Launch bonus' } })).json.remaining, 5976);
    assert.equal((await call('PATCH', '/v1/admin/plans/starter', { ...admin, body: { monthlyCredits: 6000 } })).json.plan.monthlyCredits, 6000);
    assert.deepEqual((await call('GET', '/v1/credits', a)).json.entries.map((e: any) => [e.reason, e.delta, e.note]).slice(0, 1), [['grant', 1000, 'Launch bonus']]);
    assert.equal(await remaining(a), 6976);
    await call('PATCH', '/v1/admin/plans/starter', { ...admin, body: { monthlyCredits: 5000 } });
  });
});
