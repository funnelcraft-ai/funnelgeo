// The tracking script, served from the agency's own address. In production a
// reverse proxy should send /t.js and /c straight to the collector process, so
// clients' website traffic never reaches this app; this route is the fallback
// (and what development uses).
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? 'http://127.0.0.1:4100';

export async function GET(): Promise<Response> {
  try {
    const upstream = await fetch(`${COLLECTOR_URL}/t.js`, { cache: 'no-store' });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    // A missing tracker must never break the client's page: an empty script is harmless.
    return new Response('', { status: 503, headers: { 'content-type': 'application/javascript; charset=utf-8' } });
  }
}
