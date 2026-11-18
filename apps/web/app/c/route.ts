// Visit events from the tracking script, passed to the collector process.
// See app/t.js/route.ts: in production a reverse proxy should route /c
// straight to the collector instead.
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? 'http://127.0.0.1:4100';

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  if (body.length > 4096) return new Response(null, { status: 413 });
  try {
    await fetch(`${COLLECTOR_URL}/c`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '',
        'x-proxy-secret': process.env.INTERNAL_PROXY_SECRET ?? '',
      },
      body,
      cache: 'no-store',
    });
  } catch {
    // Never surface collector trouble to the visitor's browser.
  }
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
}
