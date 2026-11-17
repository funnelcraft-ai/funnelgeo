/**
 * Sorts every cited site into one of the PRD's source types. Pure and
 * deterministic: built-in rules, then the agency's own corrections on top.
 *
 * The rules are deliberately conservative. A site no rule recognises is
 * "other", never a guess, and the agency can correct any site in one click.
 */

export type SourceType = 'own' | 'competitor' | 'list_review' | 'forum' | 'directory' | 'news' | 'other';
/** The types an agency may set by hand. Own and competitor sites follow from the client's brands. */
export type ThirdPartyType = Exclude<SourceType, 'own' | 'competitor'>;
export const THIRD_PARTY_TYPES: ThirdPartyType[] = ['list_review', 'directory', 'forum', 'news', 'other'];

export const SOURCE_LABEL: Record<SourceType, string> = {
  own: 'Client’s site',
  competitor: 'Competitor’s site',
  list_review: 'List or review article',
  forum: 'Forum or social',
  directory: 'Directory or review site',
  news: 'News',
  other: 'Other',
};

/** How a cause sentence refers to a group of pages of one type. */
export const SOURCE_NOUN: Record<ThirdPartyType, [string, string]> = {
  list_review: ['comparison or review article', 'comparison and review articles'],
  directory: ['directory listing', 'directory listings'],
  forum: ['forum or social post', 'forum and social posts'],
  news: ['news article', 'news articles'],
  other: ['third-party page', 'third-party pages'],
};

const FORUM = [
  'reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'answers.microsoft.com', 'discord.com',
  'youtube.com', 'youtu.be', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
  'pinterest.com', 'threads.net', 'medium.com', 'substack.com', 'tumblr.com', 'nextdoor.com', 'producthunt.com',
  'news.ycombinator.com', 'teamblind.com', 'mumsnet.com', 'team-bhp.com', 'indiehackers.com',
];
const DIRECTORY = [
  'yelp.com', 'tripadvisor.com', 'tripadvisor.in', 'yellowpages.com', 'bbb.org', 'angi.com', 'angieslist.com', 'houzz.com',
  'thumbtack.com', 'homeadvisor.com', 'porch.com', 'manta.com', 'mapquest.com', 'foursquare.com', 'superpages.com',
  'trustpilot.com', 'sitejabber.com', 'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com', 'clutch.co',
  'goodfirms.co', 'designrush.com', 'sortlist.com', 'upcity.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com',
  'zocdoc.com', 'healthgrades.com', 'vitals.com', 'webmd.com', 'practo.com', 'lybrate.com', 'justdial.com',
  'sulekha.com', 'indiamart.com', 'tradeindia.com', 'magicpin.in', 'zomato.com', 'swiggy.com', 'urbancompany.com',
  'opentable.com', 'booking.com', 'expedia.com', 'agoda.com', 'airbnb.com', 'zillow.com', 'realtor.com',
  '99acres.com', 'magicbricks.com', 'housing.com', 'nobroker.in', 'amazon.com', 'amazon.in', 'flipkart.com',
  'etsy.com', 'ebay.com', 'apps.apple.com', 'play.google.com', 'chromewebstore.google.com', 'alternativeto.net',
  'producthunt.co', 'wellfound.com', 'zaubacorp.com', 'tofler.in', 'local.yahoo.com', 'bing.com', 'maps.google.com',
];
const NEWS = [
  'nytimes.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com', 'bloomberg.com', 'apnews.com', 'theguardian.com',
  'wsj.com', 'washingtonpost.com', 'usatoday.com', 'cnbc.com', 'axios.com', 'npr.org', 'latimes.com', 'ft.com',
  'economist.com', 'businessinsider.com', 'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com',
  'engadget.com', 'venturebeat.com', 'fastcompany.com', 'inc.com', 'entrepreneur.com', 'fortune.com', 'time.com',
  'timesofindia.indiatimes.com', 'indiatimes.com', 'economictimes.indiatimes.com', 'hindustantimes.com',
  'indianexpress.com', 'thehindu.com', 'ndtv.com', 'livemint.com', 'moneycontrol.com', 'business-standard.com',
  'financialexpress.com', 'news18.com', 'indiatoday.in', 'firstpost.com', 'scroll.in', 'theprint.in', 'yourstory.com',
  'inc42.com', 'deccanherald.com', 'telegraphindia.com', 'thestar.com', 'cbc.ca', 'abc.net.au', 'smh.com.au',
  'straitstimes.com', 'gulfnews.com', 'khaleejtimes.com', 'aljazeera.com',
];
const LIST_REVIEW = [
  'wirecutter.com', 'tomsguide.com', 'pcmag.com', 'techradar.com', 'cnet.com', 'rtings.com', 'consumerreports.org',
  'zdnet.com', 'theverge.com/reviews', 'expertise.com', 'threebestrated.com', 'threebestrated.in', 'top10.com',
  'bestreviews.com', 'nerdwallet.com', 'investopedia.com', 'thepointsguy.com', 'goodhousekeeping.com',
  'gadgets360.com', 'smartprix.com', 'beebom.com', 'digit.in', '91mobiles.com',
];

/** Slug words that mark a ranking, comparison or review page. */
const LIST_WORDS = /(^|[^a-z])(best|top|vs|versus|review|reviews|reviewed|compare|comparison|compared|alternatives?|ranked|ranking|rankings|rated|picks|recommended|guide-to-the-best|leading)([^a-z]|$)/;
const LIST_TITLE = /\b(best|top\s+\d+|\d+\s+best|vs\.?|versus|reviews?|compared|comparison|alternatives|ranked|ranking)\b/i;
const FORUM_PATH = /\/(forum|forums|community|thread|threads|t|discussion|discussions|questions|q|r)\//;
const NEWS_PATH = /\/(news|press|press-release|press-releases)\/|\/(19|20)\d{2}\/(0?[1-9]|1[0-2])\//;

const onSite = (domain: string, site: string) => domain === site || domain.endsWith(`.${site}`);

function listed(domain: string, path: string, list: string[]): boolean {
  return list.some((entry) => {
    const [site, ...rest] = entry.split('/');
    if (!onSite(domain, site!)) return false;
    return rest.length === 0 || path.startsWith(`/${rest.join('/')}`);
  });
}

export interface ClassifyContext {
  clientDomain: string | null;
  competitors: { id: string; domain: string | null }[];
  /** The agency's corrections, by domain. */
  overrides: Map<string, ThirdPartyType>;
}

export interface Classified {
  type: SourceType;
  /** The competitor whose own site this is. */
  competitorId: string | null;
  /** True when the type came from the agency's correction. */
  corrected: boolean;
}

/** The type of one cited page. The title, when the page was opened, sharpens list detection. */
export function classifySource(url: string, domain: string, ctx: ClassifyContext, title?: string | null): Classified {
  if (ctx.clientDomain && onSite(domain, ctx.clientDomain)) return { type: 'own', competitorId: null, corrected: false };
  const competitor = ctx.competitors.find((c) => c.domain && onSite(domain, c.domain));
  if (competitor) return { type: 'competitor', competitorId: competitor.id, corrected: false };

  // The most specific correction wins: blog.example.com before example.com.
  const corrections = [...ctx.overrides].filter(([site]) => onSite(domain, site)).sort((a, b) => b[0].length - a[0].length);
  if (corrections[0]) return { type: corrections[0][1], competitorId: null, corrected: true };

  let path = '/';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // keep '/'
  }
  const type = ((): ThirdPartyType => {
    if (listed(domain, path, FORUM)) return 'forum';
    if (listed(domain, path, DIRECTORY)) return 'directory';
    if (listed(domain, path, LIST_REVIEW)) return 'list_review';
    // A "best dentists" piece on a news site is still a list.
    if (LIST_WORDS.test(path) || (title && LIST_TITLE.test(title))) return 'list_review';
    if (listed(domain, path, NEWS)) return 'news';
    if (FORUM_PATH.test(path) || /^(forum|forums|community|discuss)\./.test(domain)) return 'forum';
    if (NEWS_PATH.test(path) || /^(news|press)\./.test(domain)) return 'news';
    return 'other';
  })();
  return { type, competitorId: null, corrected: false };
}
