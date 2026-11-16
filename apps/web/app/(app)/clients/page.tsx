import { ClientsPanel } from '@/components/ClientsPanel';
import { apiGet, getSession } from '@/lib/server';
import type { Agency, Client } from '@/lib/types';

export default async function ClientsPage() {
  const session = await getSession();
  if (!session) return null; // the layout redirects
  const isStaff = session.user.role !== 'client_viewer';
  const [clients, agency] = await Promise.all([
    apiGet<{ clients: Client[] }>('/v1/clients'),
    isStaff ? apiGet<{ agency: Agency }>('/v1/agency') : null,
  ]);
  return <ClientsPanel initial={clients?.clients ?? []} canEdit={isStaff} clientLimit={agency?.agency.plan.clientLimit ?? null} />;
}
