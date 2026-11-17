import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { createSiteFetcher, isPublicAddress, type FetchedPage, type SiteFetcher } from '../src/audits/fetch.js';
import { buildFixes } from '../src/audits/report.js';
import { isAllowed, parseRobots } from '../src/audits/robots.js';
import { checkSite, schemaTypes, visibleText } from '../src/audits/site.js';
import { parseNameList, suggestPrompts } from '../src/audits/suggest.js';
import { appPool, closePools, ownerPool } from '../src/db.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import type { Mail, Mailer } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = process.env.QUEUE_PREFIX!;

// Engines --------------------------------------------------------------------------
// Scripted answers, so every count in the report can be worked out by hand.
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 10, tokensOut: 40, costUsd: null });
const COMPETITOR_LIST = '1. **Smile Studio** - modern clinic [1]\n2. Pearl Dental Care: family dentist\n3. Blue Lotus Dental\nHere are a few more options:\n- City Dental Hub (Koregaon Park)';
const script: Record<string, (prompt: string) => EngineAnswer> = {
  // Names both competitors; names the client on prompts with "Best " or "reviews".
  chatgpt: (p) =>
    answer(`Smile Studio and Pearl Dental Care are popular.${/Best |reviews/.test(p) ? ' Blue Lotus Dental is also recommended.' : ''}`, ['https://reviews.example/top', 'https://www.smilestudio.example/']),
  // Names the client only on the "trusted" prompt.
  perplexity: (p) =>
    /trusted/.test(p)
      ? answer('Many choose Blue Lotus Dental.', ['https://www.bluelotus.example/', 'https://directory.example/list'])
      : answer('Smile Studio is often recommended.', ['https://directory.example/list', 'https://reviews.example/top']),
  gemini: () => answer('Pearl Dental Care is a good choice.', ['https://pearldental.example/']),
};
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    Object.keys(script).map((key): [string, EngineAdapter] => [
      key,
      { key, async ask(prompt) { return prompt.startsWith('List up to') ? answer(COMPETITOR_LIST) : script[key]!(prompt); } },
    ]),
  ),
};

// Websites ---------------------------------------------------------------------------
const page = (url: string, status: number, contentType: string, body: string): FetchedPage => ({ url, finalUrl: url, status, contentType, body });
const words = (n: number) => Array.from({ length: n }, () => 'clinic').join(' ');
const sites: Record<string, Record<string, [number, string, string]>> = {
  // A typical weak site: blocks ChatGPT search, renders with JavaScript, no markup.
  'bluelotus.example': {
    '/': [200, 'text/html', `<html><head><title>Blue Lotus Dental</title><script>${words(500)}</script></head><body><div id="root">${words(30)}</div></body></html>`],
    '/robots.txt': [200, 'text/plain', 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n'],
  },
  // A well prepared site.
  'northside.example': {
    '/': [200, 'text/html', `<html><head><title>Northside Physio</title><meta name="description" content="Physio in Kolkata"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"MedicalClinic"},{"@type":"FAQPage"}]}</script></head><body><p>${words(200)}</p></body></html>`],
    '/robots.txt': [200, 'text/plain', 'User-agent: *\nAllow: /\nSitemap: https://northside.example/sitemap.xml\n'],
    '/sitemap.xml': [200, 'application/xml', '<urlset><url><loc>https://northside.example/</loc></url><url><loc>https://www.northside.example/faq</loc></url><url><loc>https://elsewhere.example/x</loc></url></urlset>'],
    '/faq': [200, 'text/html', '<html><body><h2>How long is a session?</h2><p>45 minutes.</p><h3>Do I need a referral?</h3></body></html>'],
    '/llms.txt': [200, 'text/plain', '# Northside Physio\n'],
  },
};
const fetched: string[] = [];
const fakeFetcher: SiteFetcher = async (url) => {
  fetched.push(url);
  const u = new URL(url);
  const site = sites[u.hostname.replace(/^www\./, '')];
  if (!site) throw new Error('getaddrinfo ENOTFOUND');
  if (u.protocol !== 'https:') return page(url, 301, 'text/html', '');
  const found = site[u.pathname];
  return found ? page(url, ...found) : page(url, 404, 'text/html', '<html>Not found</html>');
};

const mails: Mail[] = [];
const mailer: Mailer = { enabled: true, async send(mail) { mails.push(mail); } };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;

type Who = { host: string; cookie: string };
async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({
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

const until = async <T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const finished = (who: Who, id: string) =>
  until('the audit', async () => {
    const { json } = await call('GET', `/v1/audits/${id}`, who);
    return json.report.status !== 'running' && json;
  });
const remaining = async (who: Who) => (await call('GET', '/v1/credits', who)).json.remaining as number;
const BLUE_LOTUS = { business: 'Blue Lotus Dental', domain: 'https://www.BlueLotus.example/contact', category: 'Dental clinic', location: 'Pune' };

async function newAudit(who: Who, overrides: Record<string, unknown> = {}) {
  const prompts = suggestPrompts('dental clinic', 'Pune');
  const res = await call('POST', '/v1/audits', {
    ...who,
    body: { ...BLUE_LOTUS, prompts, competitors: [{ name: 'Smile Studio', domain: 'smilestudio.example' }, { name: 'Pearl Dental Care', domain: 'pearldental.example' }], ...overrides },
  });
  return res;
}

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
  workers = startWorkers(engines, { prefix: PREFIX, audit: { fetcher: fakeFetcher, mailer, queue, siteMode: 'live' } });
  app = await buildApp({ engines, queue, mailer });
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('building blocks', () => {
  test('ten buyer prompts, none naming the business', () => {
    const prompts = suggestPrompts('  Dental   Clinic ', 'Pune');
    assert.equal(prompts.length, 10);
    assert.equal(prompts[0]!.text, 'Best dental clinic in Pune');
    assert.ok(prompts.some((p) => p.text === 'What should I look for in a dental clinic?'), 'no location where it reads wrong');
    assert.deepEqual([...new Set(prompts.map((p) => p.intent))].sort(), ['category', 'comparison', 'problem']);
    assert.equal(suggestPrompts('optician', null)[0]!.text, 'Best optician');
    assert.ok(suggestPrompts('optician', null).some((p) => p.text === 'What should I look for in an optician?'));
  });

  test('business names are pulled out of a list answer', () => {
    assert.deepEqual(parseNameList(COMPETITOR_LIST, ['Blue Lotus Dental', 'bluelotus']), ['Smile Studio', 'Pearl Dental Care', 'City Dental Hub']);
    assert.deepEqual(parseNameList('Sure! Here is a list:\n\nThis is a very long sentence that is clearly not a name at all', []), []);
  });

  test('robots.txt: specific groups win over *, longest rule wins, allow wins ties', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: GPTBot # training\nDisallow: /$\nAllow: /\n\nUser-agent: CCBot\nDisallow:\nSitemap: https://a.example/s.xml');
    assert.equal(isAllowed(robots, 'oai-searchbot'), true);
    assert.equal(isAllowed(robots, 'PerplexityBot'), true);
    assert.equal(isAllowed(robots, 'ClaudeBot'), false, 'falls back to *');
    assert.equal(isAllowed(robots, 'GPTBot'), false, '"/$" is longer than "/"');
    assert.equal(isAllowed(robots, 'GPTBot', '/page'), true);
    assert.equal(isAllowed(robots, 'CCBot'), true, 'an empty Disallow allows everything');
    assert.deepEqual(robots.sitemaps, ['https://a.example/s.xml']);
    assert.equal(isAllowed(parseRobots(''), 'GPTBot'), true);
    assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /*'), 'GPTBot'), false);
  });

  test('page reading: visible text skips scripts, JSON-LD types include @graph', () => {
    assert.equal(visibleText('<head><title>x</title></head><body><script>var a=1</script><p>Hello &amp; welcome</p><style>p{}</style></body>'), 'Hello & welcome');
    assert.deepEqual(schemaTypes('<script type="application/ld+json">{"@graph":[{"@type":["Dentist","LocalBusiness"]},{"@type":"https://schema.org/FAQPage"}]}</script><script type="application/ld+json">{broken</script>'), ['Dentist', 'FAQPage', 'LocalBusiness']);
  });

  test('the site check reports a weak site and a strong one', async () => {
    const weak = await checkSite('bluelotus.example', fakeFetcher);
    assert.deepEqual(
      weak.checks.map((c) => [c.key, c.status]),
      [['site_loads', 'pass'], ['https', 'pass'], ['ai_crawlers', 'fail'], ['readable_without_js', 'fail'], ['structured_data', 'fail'], ['answer_structure', 'warn'], ['page_basics', 'warn'], ['sitemap', 'warn'], ['llms_txt', 'warn']],
    );
    assert.deepEqual(weak.blockedCrawlers.map((c) => c.token), ['OAI-SearchBot', 'GPTBot']);
    assert.match(weak.checks[2]!.detail, /OAI-SearchBot \(ChatGPT search\)/);

    const strong = await checkSite('northside.example', fakeFetcher);
    assert.ok(strong.checks.every((c) => c.status === 'pass'), JSON.stringify(strong.checks.filter((c) => c.status !== 'pass')));
    assert.equal(strong.pagesChecked, 2, 'pages on other sites are not checked');
    assert.deepEqual(strong.schemaTypes, ['FAQPage', 'MedicalClinic']);

    const gone = await checkSite('nowhere.example', fakeFetcher);
    assert.deepEqual([gone.checks[0]!.status, gone.checks.filter((c) => c.status === 'unknown').length], ['fail', 8]);
  });

  test('fixes are ranked by a fixed order and capped at five', async () => {
    const site = await checkSite('bluelotus.example', fakeFetcher);
    const fixes = buildFixes({ business: 'Blue Lotus', domain: 'bluelotus.example', site, missing: [{ text: 'Best dentist', competitors: ['A', 'B'] }], gaps: [{ domain: 'reviews.example', answers: 4 }] });
    assert.deepEqual(fixes.map((f) => f.key), ['unblock_crawlers', 'render_without_js', 'answer_prompt_0', 'get_listed_0', 'structured_data']);
    assert.equal(fixes[2]!.why, 'A and B are named for this question and Blue Lotus is not.');
    assert.deepEqual(buildFixes({ business: 'X', domain: 'x.example', site: null, missing: [], gaps: [] }), []);
  });
});

describe('the website fetcher refuses internal addresses', () => {
  test('public and private addresses are told apart', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not-an-ip']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  test('names and addresses on this machine are refused before connecting', async () => {
    const fetcher = createSiteFetcher();
    await assert.rejects(fetcher('http://localhost/'), /not on the public internet/);
    await assert.rejects(fetcher('http://127.0.0.1/'), /not on the public internet/);
    await assert.rejects(fetcher('http://169.254.169.254/latest/meta-data/'), /not on the public internet/);
    await assert.rejects(fetcher('http://example.com:8080/'), /standard web ports/);
    await assert.rejects(fetcher('ftp://example.com/'), /Only web addresses/);
    await assert.rejects(fetcher('http://user:pass@example.com/'), /login/);
  });

  test('redirects are capped at three and large pages are cut short', async () => {
    const server = http.createServer((req, res) => {
      const hop = req.url!.match(/^\/r(\d)$/);
      if (hop) return res.writeHead(302, { location: Number(hop[1]) < 4 ? `/r${Number(hop[1]) + 1}` : '/end' }).end();
      if (req.url === '/big') return res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(3_000_000));
      res.writeHead(200, { 'content-type': 'text/html' }).end('done');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // Only tests may turn the address check off, to serve a site from this machine.
      const fetcher = createSiteFetcher({ allowPrivate: true });
      assert.deepEqual(await fetcher(`${base}/r2`).then((p) => [p.status, p.body, p.finalUrl]), [200, 'done', `${base}/end`]);
      await assert.rejects(fetcher(`${base}/r1`), /Too many redirects/);
      assert.ok((await fetcher(`${base}/big`)).body.length <= 1_500_000);
    } finally {
      server.close();
    }
  });
});

describe('prospect audit', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let auditId: string;
  let report: any;
  let shareUrl: string;

  before(async () => {
    a = await signup('Audit Agency', 'owner@audit.test');
  });

  test('suggestions: ten prompts, and competitors from an engine', async () => {
    const prompts = await call('POST', '/v1/audits/suggest-prompts', { ...a, body: { category: 'dental clinic', location: 'Pune' } });
    assert.equal(prompts.json.prompts.length, 10);
    const competitors = await call('POST', '/v1/audits/suggest-competitors', { ...a, body: BLUE_LOTUS });
    assert.deepEqual(competitors.json.competitors, ['Smile Studio', 'Pearl Dental Care', 'City Dental Hub']);
    const estimate = (await call('GET', '/v1/audits/estimate', a)).json;
    assert.deepEqual([estimate.creditsPerPrompt, estimate.samples, estimate.quota], [3, 1, { used: 0, max: 10 }]);
  });

  test('an audit completes in under five minutes with the expected report (exit check)', async () => {
    const started = Date.now();
    const res = await newAudit(a);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    auditId = res.json.audit.id;
    const done = await finished(a, auditId);
    assert.ok(Date.now() - started < 5 * 60_000);
    report = done.report;
    shareUrl = done.shareUrl;

    assert.equal(report.status, 'completed');
    assert.deepEqual([report.business, report.domain, report.category, report.location, report.clientStatus], ['Blue Lotus Dental', 'bluelotus.example', 'Dental clinic', 'Pune', 'prospect']);
    assert.deepEqual(report.run, { status: 'completed', samples: 1, promptCount: 10, engines: ['chatgpt', 'perplexity', 'gemini'], totalCalls: 30, done: 30, failed: 0 });
    assert.deepEqual(report.visibility.totals, { answers: 30, mentioned: 3, cited: 1, failed: 0, pending: 0 });
    assert.deepEqual(report.visibility.brands.map((b: any) => [b.name, b.mentions]), [['Pearl Dental Care', 20], ['Smile Studio', 19], ['Blue Lotus Dental', 3]]);
    // Five of the seven questions where only competitors were named, in the order they were asked.
    assert.deepEqual(report.missing.map((m: any) => m.text), [
      'Which dental clinic in Pune do people recommend?',
      'Top rated dental clinic in Pune',
      'Affordable dental clinic in Pune',
      'Compare the best dental clinic options in Pune',
      'How do I choose a good dental clinic in Pune?',
    ]);
    assert.deepEqual(report.missing[0].competitors.sort(), ['Pearl Dental Care', 'Smile Studio']);
    // Competitors' own sites and the client's site are not "places to get listed".
    assert.deepEqual(report.gaps, [{ domain: 'reviews.example', answers: 17 }, { domain: 'directory.example', answers: 9 }]);
    assert.deepEqual([report.site.status, report.site.passed], ['done', 2]);
    assert.deepEqual(report.fixes.map((f: any) => f.key), ['unblock_crawlers', 'render_without_js', 'answer_prompt_0', 'get_listed_0', 'structured_data']);
    assert.equal(report.fixes[3].title, 'Get Blue Lotus Dental listed on reviews.example');
    assert.equal(report.demo, false);
    assert.equal(await remaining(a), 5000 - 30);
  });

  test('a prospect stays out of the client list and the plan’s client limit', async () => {
    assert.deepEqual((await call('GET', '/v1/clients', a)).json.clients, []);
    const list = (await call('GET', '/v1/audits', a)).json;
    assert.deepEqual(list.quota, { used: 1, max: 10 });
    assert.deepEqual(list.audits.map((x: any) => [x.business, x.status, x.answers, x.mentioned, x.clientStatus]), [['Blue Lotus Dental', 'completed', 30, 3, 'prospect']]);
  });

  test('the share link works only on the agency’s own address, and can be revoked', async () => {
    const path = new URL(shareUrl).pathname;
    const token = path.split('/').pop()!;
    assert.equal(new URL(shareUrl).hostname, a.host);
    const shared = await call('GET', `/v1/reports/${token}`, { host: a.host });
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.json.agency, { name: 'Audit Agency', ctaLabel: null, ctaUrl: null });
    assert.deepEqual(shared.json.report.visibility, report.visibility);
    for (const hidden of ['shareToken', 'clientId', 'clientStatus', 'source']) assert.equal(shared.json.report[hidden], undefined, hidden);

    const other = await signup('Other Agency', 'owner@other.test');
    assert.equal((await call('GET', `/v1/reports/${token}`, { host: other.host })).status, 404);
    assert.equal((await call('GET', `/v1/reports/${token}`, { host: PLATFORM })).status, 404);
    assert.equal((await call('GET', '/v1/reports/short', { host: a.host })).status, 400);

    const renewed = await call('POST', `/v1/audits/${auditId}/share-link`, a);
    assert.equal((await call('GET', `/v1/reports/${token}`, { host: a.host })).status, 404, 'the old link stops working');
    assert.equal((await call('GET', `/v1/reports/${new URL(renewed.json.shareUrl).pathname.split('/').pop()}`, { host: a.host })).status, 200);
  });

  test('converting keeps the prompts, competitors and results (exit check)', async () => {
    const converted = await call('PATCH', `/v1/clients/${report.clientId}`, { ...a, body: { status: 'active' } });
    assert.equal(converted.json.client.status, 'active');
    assert.deepEqual((await call('GET', '/v1/clients', a)).json.clients.map((c: any) => c.name), ['Blue Lotus Dental']);

    const tracker = (await call('GET', `/v1/clients/${report.clientId}/tracker`, a)).json;
    assert.deepEqual(tracker.prompts.map((p: any) => p.text), suggestPrompts('dental clinic', 'Pune').map((p) => p.text), 'same prompts, same order');
    assert.deepEqual(tracker.competitors.map((c: any) => c.name), ['Smile Studio', 'Pearl Dental Care']);
    assert.deepEqual(tracker.runs.map((r: any) => [r.trigger, r.status, r.okCalls]), [['audit', 'completed', 30]]);
    const visibility = (await call('GET', `/v1/clients/${report.clientId}/visibility`, a)).json;
    assert.deepEqual(visibility.visibility, report.visibility);

    // A converted client is never deleted through its audit.
    assert.equal((await call('DELETE', `/v1/audits/${auditId}`, a)).json.error.code, 'converted');
    // And it can now run normally, at the plan's sample count.
    const run = await call('POST', `/v1/clients/${report.clientId}/runs`, a);
    assert.equal(run.json.run.totalCalls, 90);
  });

  test('a prospect can be deleted with its audit', async () => {
    const res = await newAudit(a, { business: 'Throwaway Dental', domain: 'throwaway.example' });
    await finished(a, res.json.audit.id);
    assert.equal((await call('DELETE', `/v1/audits/${res.json.audit.id}`, a)).status, 200);
    assert.equal((await call('GET', `/v1/audits/${res.json.audit.id}`, a)).status, 404);
  });

  test('an unreachable website still gives a report, without site fixes', async () => {
    const res = await newAudit(a, { business: 'Ghost Dental', domain: 'ghost.example' });
    const done = await finished(a, res.json.audit.id);
    assert.equal(done.report.status, 'completed');
    assert.equal(done.report.site.findings.checks[0].status, 'fail');
    assert.deepEqual(done.report.fixes.map((f: any) => f.key), ['site_loads', 'answer_prompt_0', 'get_listed_0', 'answer_prompt_1', 'get_listed_1']);
  });

  test('limits: monthly audits, credits, prompts and competitors; nothing is left behind', async () => {
    const b = await signup('Limit Agency', 'owner@limit.test');
    await ownerPool.query(`INSERT INTO plans (key, name, monthly_credits, client_limit, samples_per_prompt, prompts_per_client, audits_per_month) VALUES ('one', 'One audit', 5000, 5, 3, 25, 1)`);
    await ownerPool.query(`UPDATE agencies SET plan_id = (SELECT id FROM plans WHERE key = 'one') WHERE id = $1`, [b.agencyId]);
    assert.equal((await newAudit(b)).status, 201);
    const second = await newAudit(b, { domain: 'second.example' });
    assert.deepEqual([second.status, second.json.error.code], [409, 'audit_limit']);

    const c = await signup('Broke Agency', 'owner@broke.test');
    await ownerPool.query(`INSERT INTO credit_ledger (agency_id, delta, reason) VALUES ($1, -4990, 'adjustment')`, [c.agencyId]);
    const broke = await newAudit(c);
    assert.deepEqual([broke.status, broke.json.error.code], [402, 'insufficient_credits']);
    assert.equal((await ownerPool.query(`SELECT count(*)::int AS n FROM clients WHERE agency_id = $1`, [c.agencyId])).rows[0].n, 0, 'the prospect was removed');
    assert.equal(await remaining(c), 10);

    const many = Array.from({ length: 16 }, (_, i) => ({ text: `Question number ${i}` }));
    assert.equal((await newAudit(c, { prompts: many })).status, 400);
    const crowd = ['A', 'B', 'C', 'D'].map((n) => ({ name: `Rival ${n}` }));
    assert.equal((await newAudit(c, { competitors: crowd })).status, 400);
    assert.equal((await newAudit(c, { domain: 'not a website' })).status, 400);
  });
});

describe('website widget', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  const form = { businessName: 'Northside Physio', website: 'northside.example', category: 'physiotherapy clinic', location: 'Kolkata', name: 'Rina', email: 'Rina@Northside.example' };
  const leads = async (who: Who) => (await call('GET', '/v1/leads', who)).json.leads;

  before(async () => {
    a = await signup('Widget Agency', 'owner@widget.test');
  });

  test('the form is off until the agency turns it on', async () => {
    assert.equal((await call('POST', '/v1/widget/audits', { host: a.host, body: form })).status, 404);
    assert.equal((await call('GET', '/v1/tenant', { host: a.host })).json.widgetEnabled, false);
    const on = await call('PATCH', '/v1/agency', { ...a, body: { widgetEnabled: true, branding: { ctaLabel: 'Book a free call', ctaUrl: 'https://cal.example/widget' } } });
    assert.equal(on.json.agency.widgetEnabled, true);
    assert.equal((await call('GET', '/v1/tenant', { host: a.host })).json.widgetEnabled, true);
    assert.equal((await call('POST', '/v1/widget/audits', { host: PLATFORM, body: form })).status, 404);
  });

  test('a request becomes a lead and an audit, and both sides get an email', async () => {
    mails.length = 0;
    const res = await call('POST', '/v1/widget/audits', { host: a.host, body: form });
    assert.deepEqual([res.status, res.json], [202, { ok: true, email: 'rina@northside.example' }]);

    const lead = await until('the lead to finish', async () => {
      const [l] = await leads(a);
      return l?.auditStatus === 'completed' && l;
    });
    assert.deepEqual([lead.business, lead.email, lead.status, lead.clientStatus], ['Northside Physio', 'rina@northside.example', 'audit_started', 'prospect']);
    const { report } = (await call('GET', `/v1/audits/${lead.auditId}`, a)).json;
    assert.equal(report.source, 'widget');
    assert.deepEqual(report.competitors, ['Smile Studio', 'Pearl Dental Care', 'Blue Lotus Dental'], 'the first three businesses an engine suggested');
    assert.equal(report.run.promptCount, 10);
    assert.equal(report.site.passed, 9);

    await until('two emails', async () => mails.length >= 2);
    const visitor = mails.find((m) => m.to === 'rina@northside.example')!;
    const owner = mails.find((m) => m.to === 'owner@widget.test')!;
    assert.equal(visitor.subject, 'Your AI visibility report for Northside Physio');
    assert.equal(visitor.fromName, 'Widget Agency');
    const link = visitor.text.match(/https?:\/\/\S+\/report\/\S+/)![0];
    assert.equal(new URL(link).hostname, a.host);
    const shared = await call('GET', `/v1/reports/${new URL(link).pathname.split('/').pop()}`, { host: a.host });
    assert.deepEqual(shared.json.agency, { name: 'Widget Agency', ctaLabel: 'Book a free call', ctaUrl: 'https://cal.example/widget' });
    assert.equal(owner.subject, 'New lead: Northside Physio');
    assert.match(owner.text, /Rina, rina@northside\.example/);
    assert.match(owner.text, new RegExp(`/audits/${lead.auditId}`));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mails.length, 2, 'each email is sent once');
  });

  test('bots, repeats and existing websites do not start new audits', async () => {
    const before = (await leads(a)).length;
    const bot = await call('POST', '/v1/widget/audits', { host: a.host, body: { ...form, website: 'botsite.example', company: 'filled by a bot' } });
    assert.equal(bot.status, 202);
    const repeat = await call('POST', '/v1/widget/audits', { host: a.host, body: form });
    assert.equal(repeat.status, 202);
    assert.equal((await leads(a)).length, before, 'neither was recorded');

    mails.length = 0;
    await call('POST', '/v1/widget/audits', { host: a.host, body: { ...form, email: 'someone.else@northside.example' } });
    const lead = await until('the lead', async () => (await leads(a)).find((l: any) => l.email === 'someone.else@northside.example' && l.status === 'not_run'));
    assert.equal(lead.note, 'This website already has an audit or is one of your clients');
    await until('two emails', async () => mails.length >= 2);
    assert.equal(mails.find((m) => m.to === 'someone.else@northside.example')!.subject, 'Your AI visibility report for Northside Physio');
    assert.match(mails.find((m) => m.to === 'owner@widget.test')!.text, /did not run: This website already has an audit/);
    assert.equal((await call('GET', '/v1/audits', a)).json.audits.length, 1);
  });

  test('when the monthly audits are used up, the lead is kept and both sides are told', async () => {
    await ownerPool.query(`INSERT INTO plans (key, name, monthly_credits, client_limit, samples_per_prompt, prompts_per_client, audits_per_month) VALUES ('none', 'No audits', 5000, 5, 3, 25, 0)`);
    await ownerPool.query(`UPDATE agencies SET plan_id = (SELECT id FROM plans WHERE key = 'none') WHERE id = $1`, [a.agencyId]);
    mails.length = 0;
    await call('POST', '/v1/widget/audits', { host: a.host, body: { ...form, businessName: 'Late Physio', website: 'late.example', email: 'late@late.example' } });
    const lead = await until('the lead', async () => (await leads(a)).find((l: any) => l.email === 'late@late.example' && l.status === 'not_run'));
    assert.equal(lead.note, 'Your plan includes 0 audits a month and all of them have been used.');
    assert.equal(lead.clientStatus, null, 'the half-made prospect was removed');
    await until('two emails', async () => mails.length >= 2);
    assert.equal(mails.find((m) => m.to === 'late@late.example')!.text.includes('will be in touch'), true);
  });
});

describe('tenant isolation for audits and leads', () => {
  test('another agency, a client viewer and the database all keep audits private', async () => {
    const a = await signup('Private One', 'owner@private1.test');
    const b = await signup('Private Two', 'owner@private2.test');
    const audit = await newAudit(a);
    const done = await finished(a, audit.json.audit.id);
    await call('PATCH', '/v1/agency', { ...a, body: { widgetEnabled: true } });
    await call('POST', '/v1/widget/audits', { host: a.host, body: { businessName: 'Lead Co', website: 'leadco.example', category: 'cafe', email: 'x@leadco.example' } });
    await until('the lead', async () => (await call('GET', '/v1/leads', a)).json.leads[0]?.status !== 'received' || null);

    for (const [method, url] of [
      ['GET', `/v1/audits/${audit.json.audit.id}`],
      ['POST', `/v1/audits/${audit.json.audit.id}/share-link`],
      ['DELETE', `/v1/audits/${audit.json.audit.id}`],
    ] as const) {
      assert.equal((await call(method, url, b)).status, 404, `${method} ${url}`);
    }
    assert.deepEqual((await call('GET', '/v1/audits', b)).json.audits, []);
    assert.deepEqual((await call('GET', '/v1/leads', b)).json.leads, []);
    assert.equal((await call('GET', `/v1/reports/${done.report.shareToken}`, { host: b.host })).status, 404);

    // A client viewer of one of agency A's clients sees no audits or leads.
    const client = (await call('POST', '/v1/clients', { ...a, body: { name: 'Viewer Co' } })).json.client;
    const invite = await call('POST', '/v1/team/invites', { ...a, body: { role: 'client_viewer', email: 'viewer@viewer.test', clientId: client.id } });
    const token = new URL(invite.json.inviteUrl).pathname.split('/').pop();
    const viewer = { host: a.host, cookie: (await call('POST', '/v1/invites/accept', { host: a.host, body: { token, name: 'V', password: PASSWORD } })).cookie! };
    for (const url of ['/v1/audits', '/v1/leads', `/v1/audits/${audit.json.audit.id}`, '/v1/audits/estimate']) {
      assert.equal((await call('GET', url, viewer)).status, 403, url);
    }
    assert.equal((await call('POST', '/v1/audits', { ...viewer, body: {} })).status, 403);

    for (const table of ['audits', 'leads', 'site_audits']) {
      assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} with no tenant set`);
    }
    const db = await appPool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.agency_id', $1, true)`, [b.agencyId]);
      for (const table of ['audits', 'leads', 'site_audits']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
      await assert.rejects(
        db.query(`INSERT INTO leads (agency_id, email, business_name, domain, category) VALUES ($1, 'x@y.z', 'Planted', 'p.example', 'x')`, [a.agencyId]),
        (err: any) => err.code === '42501',
      );
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
  });
});
