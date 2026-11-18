export type Role = 'super_admin' | 'agency_owner' | 'agency_member' | 'client_viewer';

export interface Branding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  senderName?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export type Tenant =
  | { kind: 'platform'; name: string }
  | { kind: 'agency'; name: string; branding: Branding; suspended: boolean; widgetEnabled: boolean };

export interface SessionUser {
  id: string;
  agencyId: string | null;
  clientId: string | null;
  email: string;
  name: string;
  role: Role;
}

export interface Session {
  user: SessionUser;
  agency: { name: string; slug: string; host: string } | null;
}

export interface Client {
  id: string;
  name: string;
  domain: string | null;
  brandAliases: string[];
  vertical: string | null;
  language: string;
  country: string | null;
  status: 'prospect' | 'active' | 'paused';
  createdAt: string;
}

export interface Agency {
  id: string;
  name: string;
  slug: string;
  branding: Branding;
  widgetEnabled: boolean;
  runEmails: 'owners' | 'staff' | 'off';
  workspaceUrl: string;
  defaultHost: string;
  customDomain: string | null;
  domainStatus: 'none' | 'pending' | 'verified' | 'failed';
  cnameTarget: string;
  plan: { key: string; name: string; clientLimit: number; promptsPerClient: number; samplesPerPrompt: number; auditsPerMonth: number };
}

export interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  clientName: string | null;
  lastLoginAt: string | null;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: Role;
  clientName: string | null;
  expiresAt: string;
}

export interface AdminAgency {
  id: string;
  name: string;
  slug: string;
  workspaceUrl: string;
  customDomain: string | null;
  domainStatus: string;
  status: 'active' | 'suspended';
  planKey: string;
  planName: string;
  clientCount: number;
  userCount: number;
  createdAt: string;
}

export interface Plan {
  key: string;
  name: string;
  clientLimit: number;
}

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super admin',
  agency_owner: 'Owner',
  agency_member: 'Team member',
  client_viewer: 'Client viewer',
};

// Tracker --------------------------------------------------------------------

export type Intent = 'category' | 'comparison' | 'problem' | 'brand';
export const INTENT_LABEL: Record<Intent, string> = { category: 'Category', comparison: 'Comparison', problem: 'Problem', brand: 'Brand' };

export interface Prompt {
  id: string;
  text: string;
  intent: Intent;
  priority: boolean;
  persona: string | null;
  active: boolean;
}

export interface Competitor {
  id: string;
  name: string;
  domain: string | null;
  aliases: string[];
}

export interface Run {
  id: string;
  trigger: 'manual' | 'scheduled' | 'audit';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  engineMode: 'live' | 'mock';
  engineKeys: string[];
  samples: number;
  promptCount: number;
  totalCalls: number;
  okCalls: number;
  failedCalls: number;
  credits: number;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Tracker {
  client: { id: string; name: string; domain: string | null; brandAliases: string[]; status: string; schedule: 'off' | 'weekly'; nextRunAt: string | null; voice: string | null };
  competitors: Competitor[];
  prompts: Prompt[];
  runs: Run[];
  engineMode: 'live' | 'mock';
  trend: { runId: string; finishedAt: string; engineMode: string; answers: number; mentioned: number }[];
  // Agency staff only:
  engines?: { key: string; label: string; creditCost: number; available: boolean }[];
  limits?: { prompts: number; competitors: number; samples: number };
  estimate?: { callsPerRun: number; creditsPerRun: number; creditsPerMonth: number };
  credits?: { allowance: number; remaining: number };
}

export interface Visibility {
  totals: { answers: number; mentioned: number; cited: number; failed: number; pending: number };
  engines: { key: string; label: string; answers: number; failed: number; mentioned: number; cited: number }[];
  brands: { id: string | null; name: string; isClient: boolean; mentions: number; avgPosition: number | null }[];
  prompts: { id: string; text: string; intent: Intent; priority: boolean; answers: number; mentioned: number; engines: Record<string, { answers: number; mentioned: number }> }[];
  domains: { domain: string; answers: number; isClient: boolean; competitor: string | null }[];
}

export interface Answer {
  id: string;
  engineKey: string;
  engineLabel: string;
  sampleNo: number;
  status: 'pending' | 'ok' | 'failed';
  text: string | null;
  error: string | null;
  mentions: { name: string; isClient: boolean; position: number }[];
  citations: { url: string; domain: string; isClient: boolean }[];
}

// Audits ---------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface SiteCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface Fix {
  key: string;
  title: string;
  why: string;
  effort: 'quick' | 'some' | 'project';
}

export interface AuditReport {
  id: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
  business: string;
  domain: string;
  category: string | null;
  location: string | null;
  demo: boolean;
  run: { status: string; samples: number; promptCount: number; engines: string[]; totalCalls: number; done: number; failed: number };
  site: { status: 'pending' | 'done' | 'failed'; passed: number; findings: { pagesChecked: number; finalUrl: string | null; checks: SiteCheck[] } | null };
  competitors: string[];
  visibility: Visibility | null;
  missing: { id: string; text: string; competitors: string[] }[];
  gaps: { domain: string; answers: number }[];
  fixes: Fix[];
  // In-app only:
  shareToken?: string;
  clientId?: string;
  clientStatus?: string;
  source?: 'manual' | 'widget';
}

export interface AuditListItem {
  id: string;
  status: 'running' | 'completed' | 'failed';
  source: 'manual' | 'widget';
  createdAt: string;
  clientId: string;
  clientStatus: string;
  business: string;
  domain: string;
  answers: number;
  mentioned: number;
  progress: { done: number; total: number; site: string };
  leadEmail: string | null;
}

export interface Lead {
  id: string;
  name: string | null;
  email: string;
  business: string;
  domain: string;
  category: string;
  location: string | null;
  status: 'received' | 'audit_started' | 'not_run';
  note: string | null;
  createdAt: string;
  auditId: string | null;
  auditStatus: 'running' | 'completed' | 'failed' | null;
  clientStatus: string | null;
}

export interface AuditEstimate {
  engines: string[];
  creditsPerPrompt: number;
  samples: number;
  quota: { used: number; max: number };
  creditsRemaining: number;
  engineMode: 'live' | 'mock';
  limits: { prompts: number; competitors: number };
}

export const ENGINE_LABEL: Record<string, string> = { chatgpt: 'ChatGPT', perplexity: 'Perplexity', gemini: 'Gemini' };

// Platform API keys screen ------------------------------------------------------

export interface PlatformSetting {
  key: string;
  label: string;
  secret: boolean;
  help: string;
  placeholder: string | null;
  choices: { value: string; label: string }[] | null;
  /** Where the value in use comes from. */
  source: 'saved' | 'environment' | 'none';
  /** A secret is saved but cannot be decrypted with the server's current key. */
  unreadable: boolean;
  /** The last four characters of a secret, or a non-secret value in full. */
  shown: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlatformSettingGroup {
  key: 'chatgpt' | 'perplexity' | 'gemini' | 'writer' | 'email';
  label: string;
  description: string;
  items: PlatformSetting[];
}

export interface PlatformSettings {
  encryptionReady: boolean;
  engineMode: 'live' | 'mock';
  groups: PlatformSettingGroup[];
}

export interface SettingTestResult {
  ok: boolean;
  message: string;
  sample?: string;
  latencyMs?: number;
}

// Diagnosis ------------------------------------------------------------------------

export type SourceType = 'own' | 'competitor' | 'list_review' | 'forum' | 'directory' | 'news' | 'other';
export type PageCheck = 'not_listed' | 'listed' | 'unchecked' | 'failed';

export interface DiagnosisSource {
  url: string;
  domain: string;
  type: SourceType | 'robots';
  typeLabel: string;
  answers: number;
  title: string | null;
  check: PageCheck | null;
  elsewhere: boolean;
}

export interface DiagnosisPrompt {
  id: string;
  text: string;
  intent: string;
  priority: boolean;
  status: 'won' | 'lost' | 'open' | 'no_answers';
  answers: number;
  clientAnswers: number;
  leader: { name: string; answers: number } | null;
  engines: { key: string; label: string; answers: number; client: number; lost: boolean }[];
  cause: { kind: string; sentence: string; sources: DiagnosisSource[]; note: string | null } | null;
}

export interface Diagnosis {
  runId: string;
  status: 'pending' | 'done';
  pagesChecked: number;
  totals: { questions: number; lost: number; won: number; open: number; gaps: number; domains: number; answers: number; uncitedAnswers: number };
  prompts: DiagnosisPrompt[];
  gaps: {
    domain: string;
    type: SourceType;
    typeLabel: string;
    answers: number;
    questions: number;
    competitors: string[];
    urls: { url: string; title: string | null; check: PageCheck }[];
    pages: { checked: number; listsClient: number; failed: number };
  }[];
  sources: {
    byType: { type: SourceType; label: string; domains: number; answers: number }[];
    domains: { domain: string; type: SourceType; typeLabel: string; corrected: boolean; competitor: string | null; answers: number; withClient: number; competitorOnly: number; topUrl: string }[];
  };
  site: {
    id: string;
    status: 'pending' | 'done' | 'failed';
    mode: 'live' | 'mock';
    checkedAt: string;
    error: string | null;
    findings: AuditReport['site']['findings'];
    passed: number;
  } | null;
}

export interface DiagnosisView {
  run: Run | null;
  diagnosis: Diagnosis | null;
  sourceTypes: { type: SourceType; label: string }[];
}

// Action queue -----------------------------------------------------------------------

export type ActionStatus = 'suggested' | 'approved' | 'in_progress' | 'done' | 'dismissed';
export type AssetKind = 'brief' | 'draft' | 'faq_schema' | 'llms_txt' | 'robots_patch' | 'outreach_email' | 'listing' | 'review_request';

export interface ActionAssetSummary {
  id: string;
  kind: AssetKind;
  label: string;
  version: number;
  status: 'pending' | 'done' | 'failed';
  origin: 'generated' | 'edited';
  mode: 'live' | 'mock';
  error: string | null;
  createdAt: string;
}

export interface ComparisonSide {
  answers: number;
  named: number;
  runs: number;
  rate: number | null;
}

export interface Comparison {
  label: 'improved' | 'no_change' | 'declined' | 'too_early';
  sentence: string;
  windowDays: number;
  complete: boolean;
  before: ComparisonSide;
  after: ComparisonSide;
  byEngine: { key: string; label: string; before: ComparisonSide; after: ComparisonSide }[];
  visits: { path: string; before: number; after: number } | null;
  questions: number;
}

export interface Action {
  comparison: Comparison | null;
  id: string;
  type: string;
  typeLabel: string;
  title: string;
  rationale: string;
  impact: number;
  effort: 'S' | 'M' | 'L';
  status: ActionStatus;
  dismissReason: 'member' | 'resolved' | null;
  owner: { id: string; name: string } | null;
  approvedBy: string | null;
  approvedAt: string | null;
  dismissedAt: string | null;
  doneAt: string | null;
  doneUrl: string | null;
  doneNote: string | null;
  createdAt: string;
  updatedAt: string;
  details: { domain: string | null; pages: { url: string; title: string | null; check: string | null }[]; competitors: string[]; url: string | null };
  prompts: { id: string; text: string; priority: boolean }[];
  generators: { kind: AssetKind; label: string; credits: number }[];
  assets: ActionAssetSummary[];
}

export interface ActionQueue {
  actions: Action[];
  team: { id: string; name: string }[];
  credits: number;
  writer: { mode: 'live' | 'mock'; ready: boolean; problem: string | null; label: string };
  hasRun: boolean;
}

export interface AssetView {
  kind: AssetKind;
  label: string;
  versions: { id: string; version: number; status: string; origin: 'generated' | 'edited'; mode: 'live' | 'mock'; model: string | null; credits: number; error: string | null; createdAt: string; createdBy: string | null }[];
  current: { id: string; version: number; status: string; content: string | null };
}

// AI visits ------------------------------------------------------------------------

export interface VisitsView {
  days: 7 | 30 | 90;
  snippet: { tag: string; convert: string; seenAt: string | null; testUrl: string | null; domain: string | null } | null;
  totals: { visits: number; conversions: number; sessions: number };
  byEngine: { key: string; label: string; visits: number; conversions: number }[];
  byDay: { day: string; visits: number }[];
  pages: { path: string; visits: number; conversions: number }[];
  recent: { id: string; occurredAt: string; engine: string; engineLabel: string; via: 'referrer' | 'utm'; path: string; converted: boolean; conversionName: string | null; isTest: boolean }[];
}

// Monthly reports --------------------------------------------------------------------

export interface ReportRate {
  answers: number;
  named: number;
  rate: number | null;
}

export interface MonthlyReportData {
  client: { name: string; domain: string | null };
  period: { start: string; end: string; label: string };
  previous: { start: string; end: string; label: string };
  runs: number;
  questions: number;
  overall: ReportRate;
  overallBefore: ReportRate | null;
  engines: { key: string; label: string; now: ReportRate; before: ReportRate | null }[];
  shareOfVoice: { name: string; isClient: boolean; answers: number; share: number | null }[];
  trend: { date: string; answers: number; named: number; rate: number | null }[];
  actionsDone: { title: string; type: string; doneAt: string; url: string | null; note: string | null; change: Comparison['label'] | null; changeSentence: string | null }[];
  visits: { installed: boolean; total: number; conversions: number; totalBefore: number; byEngine: { label: string; visits: number; conversions: number }[]; pages: { path: string; visits: number }[] };
  plan: { title: string; type: string; status: string }[];
  method: { engines: string[]; samplesPerQuestion: number | null; engineMode: 'live' | 'mock' | 'mixed' | null };
  demo: boolean;
}

export interface MonthlyReport {
  id: string;
  clientId: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'sent';
  data: MonthlyReportData;
  dataAt: string;
  summaryText: string | null;
  summaryState: 'none' | 'pending' | 'done' | 'failed';
  summaryError: string | null;
  summaryMode: 'live' | 'mock' | null;
  planText: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sendState: 'none' | 'pending' | 'done' | 'failed' | null;
  sendError: string | null;
  recipients: string[];
  sentAt: string | null;
  hasPdf: boolean;
  liveUrl: string | null;
  createdAt: string;
}

export type MonthlyReportListItem = Omit<MonthlyReport, 'data'> & { headline: { named: number; answers: number; runs: number } };

// Plans, usage and costs ------------------------------------------------------

export interface Usage {
  plan: string;
  allowance: number;
  granted: number;
  available: number;
  used: number;
  remaining: number;
  spendable: number;
  percentUsed: number;
  topup: { enabled: boolean; limit: number; inUse: number };
  byKind: { kind: 'scheduled_runs' | 'manual_runs' | 'audits' | 'assets' | 'summaries'; credits: number }[];
  byClient: { name: string; credits: number }[];
  daily: { day: string; credits: number }[];
  forecast: { credits: number; scheduledAhead: number; otherAhead: number; daysLeft: number; overBy: number };
}

export interface PlanDetail {
  key: string;
  name: string;
  monthlyCredits: number;
  clientLimit: number;
  promptsPerClient: number;
  samplesPerPrompt: number;
  auditsPerMonth: number;
  price: { amount: number; currency: 'INR' | 'USD' } | null;
  active: boolean;
  agencies: number;
}

export interface CostReport {
  month: string;
  fx: { usdInr: number | null };
  agencies: {
    id: string;
    name: string;
    slug: string;
    status: string;
    plan: string;
    allowance: number;
    granted: number;
    used: number;
    overage: number;
    topupEnabled: boolean;
    engineCalls: number;
    costUsd: number;
    unpriced: number;
    costPerCredit: number | null;
    price: { amount: number; currency: string } | null;
    revenueUsd: number | null;
    marginUsd: number | null;
    marginPct: number | null;
  }[];
  platformCostUsd: number;
  platformUnpriced: number;
  totals: { costUsd: number; revenueUsd: number | null; used: number; unpriced: number };
  providers: { provider: string; costUsd: number; events: number; unpriced: number; invoiceUsd: number | null; note: string | null; difference: number | null; matches: boolean | null }[];
  models: { provider: string; model: string; events: number; requests: number; tokensIn: number; tokensOut: number; costUsd: number; unpriced: boolean; providerReported: boolean }[];
  prices: { provider: string; model: string; inputPerMTok: number; outputPerMTok: number; perRequest: number; updatedAt: string }[];
}

// Dashboard --------------------------------------------------------------------

export type Health = 'healthy' | 'watch' | 'attention';

export interface Overview {
  kpis: {
    visibility: { rate: number | null; answers: number; mentioned: number; previous: number | null; clientsMeasured: number };
    visits: { last28: number; previous28: number };
    questions: { active: number; clients: number };
    attention: { clients: number; openActions: number };
  };
  trend: { engines: { key: string; label: string }[]; weeks: { week: string; engines: Record<string, { answers: number; mentioned: number }> }[] };
  health: Record<Health, number>;
  clients: {
    id: string;
    name: string;
    domain: string | null;
    questions: number;
    lastRunAt: string | null;
    answers: number;
    mentioned: number;
    visibility: number | null;
    change: number | null;
    shareOfVoice: number | null;
    visits: number;
    visitsBefore: number;
    openActions: number;
    health: Health;
    reason: string;
  }[];
  activity: {
    kind: 'run' | 'run_failed' | 'action_done' | 'report_sent' | 'audit';
    at: string;
    clientId: string;
    client: string;
    title: string | null;
    ref: string;
    answers: number;
    mentioned: number;
  }[];
}
