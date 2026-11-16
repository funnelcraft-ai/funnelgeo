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
