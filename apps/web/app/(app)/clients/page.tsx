import { Dashboard } from '@/components/dashboard/Dashboard';
import { apiGet, getSession } from '@/lib/server';
import type { Agency, Client, Overview, TeamInvite, TeamUser } from '@/lib/types';

export const metadata = { title: 'Dashboard' };

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) return null; // the layout redirects
  const { role, name } = session.user;
  const isStaff = role !== 'client_viewer';
  const [overview, clients, agency, team] = await Promise.all([
    apiGet<Overview>('/v1/overview'),
    apiGet<{ clients: Client[] }>('/v1/clients'),
    isStaff ? apiGet<{ agency: Agency }>('/v1/agency') : null,
    role === 'agency_owner' ? apiGet<{ users: TeamUser[]; invites: TeamInvite[] }>('/v1/team') : null,
  ]);
  if (!overview) return null;
  return (
    <Dashboard
      firstName={name.split(/\s+/)[0] ?? name}
      overview={overview}
      clients={clients?.clients ?? []}
      canEdit={isStaff}
      isOwner={role === 'agency_owner'}
      agency={agency?.agency ?? null}
      invited={(team?.users.length ?? 0) + (team?.invites.length ?? 0) > 1}
    />
  );
}
