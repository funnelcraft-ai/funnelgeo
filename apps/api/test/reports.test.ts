import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FetchedPage, SiteFetcher } from '../src/audits/fetch.js';
import { config } from '../src/config.js';
import { closePools, ownerPool } from '../src/db.js';
import type { EngineAdapter, EngineAnswer, EngineSet } from '../src/engines.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { draftDueReports } from '../src/reports/service.js';
import { hashPassword } from '../src/security.js';
import type { WriteRequest, Writer } from '../src/writer.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-reports`;
const MONTH = new Date().toISOString().slice(0, 7);

// Round 1: the client is never named. Round 2: named everywhere.
let round = 1;
const answer = (text: string, citations: string[] = []): EngineAnswer => ({ text, citations, tokensIn: 5, tokensOut: 20, costUsd: null });
const engines: EngineSet = {
  mode: 'live',
  available: new Map(
    ['chatgpt', 'perplexity', 'gemini'].map((key): [string, EngineAdapter] => [
      key,
      { key, ask: async () => (round === 1 ? answer('Smile Studio is the top choice.', ['https://smilestudio.example/x']) : answer('Blue Lotus Dental and Smile Studio are both good.')) },
    ]),
  ),
};
const fetcher: SiteFetcher = async (url): Promise<FetchedPage> => ({ url, finalUrl: url, status: 404, contentType: 'text/html', body: '' });

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
    return { text: 'This month Blue Lotus Dental was named in 50% of 18 AI answers, up from none before.', model: 'fake', tokensIn: 300, tokensOut: 80 };
  },
};

const pdfUrls: string[] = [];
let pdfFails = false;
const renderPdf = async (url: string) => {
  pdfUrls.push(url);
  if (pdfFails) throw new Error('Chrome crashed');
  return Buffer.from('%PDF-1.7\nfake report\n%%EOF');
};

const mails: Mail[] = [];
const mailer = { enabled: true, async send(mail: Mail) { mails.push(mail); } };

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let owner: { host: string; cookie: string; agencyId: string };
let clientId: string;
let reportId: string;

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({ method, url, headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
  const sid = res.cookies.find((c) => c.name === 'sid');
  let json: any = null;
  try { json = res.json(); } catch { /* a file */ }
  return { status: res.statusCode, json, raw: res.rawPayload, headers: res.headers, cookie: sid ? `sid=${sid.value}` : undefined };
}

async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName, name: 'Owner', email, password: PASSWORD } });
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  return { host: url.hostname, cookie: handoff.cookie!, agencyId: handoff.json.user.agencyId as string };
}

async function runAndWait(id = clientId) {
  const started = await call('POST', `/v1/clients/${id}/runs`, owner);
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await ownerPool.query(`SELECT status FROM diagnoses WHERE run_id = $1`, [started.json.run.id]);
    if (rows[0]?.status === 'done') return;
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const getReport = async (id = reportId, who = owner) => (await call('GET', `/v1/monthly-reports/${id}`, who)).json;
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
  workers = startWorkers(engines, { prefix: PREFIX, audit: { fetcher, mailer, queue, siteMode: 'live', writer, renderPdf } });
  app = await buildApp({ engines, queue, mailer, writer });
  owner = await signup('Lotus Partners', 'owner@lotus-partners.example');
  await call('PATCH', '/v1/agency', { ...owner, body: { branding: { primaryColor: '#0f766e', senderName: 'Lotus Partners Team' } } });

  clientId = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Blue Lotus Dental', domain: 'bluelotus.example' } })).json.client.id;
  await call('POST', `/v1/clients/${clientId}/competitors`, { ...owner, body: { name: 'Smile Studio', domain: 'smilestudio.example' } });
  await call('POST', `/v1/clients/${clientId}/prompts`, { ...owner, body: { prompts: [{ text: 'Best dentist in Pune' }] } });

  // A month of work: a run, an action done, another run; two AI visits.
  await runAndWait();
  const { rows } = await ownerPool.query(`SELECT id FROM actions WHERE client_id = $1 AND key LIKE 'content:%'`, [clientId]);
  await call('PATCH', `/v1/actions/${rows[0].id}`, { ...owner, body: { status: 'approved' } });
  await call('PATCH', `/v1/actions/${rows[0].id}`, { ...owner, body: { status: 'done', doneUrl: 'https://bluelotus.example/best-dentist' } });
  round = 2;
  await runAndWait();
  await ownerPool.query(`UPDATE clients SET snippet_seen_at = now() WHERE id = $1`, [clientId]);
  for (const [engine, path, converted] of [['chatgpt', '/best-dentist', true], ['perplexity', '/', false]] as const) {
    await ownerPool.query(
      `INSERT INTO ai_visits (agency_id, client_id, source_engine, via, landing_url, landing_path, session_hash, converted, conversion_name)
       VALUES ($1, $2, $3, 'referrer', $4, $5, $6, $7, $8)`,
      [owner.agencyId, clientId, engine, `https://bluelotus.example${path}`, path, engine.padEnd(64, '0'), converted, converted ? 'Booking' : null],
    );
  }
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
});

describe('from draft to the client’s inbox (PRD exit check)', () => {
  test('a report generates with the month’s figures and an AI summary, for one credit', async () => {
    const before = await credits();
    const made = await call('POST', `/v1/clients/${clientId}/reports`, { ...owner, body: { month: MONTH } });
    assert.equal(made.status, 201);
    reportId = made.json.report.id;
    const r = (await until(getReport, (x) => x.report.summaryState !== 'pending')).report;
    assert.equal(r.status, 'draft');
    assert.equal(r.summaryState, 'done');
    assert.match(r.summaryText, /named in 50% of 18/);
    assert.equal(r.liveUrl, null, 'no live link before approval');
    assert.equal(await credits(), before - 1);

    const d = r.data;
    assert.equal(d.runs, 2);
    assert.equal(d.questions, 1);
    assert.deepEqual([d.overall.named, d.overall.answers], [9, 18]);
    assert.deepEqual(d.engines.map((e: any) => [e.label, e.now.named, e.now.answers]), [['ChatGPT', 3, 6], ['Perplexity', 3, 6], ['Gemini', 3, 6]]);
    assert.deepEqual(d.shareOfVoice.map((b: any) => [b.name, b.answers, Math.round(b.share * 100)]), [['Smile Studio', 18, 67], ['Blue Lotus Dental', 9, 33]]);
    assert.deepEqual(d.trend.map((t: any) => [t.named, t.answers]), [[0, 9], [9, 9]]);
    assert.equal(d.actionsDone.length, 1);
    assert.equal(d.actionsDone[0].change, 'improved');
    assert.deepEqual([d.visits.installed, d.visits.total, d.visits.conversions], [true, 2, 1]);
    assert.deepEqual(d.plan, [], 'nothing left in the queue: the only lost question is now won');
    assert.deepEqual(d.method.engines, ['ChatGPT', 'Perplexity', 'Gemini']);
    assert.equal(d.method.samplesPerQuestion, 3);
    assert.equal(r.planText, 'Keep tracking the same questions and review new suggestions after each run.');

    // The model gets only the facts, and the rules against claiming cause.
    const req = asked.at(-1)!;
    assert.match(req.system, /Never say an action caused a change/);
    assert.match(req.system, /Use only the facts given/);
    assert.match(req.prompt, /Named in AI answers: 50% \(9 of 18 answers\)/);
    assert.match(req.prompt, /Agency: Lotus Partners/);
  });

  test('drafting the same month again returns the same report', async () => {
    const again = await call('POST', `/v1/clients/${clientId}/reports`, { ...owner, body: { month: MONTH } });
    assert.deepEqual([again.status, again.json.report.id, again.json.created], [200, reportId, false]);
    assert.equal((await call('POST', `/v1/clients/${clientId}/reports`, { ...owner, body: { month: '2099-01' } })).status, 400);
  });

  test('it is edited, and nothing can be sent or opened by link before approval', async () => {
    const edited = await call('PATCH', `/v1/monthly-reports/${reportId}`, {
      ...owner,
      body: { summaryText: 'In November we tracked one question across three AI assistants. Blue Lotus Dental went from not being named to being named in every answer in the second run.', planText: '- Publish the implants page\n- Get listed on bestof.example' },
    });
    assert.equal(edited.status, 200);
    assert.match(edited.json.report.summaryText, /^In November we tracked/);
    assert.equal(edited.json.report.planText, '- Publish the implants page\n- Get listed on bestof.example');

    assert.equal((await call('POST', `/v1/monthly-reports/${reportId}/send`, { ...owner, body: { recipients: ['client@bluelotus.example'] } })).status, 409);
    const { rows } = await ownerPool.query(`SELECT share_token FROM reports WHERE id = $1`, [reportId]);
    assert.equal((await call('GET', `/v1/client-reports/${rows[0].share_token}`, { host: owner.host })).status, 404);
  });

  test('approval needs a summary, freezes the figures, and opens the live link on the agency’s address only', async () => {
    const approved = await call('PATCH', `/v1/monthly-reports/${reportId}`, { ...owner, body: { status: 'approved' } });
    assert.equal(approved.json.report.status, 'approved');
    assert.equal(approved.json.report.approvedBy, 'Owner');
    const live = approved.json.report.liveUrl as string;
    assert.match(live, new RegExp(`^https://${owner.host.replace(/\./g, '\\.')}/r/[A-Za-z0-9_-]{32,}$`));

    assert.equal((await call('PATCH', `/v1/monthly-reports/${reportId}`, { ...owner, body: { summaryText: 'Changed after approval, which should fail.' } })).status, 409);
    assert.equal((await call('POST', `/v1/monthly-reports/${reportId}/refresh`, owner)).status, 409);

    const token = live.split('/r/')[1];
    const page = await call('GET', `/v1/client-reports/${token}`, { host: owner.host });
    assert.equal(page.status, 200);
    assert.equal(page.json.agency.name, 'Lotus Partners');
    assert.match(page.json.report.summaryText, /^In November/);
    const other = await signup('Other Agency', 'owner@other.example');
    assert.equal((await call('GET', `/v1/client-reports/${token}`, { host: other.host })).status, 404, 'not on another agency’s address');
    assert.equal((await call('GET', `/v1/client-reports/${token}`, { host: PLATFORM })).status, 404, 'not on the platform’s address');
  });

  test('it is received by email from the agency, with the PDF of the live page, and no trace of the platform', async () => {
    // Full whitelabel: the agency's own verified domain, so no link carries the platform's address.
    await ownerPool.query(`UPDATE agencies SET custom_domain = 'reports.lotuspartners.example', domain_status = 'verified' WHERE id = $1`, [owner.agencyId]);
    mails.length = 0;
    const sent = await call('POST', `/v1/monthly-reports/${reportId}/send`, { ...owner, body: { recipients: ['Client@BlueLotus.example', 'client@bluelotus.example', 'manager@bluelotus.example'] } });
    assert.equal(sent.status, 202);
    const r = (await until(getReport, (x) => x.report.sendState !== 'pending')).report;
    assert.deepEqual([r.status, r.sendState, r.sendError], ['sent', 'done', null]);
    assert.ok(r.sentAt);
    assert.deepEqual(r.recipients, ['client@bluelotus.example', 'manager@bluelotus.example']);

    assert.equal(pdfUrls.at(-1), r.liveUrl, 'the PDF is printed from the live page itself');
    assert.match(r.liveUrl, /^https:\/\/reports\.lotuspartners\.example\/r\//);
    assert.equal(mails.length, 2);
    const mail = mails[0]!;
    assert.equal(mail.to, 'client@bluelotus.example');
    assert.equal(mail.fromName, 'Lotus Partners Team');
    assert.equal(mail.subject, `Blue Lotus Dental: AI visibility report for ${r.data.period.label}`);
    assert.ok(mail.html.includes(r.liveUrl) && mail.text.includes(r.liveUrl));
    assert.equal(mail.attachments?.[0]?.contentType, 'application/pdf');
    assert.match(mail.attachments![0]!.filename, new RegExp(`^blue-lotus-dental-ai-visibility-${MONTH}\\.pdf$`));
    assert.match(mail.html, /#0f766e|Lotus Partners/);
    for (const part of [mail.subject, mail.text, mail.html, mail.fromName, mail.attachments![0]!.filename]) {
      assert.ok(!part.includes(config.platformName), `platform name found in: ${part.slice(0, 80)}`);
      assert.ok(!part.includes(PLATFORM), 'platform address found');
    }

    const pdf = await call('GET', `/v1/monthly-reports/${reportId}/pdf`, owner);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.raw.subarray(0, 5).toString(), '%PDF-');
    // Remembered for next month, without the dashboard users.
    assert.deepEqual((await ownerPool.query(`SELECT report_emails FROM clients WHERE id = $1`, [clientId])).rows[0].report_emails, ['client@bluelotus.example', 'manager@bluelotus.example']);
  });

  test('a sent report can’t be reopened, but can be sent again', async () => {
    assert.equal((await call('PATCH', `/v1/monthly-reports/${reportId}`, { ...owner, body: { status: 'draft' } })).status, 409);
    mails.length = 0;
    await call('POST', `/v1/monthly-reports/${reportId}/send`, { ...owner, body: { recipients: ['owner@bluelotus.example'] } });
    await until(getReport, (x) => x.report.sendState !== 'pending');
    assert.deepEqual(mails.map((m) => m.to), ['owner@bluelotus.example']);
  });
});

describe('when things go wrong', () => {
  let second: string;
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  test('a failed summary is marked failed and its credit comes back', async () => {
    const before = await credits();
    failNext = true;
    second = (await call('POST', `/v1/clients/${clientId}/reports`, { ...owner, body: { month: lastMonth } })).json.report.id;
    const r = (await until(() => getReport(second), (x) => x.report.summaryState !== 'pending')).report;
    assert.equal(r.summaryState, 'failed');
    assert.match(r.summaryError, /529/);
    assert.equal(await credits(), before);
    assert.equal(r.data.runs, 0, 'no runs last month');
  });

  test('approval needs a summary', async () => {
    const res = await call('PATCH', `/v1/monthly-reports/${second}`, { ...owner, body: { status: 'approved' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /Write the summary/);
  });

  test('if the PDF can’t be made, nothing is emailed and the report stays approved', async () => {
    await call('PATCH', `/v1/monthly-reports/${second}`, { ...owner, body: { summaryText: 'No runs were made last month, so there are no figures to report yet.' } });
    await call('PATCH', `/v1/monthly-reports/${second}`, { ...owner, body: { status: 'approved' } });
    pdfFails = true;
    mails.length = 0;
    await call('POST', `/v1/monthly-reports/${second}/send`, { ...owner, body: { recipients: ['client@bluelotus.example'] } });
    const r = (await until(() => getReport(second), (x) => x.report.sendState !== 'pending')).report;
    pdfFails = false;
    assert.deepEqual([r.status, r.sendState], ['approved', 'failed']);
    assert.match(r.sendError, /PDF could not be made: Chrome crashed/);
    assert.equal(mails.length, 0);
    // Reopening an approved, unsent report puts it back to draft.
    assert.equal((await call('PATCH', `/v1/monthly-reports/${second}`, { ...owner, body: { status: 'draft' } })).json.report.status, 'draft');
  });
});

describe('who sees reports', () => {
  test('client viewers see only their sent reports, and can’t change anything', async () => {
    await ownerPool.query(
      `INSERT INTO users (agency_id, client_id, email, name, password_hash, role) VALUES ($1, $2, 'viewer@bluelotus.example', 'Viewer', $3, 'client_viewer')`,
      [owner.agencyId, clientId, await hashPassword(PASSWORD)],
    );
    const login = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'viewer@bluelotus.example', password: PASSWORD } });
    const viewer = { host: owner.host, cookie: login.cookie!, agencyId: owner.agencyId };
    const list = await call('GET', `/v1/clients/${clientId}/reports`, viewer);
    assert.deepEqual(list.json.reports.map((r: any) => [r.id, r.status]), [[reportId, 'sent']]);
    assert.deepEqual(list.json.reports[0].recipients, [], 'recipients are the agency’s business');
    const drafts = (await ownerPool.query(`SELECT id FROM reports WHERE client_id = $1 AND status = 'draft'`, [clientId])).rows;
    assert.equal((await call('GET', `/v1/monthly-reports/${drafts[0].id}`, viewer)).status, 404);
    assert.equal((await call('PATCH', `/v1/monthly-reports/${reportId}`, { ...viewer, body: { summaryText: 'x'.repeat(30) } })).status, 403);
    assert.equal((await call('GET', `/v1/monthly-reports/${reportId}/pdf`, viewer)).status, 200);

    // The agency suggests the viewer as a recipient next time.
    assert.ok((await getReport()).suggestedRecipients.includes('viewer@bluelotus.example'));
  });

  test('another agency sees nothing', async () => {
    const other = await signup('Third Agency', 'owner@third.example');
    assert.equal((await call('GET', `/v1/monthly-reports/${reportId}`, other)).status, 404);
    assert.equal((await call('GET', `/v1/clients/${clientId}/reports`, other)).status, 404);
    assert.equal((await call('GET', `/v1/monthly-reports/${reportId}/pdf`, other)).status, 404);
  });
});

describe('monthly drafts', () => {
  test('on the 1st, last month’s drafts are made once, and the owners hear about it', async () => {
    const client2 = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Coral Smiles', domain: 'coral.example' } })).json.client.id;
    await call('POST', `/v1/clients/${client2}/prompts`, { ...owner, body: { prompts: [{ text: 'Dentist near Baner' }] } });
    await runAndWait(client2);

    const firstOfNext = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 2));
    mails.length = 0;
    const tasks = { reportSummary: (id: string, agencyId: string) => queue.reportSummary(id, agencyId), reportSend: async () => {} };
    assert.equal(await draftDueReports(firstOfNext, { tasks, mailer, writerReady: true }), 1, 'Blue Lotus already has this month’s report');
    const { rows } = await ownerPool.query(`SELECT status, summary_state, created_by FROM reports WHERE client_id = $1`, [client2]);
    assert.deepEqual([rows.length, rows[0].status, rows[0].created_by], [1, 'draft', null]);
    assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['owner@lotus-partners.example', `1 report for ${new Date(`${MONTH}-01T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })} ready to review`]]);
    assert.match(mails[0]!.text, /Nothing is sent to a client until someone on your team approves it/);
    assert.equal(await draftDueReports(firstOfNext, { tasks, mailer, writerReady: true }), 0, 'safe to call every hour');
  });
});
