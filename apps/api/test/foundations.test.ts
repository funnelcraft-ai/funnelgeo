import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerPool } from '../src/db.js';
import type { Mail } from '../src/mailer.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/security.js';

const PLATFORM = 'platform.test';
const PASSWORD = 'correct-horse-battery';
const cnames = new Map<string, string[]>();
const sent: Mail[] = [];
let failMail = false;
let app: FastifyInstance;

interface CallOptions {
  host: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, opts: CallOptions) {
  const res = await app.inject({
    method,
    url,
    headers: { host: opts.host, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  const sid = res.cookies.find((c) => c.name === 'sid');
  return { status: res.statusCode, json: res.json() as any, cookie: sid ? `sid=${sid.value}` : undefined };
}

/** Signs up an agency and returns its hostname and the owner's session cookie. */
async function signup(agencyName: string, email: string) {
  const res = await call('POST', '/v1/signup', {
    host: PLATFORM,
    body: { agencyName, name: 'Owner', email, password: PASSWORD },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const url = new URL(res.json.workspaceUrl);
  const handoff = await call('POST', '/v1/auth/handoff', { host: url.hostname, body: { token: url.searchParams.get('token') } });
  assert.equal(handoff.status, 200);
  return { host: url.hostname, cookie: handoff.cookie!, slug: res.json.slug as string };
}

async function invite(owner: { host: string; cookie: string }, body: object, name: string) {
  const created = await call('POST', '/v1/team/invites', { ...owner, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const token = new URL(created.json.inviteUrl).pathname.split('/').pop()!;
  const accepted = await call('POST', '/v1/invites/accept', { host: owner.host, body: { token, name, password: PASSWORD } });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
  return { host: owner.host, cookie: accepted.cookie!, token };
}

before(async () => {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await owner.connect();
  await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await owner.end();
  await migrate(process.env.DATABASE_OWNER_URL!, process.env.APP_DB_PASSWORD);
  app = await buildApp({
    mailer: {
      enabled: true,
      async send(mail) {
        if (failMail) throw new Error('smtp down');
        sent.push(mail);
      },
    },
    resolveCname: async (host) => {
      const found = cnames.get(host);
      if (!found) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return found;
    },
  });
});

after(async () => {
  await app.close();
  await closePools();
});

describe('tenant isolation', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let b: Awaited<ReturnType<typeof signup>>;
  let clientA: string;
  let clientB: string;

  before(async () => {
    a = await signup('Alpha Digital', 'owner@alpha.test');
    b = await signup('Beta Media', 'owner@beta.test');
    clientA = (await call('POST', '/v1/clients', { ...a, body: { name: 'Alpha Client', domain: 'https://www.AlphaClient.com/about' } })).json.client.id;
    clientB = (await call('POST', '/v1/clients', { ...b, body: { name: 'Beta Client' } })).json.client.id;
  });

  test('each agency gets its own workspace hostname', () => {
    assert.equal(a.host, 'alpha-digital.platform.test');
    assert.equal(b.host, 'beta-media.platform.test');
  });

  test('an agency lists only its own clients', async () => {
    const listA = await call('GET', '/v1/clients', a);
    const listB = await call('GET', '/v1/clients', b);
    assert.deepEqual(listA.json.clients.map((c: any) => c.name), ['Alpha Client']);
    assert.deepEqual(listB.json.clients.map((c: any) => c.name), ['Beta Client']);
    assert.equal(listA.json.clients[0].domain, 'alphaclient.com');
  });

  test("another agency's client cannot be read, changed or deleted by id", async () => {
    assert.equal((await call('GET', `/v1/clients/${clientB}`, a)).status, 404);
    assert.equal((await call('PATCH', `/v1/clients/${clientB}`, { ...a, body: { name: 'Hijacked' } })).status, 404);
    assert.equal((await call('DELETE', `/v1/clients/${clientB}`, a)).status, 404);
    assert.equal((await call('GET', `/v1/clients/${clientB}`, b)).json.client.name, 'Beta Client');
  });

  test('a session is rejected on any other hostname', async () => {
    assert.equal((await call('GET', '/v1/clients', { host: b.host, cookie: a.cookie })).status, 401);
    assert.equal((await call('GET', '/v1/admin/agencies', { host: PLATFORM, cookie: a.cookie })).status, 401);
  });

  test('the same email can own accounts in two agencies without crossing over', async () => {
    const c = await signup('Gamma Works', 'owner@alpha.test');
    const login = await call('POST', '/v1/auth/login', { host: c.host, body: { email: 'owner@alpha.test', password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.deepEqual((await call('GET', '/v1/clients', { host: c.host, cookie: login.cookie })).json.clients, []);
  });

  test('the database itself refuses cross-tenant access for the app role', async () => {
    const agencyA = (await ownerPool.query(`SELECT id FROM agencies WHERE slug = 'alpha-digital'`)).rows[0].id;
    const agencyB = (await ownerPool.query(`SELECT id FROM agencies WHERE slug = 'beta-media'`)).rows[0].id;

    // No tenant set: nothing is visible at all.
    for (const table of ['agencies', 'clients', 'users', 'invites']) {
      assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
    }

    const db = await appPool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.agency_id', $1, true)`, [agencyA]);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM clients WHERE id = $1`, [clientB])).rows[0].n, 0);
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM agencies`)).rows[0].n, 1);
      assert.equal((await db.query(`UPDATE clients SET name = 'x' WHERE id = $1`, [clientB])).rowCount, 0);
      assert.equal((await db.query(`DELETE FROM users WHERE agency_id = $1`, [agencyB])).rowCount, 0);
      // Writing a row into another agency is an error, not a silent no-op.
      await assert.rejects(
        db.query(`INSERT INTO clients (agency_id, name) VALUES ($1, 'planted')`, [agencyB]),
        (err: any) => err.code === '42501',
      );
      await db.query('ROLLBACK');

      // Tenants cannot change their own plan or status.
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.agency_id', $1, true)`, [agencyA]);
      await assert.rejects(db.query(`UPDATE agencies SET status = 'active'`), (err: any) => err.code === '42501');
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
    assert.equal((await ownerPool.query(`SELECT name FROM clients WHERE id = $1`, [clientB])).rows[0].name, 'Beta Client');
    assert.ok(clientA);
  });

  test('a forwarded hostname is trusted only with the proxy secret', async () => {
    const spoofed = await call('GET', '/v1/clients', {
      host: b.host,
      cookie: a.cookie,
      headers: { 'x-forwarded-host': a.host },
    });
    assert.equal(spoofed.status, 401);
    const proxied = await call('GET', '/v1/clients', {
      host: '127.0.0.1:4000',
      cookie: a.cookie,
      headers: { 'x-forwarded-host': a.host, 'x-proxy-secret': process.env.INTERNAL_PROXY_SECRET! },
    });
    assert.equal(proxied.status, 200);
  });

  test('unknown hostnames resolve to nothing', async () => {
    assert.equal((await call('GET', '/v1/tenant', { host: 'nobody.platform.test' })).status, 404);
    assert.equal((await call('GET', '/v1/tenant', { host: 'evil.example.com' })).status, 404);
    assert.equal((await call('POST', '/v1/signup', { host: a.host, body: {} })).status, 404);
  });
});

describe('roles', () => {
  let owner: Awaited<ReturnType<typeof signup>>;
  let member: { host: string; cookie: string };
  let viewer: { host: string; cookie: string };
  let first: string;
  let second: string;

  before(async () => {
    owner = await signup('Roles Agency', 'owner@roles.test');
    first = (await call('POST', '/v1/clients', { ...owner, body: { name: 'First Co' } })).json.client.id;
    second = (await call('POST', '/v1/clients', { ...owner, body: { name: 'Second Co' } })).json.client.id;
    member = await invite(owner, { role: 'agency_member', email: 'member@roles.test' }, 'Member');
    viewer = await invite(owner, { role: 'client_viewer', email: 'viewer@firstco.test', clientId: first }, 'Viewer');
  });

  test('a member manages clients but not branding, domain or team', async () => {
    assert.equal((await call('POST', '/v1/clients', { ...member, body: { name: 'Third Co' } })).status, 201);
    assert.equal((await call('PATCH', '/v1/agency', { ...member, body: { name: 'Renamed' } })).status, 403);
    assert.equal((await call('PUT', '/v1/agency/domain', { ...member, body: { domain: 'x.example.com' } })).status, 403);
    assert.equal((await call('POST', '/v1/team/invites', { ...member, body: { role: 'agency_member', email: 'n@roles.test' } })).status, 403);
    assert.equal((await call('GET', '/v1/team', member)).status, 200);
  });

  test('a client viewer sees only their own client and changes nothing', async () => {
    const list = await call('GET', '/v1/clients', viewer);
    assert.deepEqual(list.json.clients.map((c: any) => c.name), ['First Co']);
    assert.equal((await call('GET', `/v1/clients/${second}`, viewer)).status, 404);
    assert.equal((await call('POST', '/v1/clients', { ...viewer, body: { name: 'Nope' } })).status, 403);
    assert.equal((await call('PATCH', `/v1/clients/${first}`, { ...viewer, body: { name: 'Nope' } })).status, 403);
    assert.equal((await call('DELETE', `/v1/clients/${first}`, viewer)).status, 403);
    assert.equal((await call('GET', '/v1/team', viewer)).status, 403);
    assert.equal((await call('GET', '/v1/agency', viewer)).status, 403);
  });

  test('an invite works once, and only on its own workspace', async () => {
    const created = await call('POST', '/v1/team/invites', { ...owner, body: { role: 'agency_member', email: 'late@roles.test' } });
    const token = new URL(created.json.inviteUrl).pathname.split('/').pop()!;
    const other = await signup('Other Agency', 'owner@other.test');
    assert.equal((await call('GET', `/v1/invites/${token}`, { host: other.host })).status, 404);
    assert.equal((await call('POST', '/v1/invites/accept', { host: other.host, body: { token, name: 'X', password: PASSWORD } })).status, 404);
    assert.equal((await call('GET', `/v1/invites/${token}`, { host: owner.host })).json.invite.email, 'late@roles.test');
    assert.equal((await call('POST', '/v1/invites/accept', { host: owner.host, body: { token, name: 'Late', password: PASSWORD } })).status, 201);
    assert.equal((await call('POST', '/v1/invites/accept', { host: owner.host, body: { token, name: 'Late', password: PASSWORD } })).status, 404);
  });

  test('removing a user ends their session immediately', async () => {
    const team = await call('GET', '/v1/team', owner);
    const memberId = team.json.users.find((u: any) => u.email === 'member@roles.test').id;
    const ownerId = team.json.users.find((u: any) => u.role === 'agency_owner').id;
    assert.equal((await call('DELETE', `/v1/team/users/${ownerId}`, owner)).status, 400);
    assert.equal((await call('DELETE', `/v1/team/users/${memberId}`, owner)).status, 200);
    assert.equal((await call('GET', '/v1/clients', member)).status, 401);
  });

  test('login rejects wrong passwords and unknown emails alike', async () => {
    const wrong = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'owner@roles.test', password: 'wrong-password-1' } });
    const unknown = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'ghost@roles.test', password: PASSWORD } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    const good = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'OWNER@roles.test ', password: PASSWORD } });
    assert.equal(good.status, 200);
    assert.equal(good.json.user.role, 'agency_owner');
  });
});

describe('whitelabel', () => {
  let owner: Awaited<ReturnType<typeof signup>>;

  before(async () => {
    owner = await signup('Brand House', 'owner@brand.test');
  });

  test('branding is saved, validated and served publicly without the platform name', async () => {
    const bad = await call('PATCH', '/v1/agency', { ...owner, body: { branding: { primaryColor: 'blue' } } });
    assert.equal(bad.status, 400);
    const insecure = await call('PATCH', '/v1/agency', { ...owner, body: { branding: { logoUrl: 'http://cdn.test/logo.png' } } });
    assert.equal(insecure.status, 400);

    const saved = await call('PATCH', '/v1/agency', {
      ...owner,
      body: { branding: { primaryColor: '#0B5FFF', accentColor: '#FFB020', logoUrl: 'https://cdn.test/logo.png', senderName: 'Brand House' } },
    });
    assert.equal(saved.status, 200);
    const cleared = await call('PATCH', '/v1/agency', { ...owner, body: { branding: { accentColor: null } } });
    assert.deepEqual(cleared.json.agency.branding, { primaryColor: '#0B5FFF', logoUrl: 'https://cdn.test/logo.png', senderName: 'Brand House' });

    const tenant = await call('GET', '/v1/tenant', { host: owner.host });
    assert.equal(tenant.json.name, 'Brand House');
    assert.equal(tenant.json.branding.primaryColor, '#0B5FFF');
    assert.ok(!JSON.stringify(tenant.json).includes('Test Platform'));
    assert.equal((await call('GET', '/v1/tenant', { host: PLATFORM })).json.name, 'Test Platform');
  });

  test('a custom domain serves the workspace only after its CNAME verifies', async () => {
    const domain = 'seo.brandhouse.test';
    assert.equal((await call('PUT', '/v1/agency/domain', { ...owner, body: { domain: 'sub.platform.test' } })).status, 400);
    const added = await call('PUT', '/v1/agency/domain', { ...owner, body: { domain: 'SEO.BrandHouse.test' } });
    assert.equal(added.json.agency.domainStatus, 'pending');
    assert.equal(added.json.agency.cnameTarget, 'domains.platform.test');

    assert.equal((await call('GET', '/v1/tenant', { host: domain })).status, 404);
    assert.equal((await call('GET', `/internal/domain-check?domain=${domain}`, { host: '127.0.0.1' })).status, 404);

    const missing = await call('POST', '/v1/agency/domain/verify', owner);
    assert.equal(missing.json.verified, false);
    cnames.set(domain, ['somewhere-else.test']);
    assert.equal((await call('POST', '/v1/agency/domain/verify', owner)).json.agency.domainStatus, 'failed');
    cnames.set(domain, ['Domains.Platform.test.']);
    const verified = await call('POST', '/v1/agency/domain/verify', owner);
    assert.equal(verified.json.verified, true);
    assert.equal(verified.json.agency.workspaceUrl, `https://${domain}`);

    assert.equal((await call('GET', '/v1/tenant', { host: domain })).json.name, 'Brand House');
    assert.equal((await call('GET', `/internal/domain-check?domain=${domain}`, { host: '127.0.0.1' })).status, 200);
    assert.equal((await call('GET', `/internal/domain-check?domain=${owner.host}`, { host: '127.0.0.1' })).status, 200);

    // Signing in on the custom domain gives a session for that hostname.
    const login = await call('POST', '/v1/auth/login', { host: domain, body: { email: 'owner@brand.test', password: PASSWORD } });
    assert.equal((await call('GET', '/v1/me', { host: domain, cookie: login.cookie })).status, 200);

    // Another agency cannot claim the same domain.
    const rival = await signup('Rival Agency', 'owner@rival.test');
    assert.equal((await call('PUT', '/v1/agency/domain', { ...rival, body: { domain } })).status, 409);

    assert.equal((await call('DELETE', '/v1/agency/domain', owner)).json.agency.domainStatus, 'none');
    assert.equal((await call('GET', '/v1/tenant', { host: domain })).status, 404);
  });

  test('reserved and duplicate names get distinct workspace addresses', async () => {
    const admin = await signup('Admin', 'owner@admin.test');
    assert.equal(admin.slug, 'admin-2');
    const twin = await signup('Brand House', 'owner@twin.test');
    assert.equal(twin.slug, 'brand-house-2');
  });
});

describe('plans and super admin', () => {
  let owner: Awaited<ReturnType<typeof signup>>;
  let admin: { host: string; cookie: string };

  before(async () => {
    owner = await signup('Limit Agency', 'owner@limit.test');
    await ownerPool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Root', $2, 'super_admin')`, [
      'root@platform.test',
      await hashPassword(PASSWORD),
    ]);
    const login = await call('POST', '/v1/auth/login', { host: PLATFORM, body: { email: 'root@platform.test', password: PASSWORD } });
    assert.equal(login.status, 200);
    admin = { host: PLATFORM, cookie: login.cookie! };
  });

  test('the starter plan stops at five active clients', async () => {
    for (let i = 1; i <= 5; i++) {
      assert.equal((await call('POST', '/v1/clients', { ...owner, body: { name: `Client ${i}` } })).status, 201);
    }
    const sixth = await call('POST', '/v1/clients', { ...owner, body: { name: 'Client 6' } });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.json.error.code, 'plan_limit');
    // A paused client does not count, but cannot be reactivated past the limit.
    const paused = await call('POST', '/v1/clients', { ...owner, body: { name: 'Client 6', status: 'paused' } });
    assert.equal(paused.status, 201);
    assert.equal((await call('PATCH', `/v1/clients/${paused.json.client.id}`, { ...owner, body: { status: 'active' } })).status, 409);
  });

  test('a super admin changes plans; agencies cannot reach admin routes', async () => {
    assert.equal((await call('GET', '/v1/admin/agencies', owner)).status, 403);
    assert.equal((await call('GET', '/v1/admin/agencies', { host: owner.host, cookie: admin.cookie })).status, 401);

    const list = await call('GET', '/v1/admin/agencies', admin);
    const row = list.json.agencies.find((x: any) => x.slug === owner.slug);
    assert.equal(row.clientCount, 6);
    assert.equal(row.planKey, 'starter');

    assert.equal((await call('PATCH', `/v1/admin/agencies/${row.id}`, { ...admin, body: { planKey: 'growth' } })).json.agency.planKey, 'growth');
    assert.equal((await call('POST', '/v1/clients', { ...owner, body: { name: 'Client 7' } })).status, 201);
    assert.equal((await call('GET', '/v1/agency', owner)).json.agency.plan.clientLimit, 15);
  });

  test('suspending an agency blocks sessions and sign-in', async () => {
    const list = await call('GET', '/v1/admin/agencies', admin);
    const id = list.json.agencies.find((x: any) => x.slug === owner.slug).id;
    await call('PATCH', `/v1/admin/agencies/${id}`, { ...admin, body: { status: 'suspended' } });
    assert.equal((await call('GET', '/v1/clients', owner)).status, 403);
    const login = await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'owner@limit.test', password: PASSWORD } });
    assert.equal(login.json.error.code, 'agency_suspended');
    await call('PATCH', `/v1/admin/agencies/${id}`, { ...admin, body: { status: 'active' } });
    assert.equal((await call('GET', '/v1/clients', owner)).status, 200);
  });
});

describe('email, password reset and uploads', () => {
  let owner: Awaited<ReturnType<typeof signup>>;
  let other: Awaited<ReturnType<typeof signup>>;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
  const linkIn = (mail: Mail) => new URL(mail.text.match(/https?:\/\/\S+/)![0]);

  async function upload(who: { host: string; cookie: string }, kind: string, body: Buffer, type = 'image/png') {
    const res = await app.inject({ method: 'PUT', url: `/v1/agency/branding/${kind}`, headers: { host: who.host, cookie: who.cookie, 'content-type': type }, payload: body });
    return { status: res.statusCode, json: res.json() as any };
  }
  const fetchFile = (url: string, host: string) => app.inject({ method: 'GET', url: url.replace(/^\/api/, ''), headers: { host } });

  before(async () => {
    await rm(process.env.UPLOAD_DIR!, { recursive: true, force: true });
    owner = await signup('Mail House', 'owner@mailhouse.test');
    other = await signup('Other House', 'owner@otherhouse.test');
    await call('PATCH', '/v1/agency', { ...owner, body: { branding: { senderName: 'Mail House Team', primaryColor: '#112233' } } });
  });

  test('an invite is emailed from the agency, with a working link and no platform name', async () => {
    sent.length = 0;
    const created = await call('POST', '/v1/team/invites', { ...owner, body: { role: 'agency_member', email: 'new@mailhouse.test' } });
    assert.equal(created.json.emailed, true);
    assert.equal(sent.length, 1);
    const mail = sent[0]!;
    assert.equal(mail.to, 'new@mailhouse.test');
    assert.equal(mail.fromName, 'Mail House Team');
    assert.equal(mail.subject, 'Join Mail House');
    assert.ok(mail.html.includes('#112233'));
    assert.ok(!`${mail.subject}${mail.text}${mail.html}`.includes('Test Platform'));
    const link = linkIn(mail);
    assert.equal(link.hostname, owner.host);
    assert.equal(link.href, created.json.inviteUrl);
    const token = link.pathname.split('/').pop()!;
    assert.equal((await call('POST', '/v1/invites/accept', { host: owner.host, body: { token, name: 'New', password: PASSWORD } })).status, 201);
  });

  test('an invite survives a failed email and says so', async () => {
    failMail = true;
    const created = await call('POST', '/v1/team/invites', { ...owner, body: { role: 'agency_member', email: 'bounce@mailhouse.test' } });
    failMail = false;
    assert.equal(created.status, 201);
    assert.equal(created.json.emailed, false);
    assert.ok(created.json.inviteUrl);
  });

  test('user-supplied names are escaped in email HTML', async () => {
    const client = await call('POST', '/v1/clients', { ...owner, body: { name: '<script>alert(1)</script> & Co' } });
    sent.length = 0;
    await call('POST', '/v1/team/invites', { ...owner, body: { role: 'client_viewer', email: 'viewer@co.test', clientId: client.json.client.id } });
    assert.ok(!sent[0]!.html.includes('<script>'));
    assert.ok(sent[0]!.html.includes('&lt;script&gt;'));
  });

  test('forgot password answers the same for known and unknown emails', async () => {
    sent.length = 0;
    const unknown = await call('POST', '/v1/auth/forgot', { host: owner.host, body: { email: 'ghost@mailhouse.test' } });
    const known = await call('POST', '/v1/auth/forgot', { host: owner.host, body: { email: 'owner@mailhouse.test' } });
    assert.deepEqual(unknown.json, known.json);
    assert.equal(unknown.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'owner@mailhouse.test');
    assert.equal(sent[0]!.subject, 'Reset your Mail House password');
  });

  test('a reset link works once, only on its workspace, and ends older sessions', async () => {
    sent.length = 0;
    await call('POST', '/v1/auth/forgot', { host: owner.host, body: { email: 'owner@mailhouse.test' } });
    const link = linkIn(sent[0]!);
    assert.equal(link.hostname, owner.host);
    const token = link.pathname.split('/').pop()!;
    const NEW = 'a-brand-new-password';

    assert.equal((await call('GET', `/v1/auth/reset/${token}`, { host: other.host })).status, 404);
    assert.equal((await call('POST', '/v1/auth/reset', { host: other.host, body: { token, password: NEW } })).status, 404);
    assert.equal((await call('GET', `/v1/auth/reset/${token}`, { host: owner.host })).json.email, 'owner@mailhouse.test');
    assert.equal((await call('POST', '/v1/auth/reset', { host: owner.host, body: { token, password: 'short' } })).status, 400);

    const done = await call('POST', '/v1/auth/reset', { host: owner.host, body: { token, password: NEW } });
    assert.equal(done.status, 200);
    assert.equal((await call('GET', '/v1/me', { host: owner.host, cookie: done.cookie })).status, 200);
    assert.equal((await call('GET', '/v1/me', owner)).status, 401, 'the session from before the reset is dead');
    assert.equal((await call('POST', '/v1/auth/reset', { host: owner.host, body: { token, password: NEW } })).status, 404);
    assert.equal((await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'owner@mailhouse.test', password: PASSWORD } })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { host: owner.host, body: { email: 'owner@mailhouse.test', password: NEW } })).status, 200);
    owner.cookie = done.cookie!;
  });

  test('a requested reset replaces any earlier link', async () => {
    sent.length = 0;
    await call('POST', '/v1/auth/forgot', { host: other.host, body: { email: 'owner@otherhouse.test' } });
    await call('POST', '/v1/auth/forgot', { host: other.host, body: { email: 'owner@otherhouse.test' } });
    const [first, second] = sent.map((m) => linkIn(m).pathname.split('/').pop()!);
    assert.equal((await call('GET', `/v1/auth/reset/${first}`, { host: other.host })).status, 404);
    assert.equal((await call('GET', `/v1/auth/reset/${second}`, { host: other.host })).status, 200);
  });

  test('a logo upload is stored, served back byte for byte, and replaced cleanly', async () => {
    const up = await upload(owner, 'logo', PNG);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.match(up.json.url, /^\/api\/v1\/files\/[0-9a-f-]{36}\/logo-[A-Za-z0-9_-]{16}\.png$/);
    assert.equal((await call('GET', '/v1/tenant', { host: owner.host })).json.branding.logoUrl, up.json.url);

    const served = await fetchFile(up.json.url, owner.host);
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.ok(served.rawPayload.equals(PNG));

    const again = await upload(owner, 'logo', PNG);
    assert.equal((await fetchFile(up.json.url, owner.host)).statusCode, 404, 'the replaced file is deleted');
    assert.equal((await fetchFile(again.json.url, owner.host)).statusCode, 200);

    // The logo appears in emails as an absolute URL on the workspace's own address.
    sent.length = 0;
    await call('POST', '/v1/auth/forgot', { host: owner.host, body: { email: 'owner@mailhouse.test' } });
    assert.ok(sent[0]!.html.includes(`https://${owner.host}${again.json.url}`));

    const removed = await app.inject({ method: 'DELETE', url: '/v1/agency/branding/logo', headers: { host: owner.host, cookie: owner.cookie } });
    assert.equal(removed.statusCode, 200);
    assert.equal((await fetchFile(again.json.url, owner.host)).statusCode, 404);
    assert.equal((await call('GET', '/v1/tenant', { host: owner.host })).json.branding.logoUrl, undefined);
  });

  test('uploads reject non-images, oversize files, other roles and path tricks', async () => {
    assert.equal((await upload(owner, 'logo', Buffer.from('<svg onload=alert(1)>'))).status, 400);
    assert.equal((await upload(owner, 'logo', Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await upload(owner, 'logo', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))).status, 413);
    assert.equal((await upload(owner, 'banner', PNG)).status, 400);
    const member = await invite(owner, { role: 'agency_member', email: 'uploader@mailhouse.test' }, 'Uploader');
    assert.equal((await upload(member, 'logo', PNG)).status, 403);
    const id = '00000000-0000-4000-8000-000000000000';
    for (const file of ['..%2F..%2Fetc%2Fpasswd', 'logo-aaaaaaaaaaaaaaaa.svg', '.env']) {
      assert.ok([400, 404].includes((await fetchFile(`/v1/files/${id}/${file}`, owner.host)).statusCode), file);
    }
  });
});
