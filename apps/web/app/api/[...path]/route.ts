import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000';

/**
 * Same-origin proxy to the API. Keeping the browser on the agency's own
 * hostname means the session cookie is first-party there, and the API learns
 * which hostname the visitor used from x-forwarded-host.
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  // Only the versioned public API is reachable from the browser.
  if (path[0] !== 'v1') return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });

  const host = req.headers.get('host') ?? '';
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';

  // Refuse writes that another site triggered in the visitor's browser.
  const origin = req.headers.get('origin');
  if (isWrite && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== host) {
      return Response.json({ error: { code: 'forbidden', message: 'Cross-site request refused' } }, { status: 403 });
    }
  }

  const body = isWrite ? await req.text() : '';
  const headers = new Headers({
    'x-forwarded-host': host,
    'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '',
    'x-proxy-secret': process.env.INTERNAL_PROXY_SECRET ?? '',
  });
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  if (body) headers.set('content-type', req.headers.get('content-type') ?? 'application/json');

  const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body: body || undefined, cache: 'no-store', redirect: 'manual' });
  } catch {
    return Response.json({ error: { code: 'unavailable', message: 'The service is unavailable. Try again shortly.' } }, { status: 502 });
  }

  const out = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  for (const value of upstream.headers.getSetCookie()) out.append('set-cookie', value);
  return new Response(await upstream.text(), { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
