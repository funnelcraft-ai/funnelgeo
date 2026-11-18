import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { checkUsageAlerts } from '../src/billing/costs.js';
import { closePools, ownerPool, withTenant } from '../src/db.js';
import type { EngineAdapter, EngineSet } from '../src/engines.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';
import type { Writer } from '../src/writer.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-billing`;
const MONTH = new Date().toISOString().slice(0, 7);

// Engines that report tokens like the real ones; Perplexity also reports its own cost.
const MODELS: Record<string, string> = { chatgpt: 'gpt-test', perplexity: 'sonar-test', gemini: 'gemini-test' };
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [
      key,
      {
        key,
        ask: async () => ({
          text: 'Smile Studio is the top choice.',
          citations: ['https://www.bestof.example/top-dentists'],
          tokensIn: 1000,
          tokensOut: 400,
          costUsd: key === 'perplexity' ? 0.0062 : null,
          model: MODELS[key],
        }),
      },
    ]),
  ),
};
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => ({ url, finalUrl: url, status: 404, contentType: 'text/html', body: '' });
const writer: Writer = {
  mode: 'live',
  missing: () => null,
  write: async () => ({ text: 'A summary of the month, with figures.', model: 'gpt-writer', tokensIn: 3000, tokensOut: 500 }),
};
const mails: Mail[] = [];
const mailer = { enabled: true, async send(mail: Mail) { mails.push(mail); } };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let admin: { host: string; cookie: string };
let owner: { host: string; cookie: string; agencyId: string };
let clientId: string;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({ method, url, headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, cookie: sid ? `sid=${sid.value}` : undefined };
}

async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId as string };
}

async function runAndWait(who: typeof owner, id: string) {
  const started = await call('POST', `/v1/clients/${id}/runs`, who);
  if (started.status !== 202) return started;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await ownerPool.query(`SELECT status FROM diagnoses WHERE run_id = $1`, [started.json.run.id]);
    if (rows[0]?.status === 'done') return started;
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const events = async (kind?: string) =>
  (await ownerPool.query(`SELECT * FROM usage_events WHERE agency_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY id`, kind ? [owner.agencyId, kind] : [owner.agencyId])).rows;
const costs = async () => (await call('GET', `/v1/admin/costs?month=${MONTH}`, admin)).json;

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
  workers = startWorkers(engines, { prefix: PREFIX, audit: { fetcher, mailer, queue, siteMode: 'live', writer, renderPdf: async () => Buffer.from('%PDF-1.7') } });
  app = await buildApp({ engines, queue, mailer, writer });

  await ownerPool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ('root@platform.test', 'Root', $1, 'super_admin')`, [await hashPassword(PASSWORD)]);
  admin = { host: PLATFORM, cookie: (await call('POST', '/v1/auth/login', { host: PLATFORM, body: { email: 'root@platform.test', password: PASSWORD } })).cookie! };
  owner = await signup('Lotus Partners', 'owner@lotus-partners.example');
  clientId = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Blue Lotus Dental', domain: 'bluelotus.example' } })).json.client.id;
  await call('POST', `/v1/clients/${clientId}/competitors`, { ...owner, body: { name: 'Smile Studio', domain: 'smilestudio.example' } });
  await call('POST', `/v1/clients/${clientId}/prompts`, { ...owner, body: { prompts: [{ text: 'Best dentist in Pune' }, { text: 'Dental implants cost' }] } });
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('every call that costs money is recorded', () => {
  test('each engine call, with its provider, model and tokens', async () => {
    await runAndWait(owner, clientId);
    const calls = await events('engine_call');
    assert.equal(calls.length, 2 * 3 * 3, '2 questions × 3 engines × 3 samples');
    const by = (p: string) => calls.filter((c) => c.provider === p);
    assert.deepEqual([by('openai').length, by('perplexity').length, by('gemini').length], [6, 6, 6]);
    assert.deepEqual([by('openai')[0].model, by('openai')[0].tokens_in, by('openai')[0].tokens_out, by('openai')[0].client_id], ['gpt-test', 1000, 400, clientId]);
    assert.equal(Number(by('perplexity')[0].provider_cost_usd), 0.0062);
    assert.ok(calls.every((c) => c.ref_id), 'each tied to its answer');
  });

  test('crawled pages, writing calls and suggestions too', async () => {
    const pages = await events('page_fetch');
    assert.ok(pages.length >= 1 && pages.every((p) => p.provider === 'crawl' && p.requests > 0), 'the website check and cited pages');

    // A generated asset.
    const { rows } = await ownerPool.query(`SELECT id FROM actions WHERE client_id = $1 AND key = 'site:bestof.example'`, [clientId]);
    await call('PATCH', `/v1/actions/${rows[0].id}`, { ...owner, body: { status: 'approved' } });
    const asset = (await call('POST', `/v1/actions/${rows[0].id}/assets`, { ...owner, body: { kind: 'outreach_email' } })).json.asset;
    for (let i = 0; i < 200 && (await ownerPool.query(`SELECT status FROM assets WHERE id = $1`, [asset.id])).rows[0].status === 'pending'; i++) await new Promise((r) => setTimeout(r, 25));
    // A report summary.
    const report = (await call('POST', `/v1/clients/${clientId}/reports`, { ...owner, body: { month: MONTH } })).json.report;
    for (let i = 0; i < 200 && (await ownerPool.query(`SELECT summary_state FROM reports WHERE id = $1`, [report.id])).rows[0].summary_state === 'pending'; i++) await new Promise((r) => setTimeout(r, 25));
    const writing = await events('writer_call');
    assert.deepEqual(writing.map((w) => [w.provider, w.model, w.tokens_in, w.ref_id]), [
      ['openai', 'gpt-writer', 3000, asset.id],
      ['openai', 'gpt-writer', 3000, report.id],
    ]);

    // A competitor suggestion for an audit.
    await call('POST', '/v1/audits/suggest-competitors', { ...owner, body: { business: 'Coral Dental', domain: 'coral.example', category: 'Dentist', location: 'Pune' } });
    const suggestions = await events('suggestion_call');
    assert.deepEqual(suggestions.map((s) => [s.provider, s.model]), [['perplexity', 'sonar-test']]);
  });

  test('agencies can’t read costs, at the API or in the database', async () => {
    assert.ok([401, 403, 404].includes((await call('GET', `/v1/admin/costs?month=${MONTH}`, owner)).status));
    await assert.rejects(withTenant({ agencyId: owner.agencyId }, (db) => db.query('SELECT * FROM usage_events')), (err: any) => err.code === '42501');
    await assert.rejects(withTenant({ agencyId: owner.agencyId }, (db) => db.query('SELECT * FROM model_prices')), (err: any) => err.code === '42501');
  });
});

describe('real cost against the providers’ invoices (PRD exit check)', () => {
  test('calls without a price are flagged, never counted as free', async () => {
    const c = await costs();
    const openai = c.providers.find((p: any) => p.provider === 'openai');
    assert.ok(openai.unpriced > 0);
    assert.ok(c.totals.unpriced > 0);
    assert.ok(c.models.some((m: any) => m.provider === 'gemini' && m.unpriced));
    // Perplexity reported its own cost on every call, so it needs no price.
    const pplx = c.providers.find((p: any) => p.provider === 'perplexity');
    assert.equal(pplx.unpriced, 0);
  });

  test('with prices set, each call is costed from its tokens and calls', async () => {
    const price = (body: object) => call('PUT', '/v1/admin/prices', { ...admin, body });
    assert.equal((await price({ provider: 'openai', model: 'gpt-test', inputPerMTok: 2.5, outputPerMTok: 10, perRequest: 0.025 })).status, 200);
    await price({ provider: 'openai', model: '*', inputPerMTok: 0.4, outputPerMTok: 1.6, perRequest: 0 });
    await price({ provider: 'gemini', model: '*', inputPerMTok: 0.3, outputPerMTok: 2.5, perRequest: 0.035 });
    assert.equal((await price({ provider: 'mock', model: '*', inputPerMTok: 1, outputPerMTok: 1, perRequest: 1 })).status, 400);

    const c = await costs();
    const expected = {
      // 6 calls × (1000 × 2.5 + 400 × 10) / 1e6 + 6 × 0.025, plus 2 writing calls on the '*' price.
      openai: 6 * ((1000 * 2.5 + 400 * 10) / 1e6 + 0.025) + 2 * ((3000 * 0.4 + 500 * 1.6) / 1e6),
      gemini: 6 * ((1000 * 0.3 + 400 * 2.5) / 1e6 + 0.035),
      perplexity: 7 * 0.0062,
    };
    for (const [p, usd] of Object.entries(expected)) {
      const row = c.providers.find((x: any) => x.provider === p);
      assert.ok(Math.abs(row.costUsd - usd) < 1e-9, `${p}: ${row.costUsd} vs ${usd}`);
      assert.equal(row.unpriced, 0);
    }
    const agency = c.agencies.find((a: any) => a.name === 'Lotus Partners');
    assert.ok(Math.abs(agency.costUsd - (expected.openai + expected.gemini + expected.perplexity)) < 1e-9);
    assert.equal(agency.engineCalls, 18);
  });

  test('a month’s recorded costs match an invoice within 5%, and a bigger gap is flagged', async () => {
    const c0 = await costs();
    const recorded = (p: string) => c0.providers.find((x: any) => x.provider === p).costUsd as number;
    const invoice = (p: string, amountUsd: number) => call('PUT', `/v1/admin/invoices/${p}/${MONTH}`, { ...admin, body: { amountUsd: Math.round(amountUsd * 100) / 100, note: 'From the invoice' } });
    await invoice('openai', recorded('openai') * 1.03);
    await invoice('gemini', recorded('gemini') * 0.97);
    await invoice('perplexity', recorded('perplexity') * 1.5);

    const c = await costs();
    const row = (p: string) => c.providers.find((x: any) => x.provider === p);
    assert.equal(row('openai').matches, true);
    assert.equal(row('gemini').matches, true);
    assert.ok(Math.abs(row('openai').difference) <= 0.05);
    assert.equal(row('perplexity').matches, false, 'far apart is flagged');
    assert.ok(row('perplexity').difference < -0.15);
    assert.equal(row('openai').note, 'From the invoice');
    // Agency users can't enter invoices.
    assert.ok([401, 403, 404].includes((await call('PUT', `/v1/admin/invoices/openai/${MONTH}`, { ...owner, body: { amountUsd: 1 } })).status));
  });

  test('margin per agency uses the plan’s price, converted from rupees at the rate the admin sets', async () => {
    const plan = (await call('GET', '/v1/admin/plans/all', admin)).json.plans.find((p: any) => p.agencies > 0);
    await call('PATCH', `/v1/admin/plans/${plan.key}/details`, { ...admin, body: { price: { amount: 7999, currency: 'INR' } } });
    let agency = (await costs()).agencies.find((a: any) => a.name === 'Lotus Partners');
    assert.equal(agency.revenueUsd, null, 'no rate set yet');
    assert.equal((await call('PUT', '/v1/admin/settings/USD_INR', { ...admin, body: { value: '84' } })).status, 200);
    agency = (await costs()).agencies.find((a: any) => a.name === 'Lotus Partners');
    assert.ok(Math.abs(agency.revenueUsd - 7999 / 84) < 1e-9);
    assert.ok(Math.abs(agency.marginUsd - (7999 / 84 - agency.costUsd)) < 1e-9);
    assert.ok(agency.marginPct > 0.99);
    assert.ok(agency.costPerCredit > 0);
    const settings = (await call('GET', '/v1/admin/settings', admin)).json;
    assert.ok(!settings.groups.some((g: any) => g.key === 'billing'), 'the rate lives on the Costs screen, not API keys');
  });
});

describe('allowances', () => {
  test('owners see usage by kind and client, with a forecast', async () => {
    const u = (await call('GET', '/v1/usage', owner)).json;
    assert.equal(u.used, 18 + 1 + 1, 'a run of 18 calls, an outreach email and a summary');
    assert.deepEqual(u.byKind.map((k: any) => [k.kind, k.credits]), [['scheduled_runs', 0], ['manual_runs', 18], ['audits', 0], ['assets', 1], ['summaries', 1]]);
    assert.deepEqual(u.byClient, [{ name: 'Blue Lotus Dental', credits: 20 }]);
    assert.ok(u.forecast.credits >= u.used);
    assert.equal(u.daily.at(-1).credits, 20);
    assert.equal(u.topup.enabled, false);
  });

  test('at 100% spending stops, unless an owner turns on top-up, up to its cap', async () => {
    const plan = (await call('GET', '/v1/admin/plans/all', admin)).json.plans.find((p: any) => p.agencies > 0);
    await call('PATCH', `/v1/admin/plans/${plan.key}/details`, { ...admin, body: { monthlyCredits: 30 } });
    const refused = await call('POST', `/v1/clients/${clientId}/runs`, owner);
    assert.equal(refused.status, 402);
    assert.match(refused.json.error.message, /needs 18 credits and 10 are left this month\. An owner can turn on top-up/);

    // Members can't change top-up.
    await ownerPool.query(`INSERT INTO users (agency_id, email, name, password_hash, role) VALUES ($1, 'member@lotus-partners.example', 'Member', $2, 'agency_member')`, [owner.agencyId, await hashPassword(PASSWORD)]);
    const member = { host: owner.host, cookie: (await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'member@lotus-partners.example', password: PASSWORD } })).cookie! };
    assert.equal((await call('PATCH', '/v1/usage/topup', { ...member, body: { enabled: true, limit: 20 } })).status, 403);
    assert.equal((await call('PATCH', '/v1/usage/topup', { ...owner, body: { enabled: true, limit: 0 } })).status, 400);

    const on = await call('PATCH', '/v1/usage/topup', { ...owner, body: { enabled: true, limit: 20 } });
    assert.deepEqual([on.json.topup.enabled, on.json.spendable], [true, 30]);
    assert.equal((await runAndWait(owner, clientId)).status, 202, 'top-up covers this run');
    const after = (await call('GET', '/v1/usage', owner)).json;
    assert.deepEqual([after.used, after.topup.inUse, after.spendable], [38, 8, 12]);
    assert.equal((await call('POST', `/v1/clients/${clientId}/runs`, owner)).status, 402, 'the cap still stops it');

    const agency = (await costs()).agencies.find((a: any) => a.name === 'Lotus Partners');
    assert.deepEqual([agency.used, agency.overage, agency.topupEnabled], [38, 8, true]);
  });

  test('owners are emailed once at 80% and once at 100% each month', async () => {
    mails.length = 0;
    await checkUsageAlerts(mailer);
    const lotus = mails.filter((m) => m.to === 'owner@lotus-partners.example');
    assert.deepEqual(lotus.map((m) => m.subject), ['This month’s credits are used up']);
    assert.match(lotus[0]!.text, /Top-up is on, so work carries on for up to 20 more credits/);
    mails.length = 0;
    await checkUsageAlerts(mailer);
    assert.equal(mails.length, 0, 'not again this month');

    // A second agency on a small plan crosses 80%.
    const tiny = await call('POST', '/v1/admin/plans', { ...admin, body: { key: 'tiny', name: 'Tiny', monthlyCredits: 20, clientLimit: 2, promptsPerClient: 5, samplesPerPrompt: 3, auditsPerMonth: 1, price: null, active: true } });
    assert.equal(tiny.status, 201);
    assert.equal((await call('POST', '/v1/admin/plans', { ...admin, body: { key: 'tiny', name: 'Again', monthlyCredits: 1, clientLimit: 1, promptsPerClient: 1, samplesPerPrompt: 1, auditsPerMonth: 0, price: null, active: true } })).status, 409);
    const other = await signup('Coral Agency', 'owner@coral-agency.example');
    assert.equal((await call('PATCH', `/v1/admin/agencies/${other.agencyId}`, { ...admin, body: { planKey: 'tiny' } })).status, 200);
    const coral = (await call('POST', '/v1/clients', { ...other, body: { name: 'Coral Smiles', domain: 'coral.example' } })).json.client.id;
    await call('POST', `/v1/clients/${coral}/prompts`, { ...other, body: { prompts: [{ text: 'Dentist near Baner' }, { text: 'Kids dentist Baner' }] } });
    await runAndWait(other, coral);
    mails.length = 0;
    await checkUsageAlerts(mailer);
    assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['owner@coral-agency.example', '80% of this month’s credits used']]);
    assert.match(mails[0]!.text, /You have used 18 of this month’s 20 credits \(90%\)/);
  });

  test('a plan in use can’t be retired', async () => {
    assert.equal((await call('PATCH', '/v1/admin/plans/tiny/details', { ...admin, body: { active: false } })).status, 409);
  });
});
