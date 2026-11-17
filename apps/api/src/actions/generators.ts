import type { SiteFetcher } from '../audits/fetch.js';
import type { SiteFindings } from '../audits/site.js';
import { joinAll } from '../diagnosis/diagnose.js';
import type { Writer } from '../writer.js';
import type { ActionDetails, ActionType, AssetKind } from './rules.js';

/**
 * What each generator produces. Two are built by rules (robots.txt fix and
 * llms.txt) and cost nothing; the rest are written by the writing model and
 * cost credits by size. Every output is a starting point to edit: nothing is
 * published, and the model is told never to invent facts about the business.
 */

export const ASSET_LABEL: Record<AssetKind, string> = {
  brief: 'Content brief',
  draft: 'Draft',
  faq_schema: 'FAQ with JSON-LD',
  llms_txt: 'llms.txt',
  robots_patch: 'robots.txt fix',
  outreach_email: 'Outreach email',
  listing: 'Listing copy',
  review_request: 'Review request email',
};

/** Credits per generated asset, by size: S 1, M 2, L 4. Built-by-rules files are free. Provisional until the cost spike. */
export const ASSET_CREDITS: Record<AssetKind, number> = {
  brief: 2,
  draft: 4,
  faq_schema: 2,
  llms_txt: 0,
  robots_patch: 0,
  outreach_email: 1,
  listing: 1,
  review_request: 1,
};

/** Download name and type for each kind. */
export const ASSET_FILE: Record<AssetKind, { name: (slug: string) => string; type: string }> = {
  brief: { name: (s) => `${s}-brief.md`, type: 'text/markdown; charset=utf-8' },
  draft: { name: (s) => `${s}-draft.md`, type: 'text/markdown; charset=utf-8' },
  faq_schema: { name: (s) => `${s}-faq.html`, type: 'text/html; charset=utf-8' },
  llms_txt: { name: () => 'llms.txt', type: 'text/plain; charset=utf-8' },
  robots_patch: { name: () => 'robots.txt', type: 'text/plain; charset=utf-8' },
  outreach_email: { name: (s) => `${s}-outreach-email.txt`, type: 'text/plain; charset=utf-8' },
  listing: { name: (s) => `${s}-listing.md`, type: 'text/markdown; charset=utf-8' },
  review_request: { name: (s) => `${s}-review-request.txt`, type: 'text/plain; charset=utf-8' },
};

const MAX_TOKENS: Record<AssetKind, number> = { brief: 1800, draft: 3500, faq_schema: 1800, llms_txt: 0, robots_patch: 0, outreach_email: 700, listing: 900, review_request: 600 };

export interface GenContext {
  client: { name: string; domain: string | null; category: string | null; location: string | null; voice: string | null };
  action: { type: ActionType; title: string; rationale: string; details: ActionDetails };
  /** The lost questions the action addresses. */
  questions: string[];
  competitors: string[];
  site: SiteFindings | null;
  /** The latest brief for this action, which a draft follows. */
  brief: string | null;
}

export interface Generated {
  content: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  mode: 'live' | 'mock';
}

// Shared instructions -----------------------------------------------------------------

const RULES = [
  'Never invent facts about the business: no prices, dates, years in business, awards, certifications, staff names, addresses, phone numbers, statistics, reviews, testimonials or guarantees.',
  'Where such a fact is needed, write a placeholder in square brackets that starts with ADD:, for example [ADD: price range for a single implant] or [ADD: years in practice].',
  'Do not criticise competitors or claim to be "the best", "number one" or "leading". Be specific and useful instead.',
  'Write for people first: plain words, short sentences, the direct answer first.',
  'Return only the requested text, with no preamble and no closing remarks.',
].join('\n');

function about(ctx: GenContext): string {
  const c = ctx.client;
  return [
    `Business: ${c.name}`,
    c.domain ? `Website: https://${c.domain}/` : null,
    c.category ? `Category: ${c.category}` : null,
    c.location ? `Location: ${c.location}` : null,
    c.voice ? `How the business writes (follow this voice):\n${c.voice}` : 'Voice: clear, warm and professional.',
  ]
    .filter(Boolean)
    .join('\n');
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

function evidence(ctx: GenContext): string {
  const d = ctx.action.details;
  const lines = [
    ctx.questions.length ? `Questions buyers ask AI assistants, where ${ctx.client.name} is not named:\n${bullets(ctx.questions.map((q) => `“${q}”`))}` : null,
    d.competitors?.length ? `Named instead: ${joinAll(d.competitors)}` : null,
    d.pages?.length ? `Pages the AI answers cite:\n${bullets(d.pages.map((p) => `${p.title ? `${p.title} — ` : ''}${p.url}`))}` : null,
  ];
  return lines.filter(Boolean).join('\n\n');
}

// Built by rules ------------------------------------------------------------------------

/** Rewrites robots.txt so the named crawlers may read the whole site; everything else is kept as it was. */
export function patchRobots(original: string | null, tokens: string[]): string {
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  const header = [
    '# Lets AI search crawlers read the site so AI answers can cite it.',
    `# Added: explicit Allow rules for ${tokens.join(', ')}. Model-training crawlers are unchanged.`,
    ...tokens.map((t) => `User-agent: ${t}`),
    'Allow: /',
    '',
  ];
  if (!original || !original.trim()) return [...header, 'User-agent: *', 'Allow: /', ''].join('\n');

  // Split into groups: user-agent lines followed by their rules. Other lines stay where they are.
  const lines = original.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let group: { agents: string[]; rules: string[] } | null = null;
  const flush = () => {
    if (!group) return;
    const kept = group.agents.filter((line) => !wanted.has(line.replace(/^\s*user-agent\s*:\s*/i, '').replace(/\s*#.*$/, '').trim().toLowerCase()));
    // A group that only named these crawlers goes; their rules now come from the header.
    if (kept.length > 0) out.push(...kept, ...group.rules);
    group = null;
  };
  for (const line of lines) {
    const isAgent = /^\s*user-agent\s*:/i.test(line);
    const isRule = /^\s*(allow|disallow|crawl-delay)\s*:/i.test(line);
    if (isAgent) {
      if (group && group.rules.some((r) => /^\s*(allow|disallow|crawl-delay)\s*:/i.test(r))) flush();
      group ??= { agents: [], rules: [] };
      group.agents.push(line);
    } else if (isRule && group) {
      group.rules.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return [...header, ...out].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

/** Page names from addresses: /services/teeth-whitening -> "Services: Teeth whitening". */
function pageName(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, '').replace(/\.(html?|php|aspx?)$/i, '');
  if (!path) return 'Home';
  return path
    .split('/')
    .filter(Boolean)
    .slice(-2)
    .map((part) => decodeURIComponent(part).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
    .join(': ');
}

/** An llms.txt in the llmstxt.org format, from the site's own sitemap. */
export async function buildLlmsTxt(ctx: GenContext, fetcher: SiteFetcher): Promise<string> {
  const c = ctx.client;
  const origin = `https://${c.domain}`;
  const urls: string[] = [];
  for (const candidate of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
    try {
      const page = await fetcher(candidate);
      if (page.status >= 400) continue;
      let locs = [...page.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.trim());
      // A sitemap index: read its first child sitemap.
      if (/<sitemapindex/i.test(page.body) && locs[0]) {
        const child = await fetcher(locs[0]);
        locs = child.status < 400 ? [...child.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.trim()) : [];
      }
      urls.push(...locs.filter((u) => /^https?:\/\//.test(u)));
      if (urls.length) break;
    } catch {
      // try the next one
    }
  }
  const pages = [...new Set([`${origin}/`, ...urls])].slice(0, 25);
  const summary = [
    `${c.name} is ${c.category ? `a ${c.category.toLowerCase()}` : 'a business'}${c.location ? ` in ${c.location}` : ''}.`,
    '[ADD: one or two sentences on what it offers and who it is for.]',
  ].join(' ');
  return [
    `# ${c.name}`,
    '',
    `> ${summary}`,
    '',
    '## Main pages',
    '',
    ...pages.map((u) => `- [${pageName(u)}](${u})`),
    '',
    '## Optional',
    '',
    '- [ADD: links to pricing, policies or other pages AI assistants should know about]',
    '',
  ].join('\n');
}

// FAQ ---------------------------------------------------------------------------------

const escapeHtml = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function parseFaqs(text: string): { question: string; answer: string }[] {
  const json = text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '');
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The writing model did not return the FAQ in the expected format.');
  const data = JSON.parse(json.slice(start, end + 1));
  const faqs = (Array.isArray(data.faqs) ? data.faqs : [])
    .filter((f: any) => typeof f?.question === 'string' && typeof f?.answer === 'string' && f.question.trim() && f.answer.trim())
    .map((f: any) => ({ question: f.question.trim().slice(0, 300), answer: f.answer.trim().slice(0, 1500) }))
    .slice(0, 12);
  if (faqs.length < 2) throw new Error('The writing model returned fewer than two questions.');
  return faqs;
}

/** The visible FAQ section and its FAQPage JSON-LD, ready to paste into a page. */
export function faqHtml(faqs: { question: string; answer: string }[]): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
  };
  return [
    '<!-- Replace every [ADD: …] before publishing. The questions and answers below must match what the page shows. -->',
    '<section class="faq">',
    '  <h2>Frequently asked questions</h2>',
    ...faqs.flatMap((f) => [`  <h3>${escapeHtml(f.question)}</h3>`, `  <p>${escapeHtml(f.answer)}</p>`]),
    '</section>',
    '',
    '<script type="application/ld+json">',
    JSON.stringify(ld, null, 2).replace(/</g, '\\u003c'),
    '</script>',
    '',
  ].join('\n');
}

// Prompts for the writing model -------------------------------------------------------

export function promptFor(kind: AssetKind, ctx: GenContext): { system: string; prompt: string } {
  const C = ctx.client.name;
  const d = ctx.action.details;
  const page = d.pages?.[0];
  switch (kind) {
    case 'brief':
      return {
        system: `You write content briefs for an SEO and AI-search agency. A writer at the agency will use your brief to write one web page for a client.\n${RULES}`,
        prompt: [
          about(ctx),
          `Task: ${ctx.action.title}\nWhy: ${ctx.action.rationale}`,
          evidence(ctx),
          'Write the brief in Markdown with these sections, in this order:',
          '## Goal (two sentences)\n## Page (a new page with a suggested URL path, or which page to update)\n## Title and meta description\n## Outline (H2 and H3 headings, each with one line on what it must say; open with a direct answer to the main question)\n## Questions the page must answer\n## Facts to get from the client (a checklist of [ADD: …] items)\n## Structured data to add',
        ].join('\n\n'),
      };
    case 'draft':
      return {
        system: `You write web pages for a business, in its own voice, that answer buyers' questions directly so AI assistants and search engines can quote them.\n${RULES}`,
        prompt: [
          about(ctx),
          `Task: ${ctx.action.title}`,
          evidence(ctx),
          ctx.brief ? `Follow this brief:\n\n${ctx.brief}` : 'There is no brief: open with a direct two-sentence answer, then cover what buyers compare on, then a short FAQ.',
          'Write the full page in Markdown: one H1, then 600 to 1000 words. Put a two-sentence direct answer right under the H1. End with a short FAQ section.',
        ].join('\n\n'),
      };
    case 'faq_schema':
      return {
        system: `You write FAQ entries for a business's website: real questions buyers ask, each with a direct, factual answer of 40 to 80 words.\n${RULES}`,
        prompt: [
          about(ctx),
          evidence(ctx),
          `Write 5 to 8 questions and answers. Include the questions above, reworded naturally as a buyer would ask them on ${C}'s site, plus closely related ones.`,
          'Return JSON only, in this shape: {"faqs":[{"question":"...","answer":"..."}]}',
        ].join('\n\n'),
      };
    case 'outreach_email':
      return {
        system: `You write short, polite outreach emails from a business to the editor or author of a web page, asking them to consider including the business. No flattery beyond one specific line, no payment offers, no pressure.\n${RULES}`,
        prompt: [
          about(ctx),
          page ? `The page: ${page.title ? `“${page.title}” ` : ''}${page.url}` : `The site: ${d.domain}`,
          d.competitors?.length ? `The page or site features: ${joinAll(d.competitors)}` : null,
          `Write the email from ${C}. First line: "Subject: …". Then the body, under 150 words: why ${C} fits the page's readers, two or three specific points with [ADD: …] where facts are needed, and an offer to send details. Use [ADD: recipient name] for the greeting.`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    case 'listing':
      return {
        system: `You write business listings for directories, accurate and specific.\n${RULES}`,
        prompt: [
          about(ctx),
          `Directory: ${d.domain}`,
          ctx.questions.length ? `Buyers ask questions like:\n${bullets(ctx.questions.map((q) => `“${q}”`))}` : null,
          'Write in Markdown: **Business name**, **Short description** (under 160 characters), **Full description** (under 750 characters), **Categories** (3 to 5), **Services** (a list), **Details to fill in** (address, hours, phone, website, photos, as [ADD: …] items).',
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    case 'review_request':
      return {
        system: `You write short emails from a business asking its recent customers for an honest review. Ask every recent customer, not only happy ones; offer nothing in return; never suggest what to write. These rules follow the review platforms' policies.\n${RULES}`,
        prompt: [about(ctx), `Review site: ${d.domain}`, `Write the email from ${C}. First line: "Subject: …". Body under 120 words, with [ADD: link to the ${d.domain} review page] and [ADD: customer first name].`].join('\n\n'),
      };
    default:
      throw new Error(`${kind} is not written by the model`);
  }
}

// Stand-in text in mock mode ---------------------------------------------------------

function mockText(kind: AssetKind, ctx: GenContext): string {
  const C = ctx.client.name;
  const q = ctx.questions[0] ?? ctx.action.title;
  const note = 'Demo text, written without a model because the platform is in mock mode.';
  switch (kind) {
    case 'brief':
      return `<!-- ${note} -->\n# Content brief: ${ctx.action.title}\n\n## Goal\nAnswer “${q}” on ${C}'s site so AI assistants can cite it.\n\n## Page\nNew page at /[ADD: path]\n\n## Outline\n- Direct answer to “${q}”\n- What buyers compare on\n- Why ${C} [ADD: what sets it apart]\n- FAQ\n\n## Facts to get from the client\n- [ ] [ADD: prices]\n- [ ] [ADD: opening hours]\n`;
    case 'draft':
      return `<!-- ${note} -->\n# ${q}\n\n${C} [ADD: direct two-sentence answer].\n\n## What to look for\n[ADD: the three things buyers compare on]\n\n## FAQ\n**${q}**\n[ADD: answer]\n`;
    case 'faq_schema':
      return JSON.stringify({
        faqs: [...ctx.questions, `What does ${C} offer?`, `Where is ${C}, and when is it open?`].slice(0, 6).map((question) => ({ question, answer: `${C} [ADD: direct answer in two or three sentences].` })),
      });
    case 'outreach_email':
      return `Subject: A suggestion for ${ctx.action.details.pages?.[0]?.title ?? ctx.action.details.domain}\n\nHi [ADD: recipient name],\n\n${note}\n\n${C} [ADD: why it fits your readers]. Happy to send details.\n\n[ADD: sender name]\n${C}`;
    case 'listing':
      return `<!-- ${note} -->\n**Business name:** ${C}\n\n**Short description:** [ADD: under 160 characters]\n\n**Details to fill in:** [ADD: address], [ADD: hours], [ADD: phone]\n`;
    case 'review_request':
      return `Subject: How was your visit to ${C}?\n\nHi [ADD: customer first name],\n\n${note}\n\nWould you share an honest review? [ADD: link to the ${ctx.action.details.domain} review page]\n\nThank you,\n${C}`;
    default:
      return note;
  }
}

/** Produces one asset. Throws with a reason the screen can show when it can't. */
export async function generate(kind: AssetKind, ctx: GenContext, writer: Writer, fetcher: SiteFetcher, signal: AbortSignal): Promise<Generated> {
  if (kind === 'robots_patch') {
    if (!ctx.client.domain) throw new Error('Add the client’s website address first.');
    let original: string | null = null;
    try {
      const page = await fetcher(`https://${ctx.client.domain}/robots.txt`);
      if (page.status < 400 && !/html/i.test(page.contentType)) original = page.body;
    } catch {
      // No readable robots.txt: the fix is a new file.
    }
    const bots = ctx.action.details.bots?.length ? ctx.action.details.bots : (ctx.site?.blockedCrawlers ?? []).filter((c) => c.kind === 'answers').map((c) => c.token);
    if (bots.length === 0) throw new Error('The latest website check shows no AI search crawler blocked.');
    return { content: patchRobots(original, bots), model: null, tokensIn: 0, tokensOut: 0, mode: 'live' };
  }
  if (kind === 'llms_txt') {
    if (!ctx.client.domain) throw new Error('Add the client’s website address first.');
    return { content: await buildLlmsTxt(ctx, fetcher), model: null, tokensIn: 0, tokensOut: 0, mode: 'live' };
  }

  const written =
    writer.mode === 'mock'
      ? { text: mockText(kind, ctx), model: 'mock', tokensIn: 0, tokensOut: 0 }
      : await writer.write({ ...promptFor(kind, ctx), maxTokens: MAX_TOKENS[kind] }, signal);
  const content = kind === 'faq_schema' ? faqHtml(parseFaqs(written.text)) : written.text.trim() + '\n';
  return { content, model: written.model, tokensIn: written.tokensIn, tokensOut: written.tokensOut, mode: writer.mode };
}
