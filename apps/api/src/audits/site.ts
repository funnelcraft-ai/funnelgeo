import type { FetchedPage, SiteFetcher } from './fetch.js';
import { AI_CRAWLERS, isAllowed, parseRobots, type Robots } from './robots.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Check {
  key: CheckKey;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type CheckKey =
  | 'site_loads'
  | 'https'
  | 'ai_crawlers'
  | 'readable_without_js'
  | 'structured_data'
  | 'answer_structure'
  | 'page_basics'
  | 'sitemap'
  | 'llms_txt';

export interface SiteFindings {
  domain: string;
  finalUrl: string | null;
  pagesChecked: number;
  checks: Check[];
  /** Crawlers robots.txt keeps off the home page. */
  blockedCrawlers: { token: string; owner: string; label: string; kind: 'answers' | 'training' }[];
  schemaTypes: string[];
}

const MAX_PAGES = 10;

// HTML helpers -------------------------------------------------------------------
// Regular expressions are enough for these checks: they only look for a few
// well-known tags and never need the full document tree.

const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const stripTags = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The words a crawler that does not run JavaScript would see. */
export function visibleText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return stripTags(body.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' '));
}

const wordCount = (text: string) => (text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);

function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (key: string) => tag.match(new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    const nameAttr = attr('name') ?? attr('property');
    if (nameAttr && (nameAttr[2] ?? nameAttr[3] ?? '').toLowerCase() === name) {
      const content = attr('content');
      return content ? decode(content[2] ?? content[3] ?? '').trim() : null;
    }
  }
  return null;
}

/** Every schema.org @type in the page's JSON-LD blocks, including inside @graph. */
export function schemaTypes(html: string): string[] {
  const types = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const type = record['@type'];
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === 'string' && t) types.add(t.replace(/^.*[/#]/, ''));
    if (record['@graph']) visit(record['@graph']);
    for (const key of ['mainEntity', 'itemListElement', 'publisher', 'author', 'location']) if (record[key]) visit(record[key]);
  };
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]!.trim()));
    } catch {
      // A broken block is simply ignored, as crawlers do.
    }
  }
  return [...types].sort();
}

function questionHeadings(html: string): number {
  return [...html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi)].filter((m) => stripTags(m[1]!).endsWith('?')).length;
}

const isHtml = (page: FetchedPage) => /html/i.test(page.contentType) || /^\s*<(!doctype|html)/i.test(page.body);
const ok = (page: FetchedPage | null): page is FetchedPage => !!page && page.status >= 200 && page.status < 300;

async function tryFetch(fetcher: SiteFetcher, url: string): Promise<FetchedPage | null> {
  try {
    return await fetcher(url);
  } catch {
    return null;
  }
}

/** Up to `limit` page addresses on the same site, from the sitemap (following one sitemap index). */
async function sitemapPages(fetcher: SiteFetcher, sitemapUrl: string, siteHost: string, limit: number): Promise<{ found: boolean; pages: string[] }> {
  const sitemap = await tryFetch(fetcher, sitemapUrl);
  if (!ok(sitemap) || !/<(urlset|sitemapindex)\b/i.test(sitemap.body)) return { found: false, pages: [] };
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
  let urls = locs(sitemap.body);
  if (/<sitemapindex\b/i.test(sitemap.body) && urls[0]) {
    const child = await tryFetch(fetcher, urls[0]);
    urls = ok(child) ? locs(child.body) : [];
  }
  const sameSite = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === siteHost;
    } catch {
      return false;
    }
  };
  return { found: true, pages: urls.filter(sameSite).slice(0, limit) };
}

/** Runs the AI-readiness checks against one domain. Never throws for a site problem; reports it instead. */
export async function checkSite(domain: string, fetcher: SiteFetcher): Promise<SiteFindings> {
  const checks: Check[] = [];
  const add = (key: CheckKey, label: string, status: CheckStatus, detail: string) => checks.push({ key, label, status, detail });

  // 1. Does the home page load, and over HTTPS?
  let home = await tryFetch(fetcher, `https://${domain}/`);
  let secure = ok(home) && home.finalUrl.startsWith('https://');
  if (!ok(home)) home = await tryFetch(fetcher, `http://${domain}/`);
  if (ok(home) && home.finalUrl.startsWith('https://')) secure = true;

  if (!ok(home) || !isHtml(home)) {
    add('site_loads', 'Website loads for crawlers', 'fail', home ? `The home page answered with status ${home.status}.` : `We could not load ${domain}.`);
    for (const [key, label] of [
      ['https', 'Uses HTTPS'], ['ai_crawlers', 'AI crawlers are allowed'], ['readable_without_js', 'Readable without JavaScript'],
      ['structured_data', 'Structured data describes the business'], ['answer_structure', 'Content is written as answers'],
      ['page_basics', 'Page title and description'], ['sitemap', 'Sitemap is published'], ['llms_txt', 'llms.txt file'],
    ] as const) {
      add(key, label, 'unknown', 'Not checked, because the website did not load.');
    }
    return { domain, finalUrl: home?.finalUrl ?? null, pagesChecked: 0, checks, blockedCrawlers: [], schemaTypes: [] };
  }

  const origin = new URL(home.finalUrl).origin;
  const siteHost = new URL(home.finalUrl).hostname.replace(/^www\./, '');
  add('site_loads', 'Website loads for crawlers', 'pass', `The home page loads at ${home.finalUrl}.`);
  add('https', 'Uses HTTPS', secure ? 'pass' : 'fail', secure ? 'The site is served over HTTPS.' : 'The site does not load over HTTPS. Browsers and AI tools treat it as less trustworthy.');

  // 2. robots.txt: which AI crawlers may read the home page?
  const robotsPage = await tryFetch(fetcher, `${origin}/robots.txt`);
  const robots: Robots | null = ok(robotsPage) && !isHtml(robotsPage) ? parseRobots(robotsPage.body) : null;
  const blockedCrawlers = robots ? AI_CRAWLERS.filter((c) => !isAllowed(robots, c.token)).map((c) => ({ ...c })) : [];
  const blockedAnswers = blockedCrawlers.filter((c) => c.kind === 'answers');
  if (!robots) {
    add('ai_crawlers', 'AI crawlers are allowed', 'pass', 'There is no robots.txt file, so every crawler is allowed.');
  } else if (blockedAnswers.length > 0) {
    add('ai_crawlers', 'AI crawlers are allowed', 'fail', `robots.txt blocks ${blockedAnswers.map((c) => `${c.token} (${c.label})`).join(', ')}. Blocked sites are left out of those answers.`);
  } else if (blockedCrawlers.length > 0) {
    add('ai_crawlers', 'AI crawlers are allowed', 'warn', `AI search crawlers are allowed. robots.txt blocks ${blockedCrawlers.map((c) => `${c.token} (${c.label})`).join(', ')}, which only affects model training.`);
  } else {
    add('ai_crawlers', 'AI crawlers are allowed', 'pass', 'robots.txt allows the main AI search and training crawlers.');
  }

  // 3. Sitemap, and more pages to check.
  const sitemapCandidates = [...(robots?.sitemaps ?? []), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  let sitemap = { found: false, pages: [] as string[] };
  for (const candidate of [...new Set(sitemapCandidates)].slice(0, 3)) {
    sitemap = await sitemapPages(fetcher, candidate, siteHost, MAX_PAGES * 2);
    if (sitemap.found) break;
  }
  add('sitemap', 'Sitemap is published', sitemap.found ? 'pass' : 'warn', sitemap.found ? 'An XML sitemap lists the site’s pages.' : 'No XML sitemap was found. A sitemap helps crawlers find every page.');

  const homeKey = home.finalUrl.replace(/\/$/, '');
  const extra = sitemap.pages.filter((u) => u.replace(/\/$/, '') !== homeKey).slice(0, MAX_PAGES - 1);
  const others = (await Promise.all(extra.map((u) => tryFetch(fetcher, u)))).filter((p): p is FetchedPage => ok(p) && isHtml(p));
  const pages = [home, ...others];

  // 4. Readable without JavaScript.
  const words = wordCount(visibleText(home.body));
  add(
    'readable_without_js',
    'Readable without JavaScript',
    words >= 150 ? 'pass' : words >= 50 ? 'warn' : 'fail',
    words >= 150
      ? `The home page shows ${words} words without running JavaScript.`
      : `The home page shows only ${words} words without running JavaScript. Many AI crawlers do not run JavaScript, so they see little of the page.`,
  );

  // 5. Structured data.
  const types = [...new Set(pages.flatMap((p) => schemaTypes(p.body)))].sort();
  add(
    'structured_data',
    'Structured data describes the business',
    types.length > 0 ? 'pass' : 'fail',
    types.length > 0 ? `Found schema.org types: ${types.slice(0, 8).join(', ')}.` : 'No schema.org structured data was found. It tells AI tools plainly what the business is, where it is and what it offers.',
  );

  // 6. Answer structure: question headings or FAQ markup.
  const questions = pages.reduce((sum, p) => sum + questionHeadings(p.body), 0);
  const faq = types.includes('FAQPage');
  add(
    'answer_structure',
    'Content is written as answers',
    faq || questions >= 2 ? 'pass' : 'warn',
    faq || questions >= 2
      ? `Found ${faq ? 'FAQ markup' : ''}${faq && questions ? ' and ' : ''}${questions ? `${questions} question headings` : ''} across ${pages.length} pages.`
      : `None of the ${pages.length} pages checked has a questions-and-answers section. AI tools quote pages that answer questions directly.`,
  );

  // 7. Title and description.
  const title = stripTags(home.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const description = metaContent(home.body, 'description');
  const basics = [title ? null : 'a page title', description ? null : 'a meta description'].filter(Boolean);
  add(
    'page_basics',
    'Page title and description',
    basics.length === 0 ? 'pass' : 'warn',
    basics.length === 0 ? `Title: “${title.slice(0, 80)}”.` : `The home page has no ${basics.join(' or ')}.`,
  );

  // 8. llms.txt.
  const llms = await tryFetch(fetcher, `${origin}/llms.txt`);
  const hasLlms = ok(llms) && !isHtml(llms) && llms.body.trim().length > 0;
  add(
    'llms_txt',
    'llms.txt file',
    hasLlms ? 'pass' : 'warn',
    hasLlms
      ? 'The site publishes an llms.txt summary for AI tools.'
      : 'No llms.txt file. It is a new convention for summarising a site for AI tools; few engines are known to use it yet, so this matters least.',
  );

  // Keep the checks in a fixed order, whatever order they were run in.
  const order: CheckKey[] = ['site_loads', 'https', 'ai_crawlers', 'readable_without_js', 'structured_data', 'answer_structure', 'page_basics', 'sitemap', 'llms_txt'];
  checks.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { domain, finalUrl: home.finalUrl, pagesChecked: pages.length, checks, blockedCrawlers, schemaTypes: types };
}
