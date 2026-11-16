export type Role = 'super_admin' | 'agency_owner' | 'agency_member' | 'client_viewer';

export interface Branding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  senderName?: string;
}

export type Tenant =
  | { kind: 'platform'; name: string }
  | { kind: 'agency'; name: string; branding: Branding; suspended: boolean };

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
  client: { id: string; name: string; domain: string | null; brandAliases: string[]; status: string; schedule: 'off' | 'weekly'; nextRunAt: string | null };
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
