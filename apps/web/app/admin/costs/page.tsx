import { notFound, redirect } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { CostsPanel } from '@/components/CostsPanel';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { CostReport } from '@/lib/types';

export const metadata = { title: 'Costs' };

/** This month and the eleven before it. */
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const tenant = await getTenant();
  if (tenant?.kind !== 'platform') notFound();
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'super_admin') notFound();
  const months = recentMonths();
  const { month: asked } = await searchParams;
  const month = asked && months.includes(asked) ? asked : months[0]!;
  const report = await apiGet<CostReport>(`/v1/admin/costs?month=${month}`);
  if (!report) notFound();
  return (
    <AdminShell tenant={tenant} session={session}>
      <CostsPanel key={month} report={report} months={months} />
    </AdminShell>
  );
}
