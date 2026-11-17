import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Fetches pages of a prospect's website for the AI-readiness check.
 *
 * The domain comes from a member of the public (the website widget), so this
 * is written to be safe to point at anything:
 *  - only http and https on the standard ports;
 *  - every connection, including each redirect, is checked at the moment it
 *    is made: a name that resolves to a private, loopback or otherwise
 *    reserved address is refused, so DNS tricks cannot reach internal systems;
 *  - at most 3 redirects, 10 seconds and 1.5 MB per page.
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export type SiteFetcher = (url: string) => Promise<FetchedPage>;

export class FetchRefused extends Error {}

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
// A neutral name: the prospect's server logs should not name the platform.
const USER_AGENT = 'Mozilla/5.0 (compatible; AI-Readiness-Check/1.0)';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True only for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as IPv4.
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup that refuses names resolving to anything but public addresses. */
function guardedLookup(hostname: string, options: { all?: boolean } & Record<string, unknown>, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new FetchRefused(`${hostname} is not on the public internet`), { code: 'EREFUSED_PRIVATE' }), '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

function requestOnce(url: URL, allowPrivate: boolean): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5' },
        timeout: TIMEOUT_MS,
        ...(allowPrivate ? {} : { lookup: guardedLookup as never }),
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            // Keep what fits: enough for every check.
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end();
  });
}

function checkUrl(url: URL, allowPrivate: boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('Only web addresses can be checked');
  if (url.username || url.password) throw new FetchRefused('Addresses with a login are not checked');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!allowPrivate && port !== '80' && port !== '443') throw new FetchRefused('Only the standard web ports are checked');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && !isPublicAddress(host)) throw new FetchRefused(`${host} is not on the public internet`);
}

/**
 * @param allowPrivate only for tests that serve a site from this machine.
 */
export function createSiteFetcher(options: { allowPrivate?: boolean } = {}): SiteFetcher {
  const allowPrivate = options.allowPrivate ?? false;
  return async (start) => {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      checkUrl(url, allowPrivate);
      const res = await requestOnce(url, allowPrivate);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new FetchRefused('Too many redirects');
        url = new URL(location, url);
        continue;
      }
      return { url: start, finalUrl: url.toString(), status: res.status, contentType: String(res.headers['content-type'] ?? ''), body: res.body };
    }
  };
}

/**
 * Development stand-in: a small made-up website, the same for every domain,
 * with a few typical problems. Refused in production, like the mock engines.
 */
export function createMockSiteFetcher(): SiteFetcher {
  return async (start) => {
    const url = new URL(start);
    const page = (status: number, contentType: string, body: string): FetchedPage => ({ url: start, finalUrl: url.toString(), status, contentType, body });
    const html = (title: string, body: string) =>
      `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
    const words = (n: number) => Array.from({ length: n }, (_, i) => ['local', 'trusted', 'team', 'service', 'care', 'quality'][i % 6]).join(' ');
    switch (url.pathname) {
      case '/robots.txt':
        return page(200, 'text/plain', `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\n`);
      case '/sitemap.xml':
        return page(200, 'application/xml', `<urlset><url><loc>${url.origin}/</loc></url><url><loc>${url.origin}/services</loc></url><url><loc>${url.origin}/about</loc></url></urlset>`);
      case '/':
        return page(200, 'text/html', html('Welcome', `<p>${words(220)}</p><h2>Our services</h2>`));
      case '/services':
        return page(200, 'text/html', html('Services', `<p>${words(120)}</p>`));
      case '/about':
        return page(200, 'text/html', html('About us', `<p>${words(90)}</p>`));
      default:
        // The pages the mock engine cites: a generic article naming only the stand-in businesses.
        if (['bestof.example', 'reviews.example', 'forum.example', 'news.example'].includes(url.hostname.replace(/^www\./, ''))) {
          return page(200, 'text/html', html('Top picks this year', `<p>${words(160)}</p><h2>Local Favourite</h2><p>${words(40)}</p><h2>City Central</h2><p>${words(40)}</p>`));
        }
        return page(404, 'text/html', html('Not found', ''));
    }
  };
}
