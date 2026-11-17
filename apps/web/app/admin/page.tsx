import { notFound, redirect } from 'next/navigation';
import { AdminPanel } from '@/components/AdminPanel';
import { AdminShell } from '@/components/AdminShell';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { AdminAgency, Plan } from '@/lib/types';

export default async function AdminPage() {
  const tenant = await getTenant();
  // Platform administration exists only on the platform's own address.
  if (tenant?.kind !== 'platform') notFound();
  const session = await getSession();
  if (!session) redirect('/login');

  const [agencies, plans] = await Promise.all([
    apiGet<{ agencies: AdminAgency[] }>('/v1/admin/agencies'),
    apiGet<{ plans: Plan[] }>('/v1/admin/plans'),
  ]);

  return (
    <AdminShell tenant={tenant} session={session}>
      <AdminPanel agencies={agencies?.agencies ?? []} plans={plans?.plans ?? []} />
    </AdminShell>
  );
}
