import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerPool } from '../src/db.js';
import { createEngines } from '../src/engines.js';
import { migrate } from '../src/migrate.js';
import { createQueue, startWorkers } from '../src/queue.js';
import { hashPassword } from '../src/security.js';
import { decrypt, encrypt, refreshSettings, setting } from '../src/settings.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const PREFIX = `${process.env.QUEUE_PREFIX!}-settings`;
const ENGINE_PORT = 4599;
const SMTP_PORT = 4598;

const KEYS = {
  OPENAI_API_KEY: 'sk-test-openai-0000000000001111',
  PERPLEXITY_API_KEY: 'pplx-test-0000000000002222',
  GEMINI_API_KEY: 'AIza-test-0000000000003333',
};

// A stand-in for the three providers' APIs, recording what each request carried.
interface Seen {
  path: string;
  auth: string;
  model: string;
}
const seen: Seen[] = [];
let engineServer: Server;

const body = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

async function handleEngine(req: IncomingMessage): Promise<unknown> {
  const json = await body(req);
  const path = req.url ?? '';
  if (path.startsWith('/openai/v1/responses')) {
    seen.push({ path, auth: String(req.headers.authorization ?? ''), model: json.model });
    return {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Northlight Dental is a good choice.', annotations: [{ url: 'https://reviews.example/a' }] }] }],
      usage: { input_tokens: 12, output_tokens: 20 },
    };
  }
  if (path.startsWith('/perplexity/chat/completions')) {
    seen.push({ path, auth: String(req.headers.authorization ?? ''), model: json.model });
    return { choices: [{ message: { content: 'Many people pick Northlight Dental.' } }], citations: ['https://reviews.example/b'], usage: { prompt_tokens: 9, completion_tokens: 15 } };
  }
  const gemini = path.match(/^\/gemini\/v1beta\/models\/([^:]+):generateContent/);
  if (gemini) {
    seen.push({ path, auth: String(req.headers['x-goog-api-key'] ?? ''), model: decodeURIComponent(gemini[1]!) });
    return {
      candidates: [{ content: { parts: [{ text: 'Search engines find pages.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://reviews.example/c' } }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
    };
  }
  throw new Error(`unexpected path ${path}`);
}

// A minimal SMTP server that accepts every message and keeps it.
const received: { to: string; data: string }[] = [];
let smtpServer: TcpServer;

function startSmtp(): Promise<void> {
  smtpServer = createTcpServer((socket) => {
    let buffer = '';
    let inData = false;
    let to = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.push({ to, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 OK\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') socket.write('235 OK\r\n');
        else if (verb === 'RCPT') {
          to = line.match(/<([^>]+)>/)?.[1] ?? '';
          socket.write('250 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => smtpServer.listen(SMTP_PORT, '127.0.0.1', resolve));
}

let app: FastifyInstance;
let queue: ReturnType<typeof createQueue>;
let workers: ReturnType<typeof startWorkers>;
let admin: { host: string; cookie: string };

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, opts: { host: string; cookie?: string; body?: unknown }) {
  const res = await app.inject({
    method,
    url,
    headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, raw: res.body, cookie: sid ? `sid=${sid.value}` : undefined };
}

const save = (key: string, value: string) => call('PUT', `/v1/admin/settings/${key}`, { ...admin, body: { value } });
const item = (json: any, key: string) => json.groups.flatMap((g: any) => g.items).find((i: any) => i.key === key);

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

  for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'SMTP_URL', 'MAIL_FROM']) delete process.env[key];

  engineServer = createServer((req, res) => {
    handleEngine(req)
      .then((out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out)))
      .catch((err) => res.writeHead(500).end(String(err)));
  });
  await new Promise<void>((resolve) => engineServer.listen(ENGINE_PORT, '127.0.0.1', resolve));
  await startSmtp();

  // The API and the worker each build their own live engines, as in production.
  queue = createQueue({ prefix: PREFIX, backoffMs: 20 });
  workers = startWorkers(createEngines(), { prefix: PREFIX });
  app = await buildApp({ engines: createEngines(), queue });

  await ownerPool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ('root@platform.test', 'Root', $1, 'super_admin')`, [await hashPassword(PASSWORD)]);
  const login = await call('POST', '/v1/auth/login', { host: PLATFORM, body: { email: 'root@platform.test', password: PASSWORD } });
  admin = { host: PLATFORM, cookie: login.cookie! };
});

after(async () => {
  await workers.close();
  await queue.close();
  await app.close();
  await closePools();
  engineServer.close();
  smtpServer.close();
});

describe('encryption of saved keys', () => {
  test('a value round-trips, and tampering or moving it to another setting makes it unreadable', () => {
    const sealed = encrypt('OPENAI_API_KEY', 'sk-secret-value');
    assert.equal(decrypt('OPENAI_API_KEY', sealed), 'sk-secret-value');
    assert.ok(!sealed.includes(Buffer.from('sk-secret-value')));
    assert.notDeepEqual(encrypt('OPENAI_API_KEY', 'sk-secret-value'), sealed, 'a fresh IV every time');

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    assert.equal(decrypt('OPENAI_API_KEY', tampered), null);
    assert.equal(decrypt('GEMINI_API_KEY', sealed), null, 'bound to the setting name');
  });

  test('a different server key cannot read it', () => {
    const sealed = encrypt('OPENAI_API_KEY', 'sk-secret-value');
    const original = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    try {
      assert.equal(decrypt('OPENAI_API_KEY', sealed), null);
    } finally {
      process.env.SETTINGS_ENCRYPTION_KEY = original;
    }
  });
});

describe('API keys screen', () => {
  test('only the super admin, on the platform address, can reach it', async () => {
    assert.equal((await call('GET', '/v1/admin/settings', { host: PLATFORM })).status, 401);

    const signup = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName: 'Keyless Agency', name: 'Owner', email: 'owner@keyless.example', password: PASSWORD } });
    const url = new URL(signup.json.workspaceUrl);
    const owner = { host: url.hostname, cookie: (await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } })).cookie! };
    for (const [method, path] of [['GET', '/v1/admin/settings'], ['PUT', '/v1/admin/settings/OPENAI_API_KEY'], ['DELETE', '/v1/admin/settings/OPENAI_API_KEY'], ['POST', '/v1/admin/settings/test/chatgpt']] as const) {
      const res = await call(method, path, { ...owner, ...(method === 'PUT' ? { body: { value: KEYS.OPENAI_API_KEY } } : {}) });
      assert.ok([401, 403, 404].includes(res.status), `${method} ${path} gave ${res.status}`);
    }
    // The super admin's session does not work on an agency's address either.
    assert.ok([401, 403, 404].includes((await call('GET', '/v1/admin/settings', { host: url.hostname, cookie: admin.cookie })).status));
  });

  test('with nothing saved or set, every setting shows as missing', async () => {
    const res = await call('GET', '/v1/admin/settings', admin);
    assert.equal(res.status, 200);
    assert.equal(res.json.encryptionReady, true);
    assert.deepEqual(res.json.groups.map((g: any) => g.key), ['chatgpt', 'perplexity', 'gemini', 'writer', 'email']);
    for (const g of res.json.groups) for (const i of g.items) assert.equal(i.source, 'none', i.key);
  });

  test('a saved key is stored encrypted and is never sent back in full', async () => {
    const res = await save('OPENAI_API_KEY', `  ${KEYS.OPENAI_API_KEY}  `);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.setting.source, 'saved');
    assert.equal(res.json.setting.shown, '1111');
    assert.equal(res.json.setting.updatedBy, 'root@platform.test');

    const list = await call('GET', '/v1/admin/settings', admin);
    assert.ok(!list.raw.includes(KEYS.OPENAI_API_KEY));
    assert.equal(item(list.json, 'OPENAI_API_KEY').shown, '1111');

    const { rows } = await ownerPool.query(`SELECT value, secret, hint FROM platform_settings WHERE key = 'OPENAI_API_KEY'`);
    assert.equal(rows[0].value, null);
    assert.ok(!(rows[0].secret as Buffer).includes(Buffer.from(KEYS.OPENAI_API_KEY)));
    assert.equal(rows[0].hint, '1111');
    assert.equal(setting('OPENAI_API_KEY'), KEYS.OPENAI_API_KEY);
  });

  test('the tenant database role cannot read the table at all', async () => {
    await assert.rejects(appPool.query('SELECT * FROM platform_settings'), (err: any) => err.code === '42501');
  });

  test('values are checked before they are saved', async () => {
    const cases: [string, string][] = [
      ['OPENAI_API_KEY', 'sk with spaces in it'],
      ['OPENAI_API_KEY', 'short'],
      ['OPENAI_MODEL', 'gpt 5; drop'],
      ['SMTP_URL', 'http://mail.example.com'],
      ['MAIL_FROM', 'not-an-address'],
    ];
    for (const [key, value] of cases) {
      const res = await save(key, value);
      assert.equal(res.status, 400, `${key}=${value}`);
      assert.ok(res.json.error.message.length > 10);
    }
    assert.equal((await save('SOMETHING_ELSE', 'value')).status, 404);
    assert.equal((await save('OPENAI_API_KEY', '')).status, 400);
  });

  test('a saved value wins over the environment, and removing it falls back to the environment', async () => {
    process.env.GEMINI_MODEL = 'env-model-1';
    try {
      let list = await call('GET', '/v1/admin/settings', admin);
      assert.deepEqual([item(list.json, 'GEMINI_MODEL').source, item(list.json, 'GEMINI_MODEL').shown], ['environment', 'env-model-1']);

      assert.equal((await save('GEMINI_MODEL', 'saved-model-2')).status, 200);
      assert.equal(setting('GEMINI_MODEL'), 'saved-model-2');

      const removed = await call('DELETE', '/v1/admin/settings/GEMINI_MODEL', admin);
      assert.equal(removed.json.setting.source, 'environment');
      assert.equal(setting('GEMINI_MODEL'), 'env-model-1');
      list = await call('GET', '/v1/admin/settings', admin);
      assert.equal(item(list.json, 'GEMINI_MODEL').source, 'environment');
    } finally {
      delete process.env.GEMINI_MODEL;
    }
  });

  test('without the server encryption key, secrets cannot be saved and old ones show as unreadable', async () => {
    const original = process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    try {
      const res = await save('PERPLEXITY_API_KEY', KEYS.PERPLEXITY_API_KEY);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'encryption_not_ready');
      // Model names are not secret and can still be saved.
      assert.equal((await save('PERPLEXITY_MODEL', 'sonar-test')).status, 200);

      const list = await call('GET', '/v1/admin/settings', admin);
      assert.equal(list.json.encryptionReady, false);
      assert.equal(item(list.json, 'OPENAI_API_KEY').unreadable, true);
      assert.equal(item(list.json, 'OPENAI_API_KEY').source, 'none');
      assert.equal(setting('OPENAI_API_KEY'), '');
    } finally {
      process.env.SETTINGS_ENCRYPTION_KEY = original;
      await refreshSettings();
    }
    assert.equal(setting('OPENAI_API_KEY'), KEYS.OPENAI_API_KEY);
  });
});

describe('engines use the saved keys without a restart', () => {
  test('the test button reports a missing model, then makes one real call with the saved key and model', async () => {
    const missing = await call('POST', '/v1/admin/settings/test/chatgpt', admin);
    assert.equal(missing.json.ok, false);
    assert.match(missing.json.message, /model/);

    assert.equal((await save('OPENAI_MODEL', 'gpt-test-1')).status, 200);
    const res = await call('POST', '/v1/admin/settings/test/chatgpt', admin);
    assert.equal(res.json.ok, true, res.raw);
    assert.equal(res.json.citations, 1);
    assert.match(res.json.sample, /Northlight/);
    assert.deepEqual(seen.at(-1), { path: '/openai/v1/responses', auth: `Bearer ${KEYS.OPENAI_API_KEY}`, model: 'gpt-test-1' });
  });

  test('a rejected key shows the provider’s error', async () => {
    await save('GEMINI_API_KEY', KEYS.GEMINI_API_KEY);
    await save('GEMINI_MODEL', 'gemini-test');
    const res = await call('POST', '/v1/admin/settings/test/gemini', admin);
    assert.equal(res.json.ok, true, res.raw);
    assert.deepEqual(seen.at(-1), { path: '/gemini/v1beta/models/gemini-test:generateContent', auth: KEYS.GEMINI_API_KEY, model: 'gemini-test' });

    engineServer.removeAllListeners('request');
    engineServer.on('request', (_req, out) => out.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Incorrect API key provided"}}'));
    try {
      const rejected = await call('POST', '/v1/admin/settings/test/gemini', admin);
      assert.equal(rejected.json.ok, false);
      assert.equal(rejected.json.message, 'The provider rejected the key: Incorrect API key provided');
    } finally {
      engineServer.removeAllListeners('request');
      engineServer.on('request', (req, out) => {
        handleEngine(req)
          .then((json) => out.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json)))
          .catch((err) => out.writeHead(500).end(String(err)));
      });
    }
  });

  test('a run started after the keys are saved goes through the worker with those keys', async () => {
    assert.equal((await save('PERPLEXITY_API_KEY', KEYS.PERPLEXITY_API_KEY)).status, 200);
    seen.length = 0;

    const signup = await call('POST', '/v1/signup', { host: PLATFORM, body: { agencyName: 'Keyed Agency', name: 'Owner', email: 'owner@keyed.example', password: PASSWORD } });
    const url = new URL(signup.json.workspaceUrl);
    const who = { host: url.hostname, cookie: (await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } })).cookie! };
    const client = (await call('POST', '/v1/clients', { ...who, body: { name: 'Northlight Dental', domain: 'northlight.example' } })).json.client;
    await call('POST', `/v1/clients/${client.id}/prompts`, { ...who, body: { prompts: [{ text: 'Best dentist in Salt Lake' }, { text: 'Dentist open on Sunday' }] } });

    const started = await call('POST', `/v1/clients/${client.id}/runs`, who);
    assert.equal(started.status, 202, started.raw);
    const runId = started.json.run.id;
    const deadline = Date.now() + 30_000;
    let run: any;
    for (;;) {
      run = (await call('GET', `/v1/runs/${runId}`, who)).json.run;
      if (!['queued', 'running'].includes(run.status)) break;
      assert.ok(Date.now() < deadline, `run still ${run.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.failedCalls, 0);
    assert.ok(run.okCalls >= 6, `${run.okCalls} calls`);

    // Every engine was called by the worker, each with its own saved key and model.
    const byEngine = (prefix: string) => seen.filter((s) => s.path.startsWith(prefix));
    assert.ok(byEngine('/openai').length >= 2 && byEngine('/openai').every((s) => s.auth === `Bearer ${KEYS.OPENAI_API_KEY}` && s.model === 'gpt-test-1'));
    assert.ok(byEngine('/perplexity').length >= 2 && byEngine('/perplexity').every((s) => s.auth === `Bearer ${KEYS.PERPLEXITY_API_KEY}` && s.model === 'sonar-test'));
    assert.ok(byEngine('/gemini').length >= 2 && byEngine('/gemini').every((s) => s.auth === KEYS.GEMINI_API_KEY));
  });
});

describe('email settings', () => {
  test('the email test says when no server is set, then sends to the super admin only', async () => {
    const none = await call('POST', '/v1/admin/settings/test/email', admin);
    assert.equal(none.json.ok, false, none.raw);

    assert.equal((await save('SMTP_URL', `smtp://mailer:Zq7-unique-secret@127.0.0.1:${SMTP_PORT}`)).status, 200);
    assert.equal((await save('MAIL_FROM', 'hello@funnelgeo.example')).status, 200);
    const sent = await call('POST', '/v1/admin/settings/test/email', admin);
    assert.equal(sent.json.ok, true, sent.raw);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.to, 'root@platform.test');
    assert.match(received[0]!.data, /From: .*<hello@funnelgeo\.example>/);
    assert.match(received[0]!.data, /Subject: .*test email/);

    const list = await call('GET', '/v1/admin/settings', admin);
    assert.ok(!list.raw.includes('Zq7-unique-secret'), 'the SMTP password is never sent back');
    assert.equal(item(list.json, 'SMTP_URL').shown, SMTP_PORT.toString().slice(-4));

    await call('DELETE', '/v1/admin/settings/SMTP_URL', admin);
    assert.equal((await call('POST', '/v1/admin/settings/test/email', admin)).json.ok, false);
  });
});
