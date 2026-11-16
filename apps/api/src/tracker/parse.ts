/**
 * Turns one stored answer into mentions and citations. Pure and deterministic:
 * the same answer and the same brand list always give the same result, which
 * is what lets stored answers be re-parsed after aliases or competitors change.
 *
 * Matching is by name and alias only. Indirect references ("the Koregaon Park
 * clinic") and sentiment need a language-model pass and are not done here.
 */

export interface Entity {
  /** null for the client itself, otherwise the competitor's id. */
  competitorId: string | null;
  name: string;
  aliases: string[];
  domain: string | null;
}

export interface ParsedMention {
  competitorId: string | null;
  position: number;
}

export interface ParsedCitation {
  position: number;
  url: string;
  domain: string;
  isClient: boolean;
}

export interface Parsed {
  mentions: ParsedMention[];
  citations: ParsedCitation[];
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Index of the first whole-word occurrence of a term, or -1. "Whole word"
 * means not glued to another letter or digit, so "Acme" matches "Acme's" and
 * "(Acme)" but not "Acmeville". Runs of whitespace in the term match any
 * whitespace, and case is ignored.
 */
export function firstIndex(text: string, term: string): number {
  const cleaned = term.trim();
  if (cleaned.length < 2) return -1;
  const body = cleaned.split(/\s+/).map(escapeRegex).join('\\s+');
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return match ? match.index : -1;
}

/** "https://www.Example.com/a?b" -> "example.com". Returns null for anything that is not a web address. */
export function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Drops tracking parameters engines append (utm_source=openai and the like), so one page counts once. */
export function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

const sameSite = (domain: string, site: string | null) => site !== null && (domain === site || domain.endsWith(`.${site}`));

export function parseAnswer(text: string, rawCitations: unknown, entities: Entity[]): Parsed {
  // Mentions: each brand's earliest appearance by name, alias or bare domain.
  const found: { competitorId: string | null; index: number; order: number }[] = [];
  entities.forEach((entity, order) => {
    const terms = [entity.name, ...entity.aliases, ...(entity.domain ? [entity.domain] : [])];
    const indexes = terms.map((term) => firstIndex(text, term)).filter((i) => i >= 0);
    if (indexes.length > 0) found.push({ competitorId: entity.competitorId, index: Math.min(...indexes), order });
  });
  // Ties (two brands starting at the same character) fall back to list order, so the result is stable.
  found.sort((a, b) => a.index - b.index || a.order - b.order);
  const mentions = found.map((f, i) => ({ competitorId: f.competitorId, position: i + 1 }));

  // Citations: web addresses only, de-duplicated, in the engine's order.
  const client = entities.find((e) => e.competitorId === null);
  const seen = new Set<string>();
  const citations: ParsedCitation[] = [];
  for (const raw of Array.isArray(rawCitations) ? rawCitations : []) {
    if (typeof raw !== 'string') continue;
    const url = cleanUrl(raw);
    const domain = domainOf(url);
    if (!domain || seen.has(url)) continue;
    seen.add(url);
    citations.push({ position: citations.length + 1, url, domain, isClient: sameSite(domain, client?.domain ?? null) });
  }

  return { mentions, citations };
}
