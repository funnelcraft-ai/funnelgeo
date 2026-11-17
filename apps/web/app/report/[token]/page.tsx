import type { Metadata } from 'next';
import { PrintButton } from '@/components/audits/AuditActions';
import { ReportView } from '@/components/audits/ReportView';
import { Brand } from '@/components/Brand';
import { apiGet, getTenant } from '@/lib/server';
import type { AuditReport } from '@/lib/types';

type Shared = { report: AuditReport; agency: { name: string; ctaLabel: string | null; ctaUrl: string | null } };

const loadReport = (token: string) => apiGet<Shared>(`/v1/reports/${encodeURIComponent(token)}`);

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const data = await loadReport((await params).token);
  return {
    title: data ? `AI visibility report: ${data.report.business}` : 'Report not available',
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/** The read-only report a prospect receives. Public, on the agency's own address, in the agency's brand only. */
export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant || tenant.kind !== 'agency') return null;
  const { token } = await params;
  const data = await loadReport(token);

  if (!data) {
    return (
      <main className="center">
        <div className="auth-card">
          <Brand tenant={tenant} />
          <h1>This report is not available</h1>
          <p className="muted">The link may have been replaced. Ask {tenant.name} for a new one.</p>
        </div>
      </main>
    );
  }

  const { report, agency } = data;
  return (
    <div className="shell report-shell">
      <div className="report-toolbar no-print">
        <PrintButton />
      </div>
      <ReportView
        initial={report}
        pollUrl={`/v1/reports/${encodeURIComponent(token)}`}
        brand={<Brand tenant={tenant} />}
        isPublic
        cta={agency.ctaLabel && agency.ctaUrl ? { label: agency.ctaLabel, url: agency.ctaUrl } : null}
        agencyName={agency.name}
      />
    </div>
  );
}
