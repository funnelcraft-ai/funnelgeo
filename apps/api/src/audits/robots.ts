/**
 * Just enough of robots.txt (RFC 9309) to answer one question: may a given
 * crawler fetch the home page?
 */

export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group; one after a rule starts a new group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/**
 * The rules for a crawler are those of the groups naming it, or, when none
 * does, the groups for "*". The longest matching rule wins and, on a tie,
 * allow wins. An empty Disallow allows everything.
 */
export function isAllowed(robots: Robots, agent: string, path = '/'): boolean {
  const token = agent.toLowerCase();
  let groups = robots.groups.filter((g) => g.agents.includes(token));
  if (groups.length === 0) groups = robots.groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (rule.path === '' || !matches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

/**
 * The crawlers checked, from each company's published documentation
 * (checked 16 Nov 2026). "answers" crawlers decide whether a site can appear
 * in AI answers; blocking a "training" crawler only opts out of model training.
 * Crawlers that fetch on a user's request (ChatGPT-User, Perplexity-User) are
 * left out because their owners say robots.txt may not apply to them.
 */
export const AI_CRAWLERS = [
  { token: 'OAI-SearchBot', owner: 'OpenAI', label: 'ChatGPT search', kind: 'answers' },
  { token: 'PerplexityBot', owner: 'Perplexity', label: 'Perplexity search', kind: 'answers' },
  { token: 'Claude-SearchBot', owner: 'Anthropic', label: 'Claude search', kind: 'answers' },
  { token: 'Google-Extended', owner: 'Google', label: 'Gemini answers and training', kind: 'answers' },
  { token: 'GPTBot', owner: 'OpenAI', label: 'OpenAI model training', kind: 'training' },
  { token: 'ClaudeBot', owner: 'Anthropic', label: 'Claude model training', kind: 'training' },
  { token: 'CCBot', owner: 'Common Crawl', label: 'Common Crawl, used to train many models', kind: 'training' },
] as const;
