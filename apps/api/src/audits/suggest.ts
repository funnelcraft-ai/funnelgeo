import type { EngineSet } from '../engines.js';
import type { Intent } from './types.js';

/**
 * Ten buyer prompts from what the business does and where. Deterministic and
 * free. None of them contains the business's own name: an answer to a
 * question that names the brand would name it back, which says nothing about
 * whether AI assistants recommend it unprompted.
 */
export function suggestPrompts(category: string, location: string | null): { text: string; intent: Intent }[] {
  const c = category.trim().replace(/\s+/g, ' ').toLowerCase();
  const where = location?.trim() ? ` in ${location.trim()}` : '';
  const article = /^[aeiou]/.test(c) ? 'an' : 'a';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const prompts: { text: string; intent: Intent }[] = [
    { text: `Best ${c}${where}`, intent: 'category' },
    { text: `Which ${c}${where} do people recommend?`, intent: 'category' },
    { text: `Top rated ${c}${where}`, intent: 'category' },
    { text: `Affordable ${c}${where}`, intent: 'category' },
    { text: `Most trusted ${c}${where}`, intent: 'category' },
    { text: `${cap(c)}${where} with the best reviews`, intent: 'category' },
    { text: `Compare the best ${c} options${where}`, intent: 'comparison' },
    { text: `How do I choose a good ${c}${where}?`, intent: 'problem' },
    { text: `What should I look for in ${article} ${c}?`, intent: 'problem' },
    { text: `Is it worth paying more for a premium ${c}${where}?`, intent: 'problem' },
  ];
  return prompts;
}

/**
 * Pulls business names out of a "one name per line" answer. Tolerates the
 * numbering, bullets, bold and citation markers engines add, and drops
 * anything that reads like a sentence rather than a name.
 */
export function parseNameList(text: string, exclude: string[]): string[] {
  const banned = exclude.map((e) => e.toLowerCase()).filter((e) => e.length >= 3);
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw
      .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
      .replace(/^\s*(?:[-*•–]|\d+[.)]|#+)\s*/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    line = line.split(/\s+[–—-]\s+|:\s|\s\(/)[0]!.trim().replace(/[.,;]+$/, '');
    if (line.length < 2 || line.length > 60 || line.endsWith(':') || line.split(/\s+/).length > 7) continue;
    if (/^(here|these|the following|note|sure|i |some|based on)/i.test(line)) continue;
    const lower = line.toLowerCase();
    if (banned.some((b) => lower.includes(b) || b.includes(lower))) continue;
    if (names.some((n) => n.toLowerCase() === lower)) continue;
    names.push(line);
  }
  return names;
}

const SUGGEST_TIMEOUT_MS = 45_000;

/**
 * Asks one answer engine which businesses compete in this category and place.
 * Best effort: any failure returns no suggestions rather than an error. The
 * call is not charged in credits; routes that expose it are rate limited.
 */
export async function suggestCompetitors(
  engines: EngineSet,
  input: { business: string; domain: string; category: string; location: string | null },
  limit = 3,
): Promise<string[]> {
  const engine = engines.available.get('perplexity') ?? [...engines.available.values()][0];
  if (!engine) return [];
  const where = input.location ? ` in ${input.location}` : '';
  const prompt =
    `List up to 6 well-known ${input.category} businesses${where}, other than ${input.business}. ` +
    'Reply with only the business names, one per line, with no other text.';
  try {
    const answer = await engine.ask(prompt, AbortSignal.timeout(SUGGEST_TIMEOUT_MS));
    const domainName = input.domain.split('.')[0] ?? '';
    return parseNameList(answer.text, [input.business, domainName]).slice(0, limit);
  } catch {
    return [];
  }
}
