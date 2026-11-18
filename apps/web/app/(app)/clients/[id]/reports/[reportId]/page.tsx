import { notFound } from 'next/navigation';
import { ReportEditor } from '@/components/reports/ReportEditor';
import { getSession, getTenant } from '@/lib/server';

export default async function ReportPage({ params }: { params: Promise<{ id: string; reportId: string }> }) {
  const [session, tenant] = await Promise.all([getSession(), getTenant()]);
  if (!session || tenant?.kind !== 'agency') return null; // the layout redirects
  // Client viewers read sent reports on the live link; the editor is for the agency.
  if (session.user.role === 'client_viewer') notFound();
  const { id, reportId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(reportId)) notFound();
  return <ReportEditor reportId={reportId} clientId={id} agencyName={tenant.name} logoUrl={tenant.branding.logoUrl ?? null} />;
}
