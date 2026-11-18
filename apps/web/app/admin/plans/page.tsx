import { notFound, redirect } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { PlansPanel } from '@/components/PlansPanel';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { PlanDetail } from '@/lib/types';

export const metadata = { title: 'Plans' };

export default async function PlansPage() {
  const tenant = await getTenant();
  if (tenant?.kind !== 'platform') notFound();
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'super_admin') notFound();
  const data = await apiGet<{ plans: PlanDetail[] }>('/v1/admin/plans/all');
  return (
    <AdminShell tenant={tenant} session={session}>
      <PlansPanel plans={data?.plans ?? []} />
    </AdminShell>
  );
}
