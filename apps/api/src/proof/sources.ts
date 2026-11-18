/**
 * Which visits count as coming from an AI assistant. One list, used both by
 * the snippet (to decide what to send) and by the collector (to decide what
 * to keep), so the two can't drift apart.
 *
 * Google AI Overviews and AI Mode send visitors with google.com as the
 * referrer, the same as ordinary search, so no snippet can tell them apart.
 */

export interface AiSource {
  key: string;
  label: string;
  /** Referring hosts, matched exactly or as a subdomain. */
  hosts: string[];
  /** utm_source values, lower case. */
  utm: string[];
}

export const AI_SOURCES: AiSource[] = [
  { key: 'chatgpt', label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'], utm: ['chatgpt.com', 'chatgpt', 'openai'] },
  { key: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai'], utm: ['perplexity', 'perplexity.ai'] },
  { key: 'gemini', label: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'], utm: ['gemini', 'gemini.google.com', 'bard'] },
  { key: 'claude', label: 'Claude', hosts: ['claude.ai'], utm: ['claude', 'claude.ai'] },
  { key: 'copilot', label: 'Copilot', hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft'], utm: ['copilot', 'copilot.com', 'copilot.microsoft.com'] },
  { key: 'deepseek', label: 'DeepSeek', hosts: ['chat.deepseek.com', 'deepseek.com'], utm: ['deepseek', 'deepseek.com'] },
  { key: 'meta_ai', label: 'Meta AI', hosts: ['meta.ai'], utm: ['meta.ai', 'metaai'] },
  { key: 'grok', label: 'Grok', hosts: ['grok.com'], utm: ['grok', 'grok.com'] },
  { key: 'mistral', label: 'Le Chat (Mistral)', hosts: ['chat.mistral.ai'], utm: ['mistral', 'chat.mistral.ai'] },
  { key: 'you', label: 'You.com', hosts: ['you.com'], utm: ['you.com'] },
  { key: 'phind', label: 'Phind', hosts: ['phind.com'], utm: ['phind'] },
];

export const sourceLabel = (key: string) => AI_SOURCES.find((s) => s.key === key)?.label ?? key;

const onHost = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** The AI source of a visit, from its referrer or its landing page's utm_source; null when it isn't one. */
export function detectSource(referrer: string, landingUrl: string): { key: string; via: 'referrer' | 'utm' } | null {
  let refHost = '';
  try {
    refHost = referrer ? new URL(referrer).hostname.toLowerCase() : '';
  } catch {
    refHost = '';
  }
  if (refHost) {
    const byRef = AI_SOURCES.find((s) => s.hosts.some((h) => onHost(refHost, h)));
    if (byRef) return { key: byRef.key, via: 'referrer' };
  }
  let utm = '';
  try {
    utm = (new URL(landingUrl).searchParams.get('utm_source') ?? '').trim().toLowerCase();
  } catch {
    utm = '';
  }
  if (utm) {
    const byUtm = AI_SOURCES.find((s) => s.utm.includes(utm));
    if (byUtm) return { key: byUtm.key, via: 'utm' };
  }
  return null;
}

/**
 * The tracking script. Under 2 KB, no cookies, no third-party requests.
 * It sends:
 * - one "view" when the page was reached from an AI assistant;
 * - one "ping" per browser per day, carrying nothing but the site key, so the
 *   agency can see the snippet is installed;
 * - a "convert" when the site calls funnelgeo('convert', 'Name') during a
 *   visit that came from an AI assistant.
 * The session id lives in sessionStorage (this tab only) and is hashed again
 * on the server; nothing identifies the person.
 */
export function trackingScript(): string {
  const hosts = AI_SOURCES.flatMap((s) => s.hosts);
  const utm = AI_SOURCES.flatMap((s) => s.utm);
  return `/* AI visit tracking: records visits from AI assistants. No cookies. */
(function () {
  var d = document, w = window, s = d.currentScript, k = s && s.getAttribute('data-site');
  if (!k || w.__fgLoaded) return;
  w.__fgLoaded = true;
  var url = s.src.replace(/\\/t\\.js(\\?.*)?$/, '/c');
  var H = ${JSON.stringify(hosts)}, U = ${JSON.stringify(utm)};
  function store(t, key, v) { try { return v === undefined ? w[t].getItem(key) : w[t].setItem(key, v); } catch (e) { return null; } }
  function send(e, extra) {
    var b = { s: k, e: e, u: location.href, r: d.referrer, i: sid() };
    for (var x in extra) b[x] = extra[x];
    b = JSON.stringify(b);
    if (navigator.sendBeacon && navigator.sendBeacon(url, b)) return;
    try { fetch(url, { method: 'POST', body: b, keepalive: true, mode: 'no-cors', credentials: 'omit' }); } catch (err) {}
  }
  function sid() {
    var v = store('sessionStorage', 'fg_sid');
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); store('sessionStorage', 'fg_sid', v); }
    return v;
  }
  function isAi() {
    var h = '';
    try { h = d.referrer ? new URL(d.referrer).hostname.toLowerCase() : ''; } catch (e) {}
    for (var i = 0; i < H.length; i++) if (h && (h === H[i] || h.slice(-H[i].length - 1) === '.' + H[i])) return true;
    var m = /[?&]utm_source=([^&#]*)/i.exec(location.search), u = m ? decodeURIComponent(m[1]).toLowerCase() : '';
    return U.indexOf(u) > -1;
  }
  var today = new Date().toISOString().slice(0, 10);
  if (store('localStorage', 'fg_ping') !== today) { store('localStorage', 'fg_ping', today); send('ping', {}); }
  if (isAi()) { store('sessionStorage', 'fg_ai', '1'); send('view', /[?&]fg_test=1/.test(location.search) ? { t: 1 } : {}); }
  w.funnelgeo = function (cmd, name) {
    if (cmd === 'convert' && store('sessionStorage', 'fg_ai')) send('convert', { n: String(name || 'Conversion').slice(0, 80) });
  };
})();
`;
}
