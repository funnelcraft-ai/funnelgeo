import { redirect } from 'next/navigation';
import { SettingsPanel } from '@/components/SettingsPanel';
import { apiGet, getSession } from '@/lib/server';
import type { Agency } from '@/lib/types';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role !== 'agency_owner') redirect('/clients');
  const data = await apiGet<{ agency: Agency }>('/v1/agency');
  if (!data) redirect('/clients');
  return <SettingsPanel initial={data.agency} />;
}
