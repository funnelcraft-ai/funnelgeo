import { redirect } from 'next/navigation';
import { NewAudit } from '@/components/audits/NewAudit';
import { apiGet, getSession } from '@/lib/server';
import type { AuditEstimate } from '@/lib/types';

export default async function NewAuditPage() {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role === 'client_viewer') redirect('/clients');
  const estimate = await apiGet<AuditEstimate>('/v1/audits/estimate');
  if (!estimate) redirect('/audits');
  return <NewAudit estimate={estimate} />;
}
