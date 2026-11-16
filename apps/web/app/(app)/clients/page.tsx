import { OverviewPanel } from '@/components/OverviewPanel';
import { apiGet, getSession } from '@/lib/server';
import type { Agency, Client, TeamInvite, TeamUser } from '@/lib/types';

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) return null; // the layout redirects
  const { role, name } = session.user;
  const isStaff = role !== 'client_viewer';
  const [clients, agency, team, credits] = await Promise.all([
    apiGet<{ clients: Client[] }>('/v1/clients'),
    isStaff ? apiGet<{ agency: Agency }>('/v1/agency') : null,
    isStaff ? apiGet<{ users: TeamUser[]; invites: TeamInvite[] }>('/v1/team') : null,
    isStaff ? apiGet<{ allowance: number; remaining: number }>('/v1/credits') : null,
  ]);
  return (
    <OverviewPanel
      firstName={name.split(/\s+/)[0] ?? name}
      initial={clients?.clients ?? []}
      canEdit={isStaff}
      isOwner={role === 'agency_owner'}
      agency={agency?.agency ?? null}
      teamCount={team?.users.filter((u) => u.role !== 'client_viewer').length ?? 0}
      viewerCount={team?.users.filter((u) => u.role === 'client_viewer').length ?? 0}
      pendingInvites={team?.invites.length ?? 0}
      credits={credits}
    />
  );
}
