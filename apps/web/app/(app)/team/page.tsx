import { redirect } from 'next/navigation';
import { TeamPanel } from '@/components/TeamPanel';
import { apiGet, getSession } from '@/lib/server';
import type { Client, TeamInvite, TeamUser } from '@/lib/types';

export default async function TeamPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role === 'client_viewer') redirect('/clients');
  const [team, clients] = await Promise.all([
    apiGet<{ users: TeamUser[]; invites: TeamInvite[] }>('/v1/team'),
    apiGet<{ clients: Client[] }>('/v1/clients'),
  ]);
  return (
    <TeamPanel
      users={team?.users ?? []}
      invites={team?.invites ?? []}
      clients={clients?.clients ?? []}
      isOwner={session.user.role === 'agency_owner'}
      selfId={session.user.id}
    />
  );
}
