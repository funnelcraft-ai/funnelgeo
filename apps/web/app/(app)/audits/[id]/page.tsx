import { notFound, redirect } from 'next/navigation';
import { AuditActions } from '@/components/audits/AuditActions';
import { ReportView } from '@/components/audits/ReportView';
import { Brand } from '@/components/Brand';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { AuditReport } from '@/lib/types';

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const [session, tenant] = await Promise.all([getSession(), getTenant()]);
  if (!session || !tenant) return null;
  if (session.user.role === 'client_viewer') redirect('/clients');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await apiGet<{ report: AuditReport; shareUrl: string; lead: { name: string | null; email: string; createdAt: string } | null }>(`/v1/audits/${id}`);
  if (!data) notFound();
  const { report } = data;

  return (
    <>
      <p className="crumbs no-print">
        <a href="/audits">Audits</a> / {report.business}
      </p>
      <AuditActions
        auditId={report.id}
        shareUrl={data.shareUrl}
        clientId={report.clientId!}
        clientStatus={report.clientStatus!}
        running={report.status === 'running'}
        lead={data.lead}
      />
      <ReportView initial={report} pollUrl={`/v1/audits/${report.id}`} brand={<Brand tenant={tenant} />} isPublic={false} agencyName={tenant.name} />
    </>
  );
}
