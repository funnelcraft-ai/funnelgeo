import { notFound, redirect } from 'next/navigation';
import { AdminShell } from '@/components/AdminShell';
import { ApiKeysPanel } from '@/components/ApiKeysPanel';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { PlatformSettings } from '@/lib/types';

export const metadata = { title: 'API keys' };

export default async function ApiKeysPage() {
  const tenant = await getTenant();
  if (tenant?.kind !== 'platform') notFound();
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'super_admin') notFound();

  const settings = await apiGet<PlatformSettings>('/v1/admin/settings');
  if (!settings) notFound();

  return (
    <AdminShell tenant={tenant} session={session}>
      <ApiKeysPanel initial={settings} />
    </AdminShell>
  );
}
