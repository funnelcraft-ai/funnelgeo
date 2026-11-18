import type { Metadata } from 'next';
import { PrintButton } from '@/components/audits/AuditActions';
import { Brand } from '@/components/Brand';
import { ClientReport, PlanText, SummaryText } from '@/components/reports/ClientReport';
import { apiGet, getTenant } from '@/lib/server';
import type { MonthlyReportData } from '@/lib/types';

type Shared = {
  report: { periodStart: string; periodEnd: string; data: MonthlyReportData; summaryText: string; planText: string | null; approvedAt: string };
  agency: { name: string };
};

const loadReport = (token: string) => apiGet<Shared>(`/v1/client-reports/${encodeURIComponent(token)}`);

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const data = await loadReport((await params).token);
  return {
    title: data ? `${data.report.data.client.name}: AI visibility, ${data.report.data.period.label}` : 'Report not available',
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/**
 * The monthly report's live link: public, on the agency's own address, in
 * the agency's brand only, and only once an agency user has approved it.
 * The PDF is printed from this page, so the two always match.
 */
export default async function LiveReportPage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant || tenant.kind !== 'agency') return null;
  const data = await loadReport((await params).token);
  if (!data) {
    return (
      <main className="center">
        <div className="auth-card">
          <Brand tenant={tenant} />
          <h1>This report is not available</h1>
          <p className="muted">The link may be out of date. Ask {tenant.name} for the latest one.</p>
        </div>
      </main>
    );
  }
  const { report, agency } = data;
  return (
    <div className="shell report-shell" data-report-ready="">
      <div className="report-toolbar no-print">
        <PrintButton />
      </div>
      <ClientReport
        data={report.data}
        agencyName={agency.name}
        logoUrl={tenant.branding.logoUrl ?? null}
        summary={<SummaryText text={report.summaryText} />}
        plan={<PlanText text={report.planText ?? ''} />}
      />
    </div>
  );
}
