import { redirect } from 'next/navigation';
import { UsagePanel } from '@/components/UsagePanel';
import { apiGet, getSession } from '@/lib/server';
import type { Usage } from '@/lib/types';

export const metadata = { title: 'Usage' };

export default async function UsagePage() {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role === 'client_viewer') redirect('/clients');
  const usage = await apiGet<Usage>('/v1/usage');
  if (!usage) redirect('/clients');
  const month = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return <UsagePanel usage={usage} isOwner={session.user.role === 'agency_owner'} month={month} />;
}
