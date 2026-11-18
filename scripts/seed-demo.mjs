// Development only: creates a demo agency with five clients and eight weeks of
// history, for screenshots and design work. Needs the web app on :3000, the
// API, a worker in ENGINE_MODE=mock, and DATABASE_OWNER_URL for backdating.
//   node --env-file=.env scripts/seed-demo.mjs
import http from 'node:http';
import pg from 'pg';

if (process.env.NODE_ENV === 'production' || process.env.ENGINE_MODE !== 'mock') {
  console.error('Refusing: run this only in development with ENGINE_MODE=mock.');
  process.exit(1);
}

const PASSWORD = 'local-dev-password-1';
function call(host, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: 3000, method, path: `/api${path}`, headers: { host, ...(data ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const sid = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
          let json = null; try { json = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${host}${path} ${res.statusCode}: ${text.slice(0, 120)}`); } resolve({ status: res.statusCode, json, cookie: sid });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signup = await call('localhost:3000', 'POST', '/v1/signup', { agencyName: 'Lumen Digital', name: 'Priya Sen', email: 'priya@lumen.test', password: PASSWORD });
if (signup.status !== 201 && signup.status !== 200) throw new Error(`signup ${signup.status} ${JSON.stringify(signup.json)}`);
const url = new URL(signup.json.workspaceUrl);
const host = url.host;
const handoff = await call(host, 'POST', '/v1/auth/handoff', { token: url.searchParams.get('token') });
const cookie = handoff.cookie;
const as = (method, path, body) => call(host, method, path, body, cookie);
await as('PATCH', '/v1/agency', { branding: { primaryColor: '#5b4fe0' } });

const CLIENTS = [
  { name: 'Blue Lotus Dental', domain: 'bluelotus.example', competitors: [['Smile Studio', 'smilestudio.example'], ['Pearl Dental Care', 'pearldental.example']], prompts: ['Best dentist in Pune', 'Dental implants cost in Pune', 'Painless root canal near Baner', 'Kids dentist in Pune', 'Teeth whitening clinic Pune', 'Emergency dentist open Sunday Pune'], shape: 'rising' },
  { name: 'Northwind Hotels', domain: 'northwind.example', competitors: [['Harbour Stays', 'harbourstays.example'], ['Grand Ember', 'grandember.example']], prompts: ['Best boutique hotel in Goa', 'Hotels near Calangute beach', 'Family resort in North Goa', 'Pet friendly hotel Goa', 'Goa hotel with pool villa', 'Luxury stay Goa honeymoon'], shape: 'drop' },
  { name: 'Peak Running Co', domain: 'peakrunning.example', competitors: [['StrideLab', 'stridelab.example'], ['TrailMate', 'trailmate.example']], prompts: ['Best running shoes for flat feet', 'Running shoe store Bangalore', 'Trail running shoes India', 'Marathon training plan beginners', 'Gait analysis near me Bangalore', 'Cushioned running shoes for heel strikers'], shape: 'steady' },
  { name: 'Kolkata Chess Club', domain: 'kolkatachess.example', competitors: [['Knight School', 'knightschool.example']], prompts: ['Chess classes for kids Kolkata', 'Online chess coaching India', 'Chess tournaments Kolkata 2026', 'FIDE rated coach Kolkata', 'Weekend chess club Salt Lake'], shape: 'stale' },
  { name: 'Verde Organics', domain: 'verdeorganics.example', competitors: [['GreenBasket', 'greenbasket.example'], ['FarmFresh Box', 'farmfresh.example']], prompts: ['Organic vegetable delivery Mumbai', 'Best organic grocery app India', 'Cold pressed oils online', 'Millet snacks brand', 'Organic fruit subscription Mumbai'], shape: 'watch' },
];

const ids = [];
for (const c of CLIENTS) {
  const res = await as('POST', '/v1/clients', { name: c.name, domain: c.domain });
  const id = res.json.client.id;
  ids.push(id);
  for (const [name, domain] of c.competitors) await as('POST', `/v1/clients/${id}/competitors`, { name, domain });
  await as('POST', `/v1/clients/${id}/prompts`, { prompts: c.prompts.map((text, i) => ({ text, priority: i === 0 })) });
}
// Raise credits so eight runs per client fit, then run each client eight times.
const db = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
await db.connect();
const { rows: ag } = await db.query(`SELECT id FROM agencies WHERE slug = $1`, [host.split('.')[0]]);
const agencyId = ag[0].id;
await db.query(`INSERT INTO credit_ledger (agency_id, delta, reason, note) VALUES ($1, 3000, 'grant', 'Demo data')`, [agencyId]);
for (let round = 0; round < 8; round++) {
  for (const id of ids) {
    for (let tries = 0; tries < 60; tries++) {
      const r = await as('POST', `/v1/clients/${id}/runs`);
      if (r.status === 202) break;
      await sleep(500);
    }
  }
  // Wait for this round to finish.
  for (let i = 0; i < 120; i++) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM runs r JOIN clients c ON c.id = r.client_id WHERE c.agency_id = $1 AND r.status IN ('queued', 'running')`, [agencyId]);
    if (rows[0].n === 0) break;
    await sleep(500);
  }
  process.stdout.write(`round ${round + 1} `);
}
console.log();

// Spread each client's runs one week apart, oldest first, and shape the trend
// by removing some of the client's mentions from older runs.
for (const [ci, id] of ids.entries()) {
  const shape = CLIENTS[ci].shape;
  const { rows: runs } = await db.query(`SELECT id FROM runs WHERE client_id = $1 AND status = 'completed' ORDER BY finished_at`, [id]);
  for (const [i, run] of runs.entries()) {
    const weeksAgo = runs.length - 1 - i + (shape === 'stale' ? 3 : 0);
    await db.query(
      `UPDATE runs SET created_at = now() - make_interval(days => $2::int * 7) - interval '2 hours',
                       started_at = now() - make_interval(days => $2::int * 7) - interval '2 hours',
                       finished_at = now() - make_interval(days => $2::int * 7) - interval '1 hour 50 minutes' WHERE id = $1`,
      [run.id, weeksAgo],
    );
    // Share of the client's mentions to remove from this run (0..1).
    const t = i / Math.max(1, runs.length - 1);
    const drop = { rising: 0.75 * (1 - t), drop: i === runs.length - 1 ? 0.6 : 0.15 * (1 - t), steady: 0.25 + 0.08 * Math.sin(i), stale: 0.4, watch: i === runs.length - 1 ? 0.42 : 0.3 - 0.1 * t }[shape];
    await db.query(
      `DELETE FROM result_mentions m USING prompt_results pr
        WHERE m.prompt_result_id = pr.id AND pr.run_id = $1 AND m.competitor_id IS NULL AND random() < $2`,
      [run.id, Math.max(0, Math.min(1, drop))],
    );
  }
  // AI visits over the last 56 days, growing for the rising client.
  const visits = { rising: [9, 31], drop: [22, 14], steady: [12, 15], stale: [3, 2], watch: [6, 8] }[shape];
  for (const [half, count] of [[1, visits[0]], [0, visits[1]]]) {
    for (let v = 0; v < count; v++) {
      const engine = ['chatgpt', 'perplexity', 'gemini', 'copilot'][v % 4];
      await db.query(
        `INSERT INTO ai_visits (agency_id, client_id, occurred_at, source_engine, via, landing_url, landing_path, session_hash, converted)
         VALUES ($1, $2, now() - make_interval(days => $3::int) - make_interval(hours => $4::int), $5, 'referrer', $6, '/', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $7)`,
        [agencyId, id, half * 28 + (v % 27), v % 20, engine, `https://${CLIENTS[ci].domain}/`, v % 5 === 0],
      );
    }
  }
}
// Mark the top suggested fix done for two clients.
for (const id of ids.slice(0, 2)) {
  await db.query(
    `UPDATE actions SET status = 'done', done_at = now() - interval '3 days', approved_at = now() - interval '5 days'
      WHERE id = (SELECT id FROM actions WHERE client_id = $1 AND status = 'suggested' ORDER BY impact_score DESC LIMIT 1)`,
    [id],
  );
}
await db.end();
console.log(`Demo agency ready: http://${host}/login  priya@lumen.test / ${PASSWORD}`);
