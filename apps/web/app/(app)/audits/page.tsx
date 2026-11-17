import { redirect } from 'next/navigation';
import { AuditsPanel } from '@/components/audits/AuditsPanel';
import { apiGet, getSession } from '@/lib/server';
import type { AuditListItem, Lead } from '@/lib/types';

export default async function AuditsPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role === 'client_viewer') redirect('/clients');
  const [audits, leads] = await Promise.all([
    apiGet<{ audits: AuditListItem[]; quota: { used: number; max: number }; widgetEnabled: boolean }>('/v1/audits'),
    apiGet<{ leads: Lead[] }>('/v1/leads'),
  ]);
  return (
    <AuditsPanel
      audits={audits?.audits ?? []}
      quota={audits?.quota ?? { used: 0, max: 0 }}
      widgetEnabled={audits?.widgetEnabled ?? false}
      leads={leads?.leads ?? []}
      isOwner={session.user.role === 'agency_owner'}
    />
  );
}
