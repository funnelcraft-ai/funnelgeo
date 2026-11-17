import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { closePools, ownerPool, withTenant } from '../src/db.js';
import { checkPage } from '../src/diagnosis/jobs.js';
import { classifySource, type ClassifyContext } from '../src/diagnosis/sources.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-diagnosis`;

const BESTOF = 'https://www.bestof.example/best-dentists-pune';
const YELP = 'https://www.yelp.com/search?find_desc=dentist&find_loc=Pune';
const REDDIT = 'https://www.reddit.com/r/pune/comments/abc/good_dentist';
const SMILE_PAGE = 'https://smilestudio.example/implants';
const HEALTHLINE = 'https://www.healthline.com/health/kids-dentist';

// Scripted engines: each question is answered the same way on every engine,
// except "reviews", where ChatGPT alone leaves the client out.
let round = 1;
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 5, tokensOut: 20, costUsd: null });
function script(engine: string, prompt: string): EngineAnswer {
  if (prompt.includes('Best dentist')) {
    return round === 1
      ? answer('Smile Studio is a top choice in Pune.', [BESTOF, YELP])
      : answer('Blue Lotus Dental is the top choice now.', [BESTOF]);
  }
  if (prompt.includes('implants')) return answer('Smile Studio offers implants from ₹30,000.', [SMILE_PAGE]);
  if (prompt.includes('Emergency')) return answer('Pearl Clinic opens on Sundays.');
  if (prompt.includes('whitening')) return answer('Blue Lotus Dental does whitening.', ['https://bluelotus.example/whitening']);
  if (prompt.includes('reviews')) {
    return engine === 'chatgpt'
      ? answer('People on Reddit like Pearl Clinic.', [REDDIT])
      : answer('BlueLotus and Pearl Clinic are both well reviewed.', [REDDIT]);
  }
  if (prompt.includes('Kids')) return round === 1 ? answer('Ask your family doctor for a referral.', [HEALTHLINE]) : answer('Smile Studio is good with children.', [HEALTHLINE]);
  return answer('No idea.');
}
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [key, { key, ask: async (prompt) => script(key, prompt) }]),
  ),
};

// The web as the worker sees it.
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
const filler = 'Choosing a dentist takes some care, so we looked at prices, reviews, opening hours and how easy it is to book. '.repeat(4);
const opened: string[] = [];
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => {
  opened.push(url);
  const page = (status: number, body: string, contentType = 'text/html'): FetchedPage => ({ url, finalUrl: url, status, contentType, body });
  if (url === BESTOF) return page(200, html('Best dentists in Pune for 2026', `${filler} 1. Smile Studio. 2. Pearl Clinic.`));
  if (url === YELP) return page(403, 'Forbidden');
  if (url === REDDIT) return page(200, html('Good dentist? : r/pune', `${filler} I went to Blue Lotus Dental and to Pearl Clinic, both fine.`));
  if (url === HEALTHLINE) return page(200, html('Finding a dentist for kids', filler));
  const { hostname, pathname } = new URL(url);
  if (pathname === '/robots.txt') {
    return page(200, hostname === 'coral.example' ? 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' : 'User-agent: *\nAllow: /\n', 'text/plain');
  }
  if (pathname === '/') return page(200, html('Home', filler));
  return page(404, html('Not found', ''));
};

const mails: Mail[] = [];
const mailer = { enabled: true, async send(mail: Mail) { mails.push(mail); } };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let owner: { host: string; cookie: string; agencyId: string };
let clientId: string;
let firstRunId: string;

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

async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId as string };
}

async function addClient(who: typeof owner, name: string, domain: string, aliases: string[], prompts: string[], competitors: [string, string][]) {
  const client = (await call('POST', '/v1/clients', { ...who, body: { name, domain, brandAliases: aliases } })).json.client;
  for (const [n, d] of competitors) assert.equal((await call('POST', `/v1/clients/${client.id}/competitors`, { ...who, body: { name: n, domain: d } })).status, 201);
  assert.equal((await call('POST', `/v1/clients/${client.id}/prompts`, { ...who, body: { prompts: prompts.map((text) => ({ text })) } })).status, 201);
  return client.id as string;
}

/** Starts a run and waits for it and its diagnosis follow-up to finish. */
async function runAndDiagnose(who: typeof owner, id: string) {
  const started = await call('POST', `/v1/clients/${id}/runs`, who);
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const runId = started.json.run.id as string;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { json } = await call('GET', `/v1/clients/${id}/diagnosis?run=${runId}`, who);
    if (json.diagnosis?.status === 'done') {
      const emailed = await ownerPool.query(`SELECT emailed_at FROM diagnoses WHERE run_id = $1`, [runId]);
      if (emailed.rows[0]?.emailed_at || Date.now() > deadline - 25_000) return { runId, diagnosis: json.diagnosis };
    }
    assert.ok(Date.now() < deadline, `diagnosis of ${runId} did not finish`);
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
  owner = await signup('Lotus Partners', 'owner@lotus-partners.example');
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('source types', () => {
  const ctx: ClassifyContext = {
    clientDomain: 'bluelotus.example',
    competitors: [{ id: 'c1', domain: 'smilestudio.example' }],
    overrides: new Map([['blog.example.org', 'news'], ['example.org', 'directory']]),
  };
  const type = (url: string, title?: string) => classifySource(url, new URL(url).hostname.replace(/^www\./, ''), ctx, title).type;

  test('own and competitor sites follow the client’s brands, including subdomains', () => {
    assert.equal(type('https://www.bluelotus.example/whitening'), 'own');
    assert.equal(type('https://book.smilestudio.example/'), 'competitor');
    assert.equal(classifySource('https://smilestudio.example/', 'smilestudio.example', ctx).competitorId, 'c1');
  });

  test('well-known sites and page addresses decide the rest, and anything unknown is "other"', () => {
    assert.equal(type(REDDIT), 'forum');
    assert.equal(type('https://www.youtube.com/watch?v=abc'), 'forum');
    assert.equal(type(YELP), 'directory');
    assert.equal(type('https://www.justdial.com/Pune/Dentists'), 'directory');
    assert.equal(type('https://www.nytimes.com/2026/03/01/health/teeth.html'), 'news');
    assert.equal(type('https://www.forbes.com/advisor/health/best-dentists-pune/'), 'list_review');
    assert.equal(type('https://www.ndtv.com/health/top-10-dental-clinics'), 'list_review', 'a ranking on a news site is a list');
    assert.equal(type('https://some-site.example/smile-studio-vs-pearl-clinic'), 'list_review');
    assert.equal(type('https://community.example.net/thread/91'), 'forum');
    assert.equal(type('https://localpaper.example/news/clinic-opens'), 'news');
    assert.equal(type('https://some-site.example/about-us'), 'other');
    assert.equal(type('https://some-site.example/page-7', 'The 9 best dental clinics in Pune'), 'list_review', 'the title is used once a page is opened');
    assert.equal(type('https://desktop.example/stop-smoking'), 'other', '"top" inside a word does not count');
  });

  test('an agency correction wins over the rules, the most specific one first', () => {
    assert.equal(type('https://blog.example.org/post'), 'news');
    assert.equal(type('https://example.org/best-dentists'), 'directory');
    assert.equal(classifySource('https://example.org/', 'example.org', ctx).corrected, true);
  });
});

describe('page checks', () => {
  const brands = [
    { competitorId: null, name: 'Blue Lotus Dental', aliases: ['BlueLotus'], domain: 'bluelotus.example' },
    { competitorId: 'c1', name: 'Smile Studio', aliases: [], domain: 'smilestudio.example' },
  ];
  const serve = (status: number, body: string, contentType = 'text/html'): SiteFetcher => async (url) => ({ url, finalUrl: url, status, contentType, body });

  test('a brand counts as listed by name, alias or a link to its site', async () => {
    const byLink = await checkPage(serve(200, html('Clinics', `${filler}<a href="https://www.bluelotus.example/book">Book</a>`)), 'https://x.example/', brands);
    assert.deepEqual([byLink.status, byLink.listsClient, byLink.listsCompetitors], ['done', true, []]);
    const byName = await checkPage(serve(200, html('Clinics', `${filler} Smile Studio is great.`)), 'https://x.example/', brands);
    assert.deepEqual([byName.listsClient, byName.listsCompetitors, byName.title], [false, ['c1'], 'Clinics']);
  });

  test('errors, non-HTML files and pages with no text are recorded as not checked, with the reason', async () => {
    assert.match((await checkPage(serve(403, 'no'), 'https://x.example/', brands)).error!, /403/);
    assert.match((await checkPage(serve(200, '%PDF', 'application/pdf'), 'https://x.example/', brands)).error!, /Not a web page/);
    assert.match((await checkPage(serve(200, html('App', '')), 'https://x.example/', brands)).error!, /JavaScript/);
    const refused = await checkPage(async () => { throw new Error('That address is not on the public internet'); }, 'http://10.0.0.1/', brands);
    assert.deepEqual([refused.status, refused.listsClient], ['failed', null]);
  });
});

describe('diagnosis of a run', () => {
  test('every lost question has a cause and at least one linked source (the PRD exit check)', async () => {
    clientId = await addClient(owner, 'Blue Lotus Dental', 'bluelotus.example', ['BlueLotus'], [
      'Best dentist in Pune',
      'How much do dental implants cost',
      'Emergency dentist open on Sunday',
      'Teeth whitening near me',
      'Dentist reviews Pune',
      'Kids dentist Pune',
    ], [['Smile Studio', 'smilestudio.example'], ['Pearl Clinic', 'pearl.example']]);
    const { runId, diagnosis: d } = await runAndDiagnose(owner, clientId);
    firstRunId = runId;

    const byText = (start: string) => d.prompts.find((p: any) => p.text.startsWith(start));
    assert.deepEqual(
      d.prompts.map((p: any) => [p.text.split(' ')[0], p.status]),
      [['Best', 'lost'], ['How', 'lost'], ['Emergency', 'lost'], ['Teeth', 'won'], ['Dentist', 'lost'], ['Kids', 'open']],
    );
    assert.deepEqual([d.totals.lost, d.totals.won, d.totals.open, d.totals.questions], [4, 1, 1, 6]);

    for (const p of d.prompts.filter((x: any) => x.status === 'lost')) {
      assert.ok(p.cause, `no cause for "${p.text}"`);
      assert.ok(p.cause.sentence.length > 20 && !p.cause.sentence.includes('undefined'), p.cause.sentence);
      assert.ok(p.cause.sources.length >= 1, `no source for "${p.text}"`);
      for (const s of p.cause.sources) assert.match(s.url, /^https:\/\//);
    }
    for (const p of d.prompts.filter((x: any) => x.status !== 'lost')) assert.equal(p.cause, null);

    // Third-party pages, after they were opened: one doesn't list the client, one couldn't be read.
    const best = byText('Best').cause;
    assert.equal(best.kind, 'third_party');
    assert.equal(best.sentence, 'Smile Studio is named from 2 third-party pages; 1 of them doesn’t list Blue Lotus Dental.');
    assert.deepEqual(best.sources.map((s: any) => [s.url, s.type, s.check]), [[BESTOF, 'list_review', 'not_listed'], [YELP, 'directory', 'failed']]);
    assert.equal(best.sources[0].title, 'Best dentists in Pune for 2026');

    const implants = byText('How').cause;
    assert.equal(implants.kind, 'competitor_site');
    assert.equal(implants.sentence, 'The answers cite Smile Studio’s own website and name Smile Studio. Blue Lotus Dental’s site isn’t cited for this question.');
    assert.equal(implants.sources[0].url, SMILE_PAGE);

    // No sources at all: points to where the winner is cited elsewhere in the run.
    const emergency = byText('Emergency').cause;
    assert.equal(emergency.kind, 'uncited');
    assert.equal(emergency.sentence, 'ChatGPT, Perplexity and Gemini named Pearl Clinic without citing any source, so the choice came from what those engines already know about these brands.');
    assert.deepEqual(emergency.sources.map((s: any) => [s.url, s.elsewhere]), [[REDDIT, true]]);

    // Lost on ChatGPT only, from a thread that does mention the client.
    const reviews = byText('Dentist reviews');
    assert.deepEqual(reviews.engines.filter((e: any) => e.lost).map((e: any) => e.key), ['chatgpt']);
    assert.equal(reviews.cause.sentence, 'Pearl Clinic is named from a forum or social post that also lists Blue Lotus Dental, but the answers picked Pearl Clinic over it.');
    assert.equal(reviews.cause.sources[0].check, 'listed');
  });

  test('citation gaps are third-party sites cited at least twice where only competitors were named', async () => {
    const { json } = await call('GET', `/v1/clients/${clientId}/diagnosis`, owner);
    const d = json.diagnosis;
    const samples = json.run.samples as number;
    assert.deepEqual(
      d.gaps.map((g: any) => [g.domain, g.answers, g.competitors]),
      [['bestof.example', 3 * samples, ['Smile Studio']], ['yelp.com', 3 * samples, ['Smile Studio']], ['reddit.com', samples, ['Pearl Clinic']]],
    );
    // Competitor sites are never gaps; healthline.com was cited only where nobody was named.
    assert.ok(!d.gaps.some((g: any) => ['smilestudio.example', 'healthline.com', 'bluelotus.example'].includes(g.domain)));
    assert.deepEqual(d.gaps[0].pages, { checked: 1, listsClient: 0, failed: 0 });
    assert.deepEqual(d.gaps[1].pages, { checked: 0, listsClient: 0, failed: 1 });
    assert.deepEqual(d.gaps[2].pages, { checked: 1, listsClient: 1, failed: 0 }, 'the thread does mention the client');

    const types = Object.fromEntries(d.sources.domains.map((s: any) => [s.domain, s.type]));
    assert.deepEqual(types, { 'bestof.example': 'list_review', 'yelp.com': 'directory', 'smilestudio.example': 'competitor', 'bluelotus.example': 'own', 'reddit.com': 'forum', 'healthline.com': 'other' });
    assert.equal(d.sources.byType.find((t: any) => t.type === 'competitor').answers, 3 * samples);
  });

  test('cited pages are opened once and reused, never the client’s or competitors’ own', async () => {
    assert.deepEqual([...new Set(opened.filter((u) => !u.includes('bluelotus.example')))].sort(), [BESTOF, REDDIT, YELP].sort());
    const { rows } = await ownerPool.query(`SELECT url, status FROM source_pages WHERE client_id = $1 ORDER BY url`, [clientId]);
    assert.equal(rows.length, 3);
  });

  test('the client’s website is checked with the run, and again on request', async () => {
    const { json } = await call('GET', `/v1/clients/${clientId}/diagnosis`, owner);
    assert.equal(json.diagnosis.site.status, 'done');
    assert.equal(json.diagnosis.site.findings.domain, 'bluelotus.example');

    // One check at a time: a check still running blocks another.
    const { rows: held } = await ownerPool.query(
      `INSERT INTO site_audits (agency_id, client_id, domain, mode) VALUES ($1, $2, 'bluelotus.example', 'live') RETURNING id`,
      [owner.agencyId, clientId],
    );
    assert.equal((await call('POST', `/v1/clients/${clientId}/site-check`, owner)).status, 409);
    await ownerPool.query(`DELETE FROM site_audits WHERE id = $1`, [held[0].id]);

    const again = await call('POST', `/v1/clients/${clientId}/site-check`, owner);
    assert.equal(again.status, 202);
    const deadline = Date.now() + 20_000;
    while ((await call('GET', `/v1/site-checks/${again.json.siteCheck.id}`, owner)).json.siteCheck.status === 'pending') {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await call('GET', `/v1/clients/${clientId}/diagnosis`, owner)).json.diagnosis.site.id, again.json.siteCheck.id);
  });

  test('a blocked AI crawler is named as the cause on that engine', async () => {
    const coral = await addClient(owner, 'Coral Dental', 'coral.example', [], ['Dentist reviews in Baner'], [['Pearl Clinic', 'pearl.example']]);
    const { diagnosis } = await runAndDiagnose(owner, coral);
    const cause = diagnosis.prompts[0].cause;
    assert.equal(cause.kind, 'blocked');
    assert.equal(cause.sentence, 'Coral Dental’s robots.txt blocks OAI-SearchBot, so ChatGPT can’t read its site; Pearl Clinic is named instead.');
    assert.equal(cause.sources[0].url, 'https://coral.example/robots.txt');
  });

  test('the owners get one summary email per run, with what moved since the last run', async () => {
    const first = mails.filter((m) => m.subject.startsWith('Blue Lotus Dental'));
    assert.equal(first.length, 1);
    assert.equal(first[0]!.to, 'owner@lotus-partners.example');
    assert.match(first[0]!.text, /4 of 6 questions were lost/);
    assert.match(first[0]!.text, /This is the first completed run/);
    assert.match(first[0]!.text, new RegExp(`/clients/${clientId}\\?tab=diagnosis`));

    round = 2;
    await runAndDiagnose(owner, clientId);
    const second = mails.filter((m) => m.subject.startsWith('Blue Lotus Dental'));
    assert.equal(second.length, 2);
    assert.match(second[1]!.text, /Newly won: “Best dentist in Pune”/);
    assert.match(second[1]!.text, /Newly lost: “Kids dentist Pune”/);
    assert.match(second[1]!.text, /up from/);
  });

  test('owners can turn the summary off', async () => {
    assert.equal((await call('PATCH', '/v1/agency', { ...owner, body: { runEmails: 'off' } })).json.agency.runEmails, 'off');
    const before = mails.length;
    await runAndDiagnose(owner, clientId);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mails.length, before);
    await call('PATCH', '/v1/agency', { ...owner, body: { runEmails: 'owners' } });
  });
});

describe('corrections and access', () => {
  test('a corrected source type applies across the agency’s clients and past runs, and can be undone', async () => {
    assert.equal((await call('PUT', '/v1/source-types/healthline.com', { ...owner, body: { type: 'news' } })).status, 200);
    const view = async () => (await call('GET', `/v1/clients/${clientId}/diagnosis?run=${firstRunId}`, owner)).json.diagnosis.sources.domains.find((s: any) => s.domain === 'healthline.com');
    assert.deepEqual([(await view()).type, (await view()).corrected], ['news', true]);
    assert.equal((await call('PUT', '/v1/source-types/bad%20domain', { ...owner, body: { type: 'news' } })).status, 400);
    assert.equal((await call('PUT', '/v1/source-types/x.example', { ...owner, body: { type: 'own' } })).status, 400, 'own and competitor follow the brands');
    await call('DELETE', '/v1/source-types/healthline.com', owner);
    assert.equal((await view()).type, 'other');
  });

  test('another agency sees neither the diagnosis nor the corrections', async () => {
    await call('PUT', '/v1/source-types/healthline.com', { ...owner, body: { type: 'news' } });
    const other = await signup('Other Agency', 'owner@other-agency.example');
    assert.equal((await call('GET', `/v1/clients/${clientId}/diagnosis`, other)).status, 404);
    assert.equal((await call('POST', `/v1/clients/${clientId}/site-check`, other)).status, 404);
    const seen = await withTenant({ agencyId: other.agencyId }, (db) => db.query(`SELECT * FROM source_overrides`));
    assert.equal(seen.rows.length, 0);
    const pages = await withTenant({ agencyId: other.agencyId }, (db) => db.query(`SELECT * FROM source_pages UNION ALL SELECT * FROM source_pages`));
    assert.equal(pages.rows.length, 0);
  });

  test('client viewers cannot open the diagnosis', async () => {
    await ownerPool.query(
      `INSERT INTO users (agency_id, client_id, email, name, password_hash, role) VALUES ($1, $2, 'viewer@bluelotus.example', 'Viewer', $3, 'client_viewer')`,
      [owner.agencyId, clientId, await hashPassword(PASSWORD)],
    );
    const login = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'viewer@bluelotus.example', password: PASSWORD } });
    const viewer = { host: owner.host, cookie: login.cookie! };
    assert.equal((await call('GET', `/v1/clients/${clientId}/diagnosis`, viewer)).status, 403);
    assert.equal((await call('PUT', '/v1/source-types/reddit.com', { ...viewer, body: { type: 'news' } })).status, 403);
    // And the tables refuse a viewer's session at the database too.
    const rows = await withTenant({ agencyId: owner.agencyId, clientId }, (db) => db.query(`SELECT * FROM source_pages`));
    assert.equal(rows.rows.length, 0);
  });
});
