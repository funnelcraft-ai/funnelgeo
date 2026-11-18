'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { load, send } from '@/lib/client';
import type { MonthlyReportListItem, Tracker } from '@/lib/types';
import { Icon } from '../Icon';
import { formatDate } from './ClientWorkspace';

const monthName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const STATUS = { draft: { label: 'Draft', tone: 'warn' }, approved: { label: 'Approved', tone: '' }, sent: { label: 'Sent', tone: 'ok' } } as const;

export function ReportsTab({ tracker, canEdit }: { tracker: Tracker; canEdit: boolean }) {
  const clientId = tracker.client.id;
  const router = useRouter();
  const [list, setList] = useState<{ reports: MonthlyReportListItem[]; writerReady: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // This month and the eleven before it; last month is the usual choice.
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }, []);
  const [month, setMonth] = useState(months[1]!);

  const reload = useCallback(async () => {
    try {
      setList(await load(`/v1/clients/${clientId}/reports`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [clientId]);
  useEffect(() => void reload(), [reload]);

  async function draft() {
    setBusy(true);
    setError('');
    try {
      const res = await send<{ report: { id: string } }>('POST', `/v1/clients/${clientId}/reports`, { month });
      router.push(`/clients/${clientId}/reports/${res.report.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!list) return error ? <p className="error" role="alert">{error}</p> : <p className="muted" aria-busy="true">Loading reports…</p>;

  return (
    <div className="reports-tab">
      {canEdit && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Monthly reports</h2>
              <p className="muted small">
                Last month’s report is drafted automatically on the 1st, with an AI-written summary to check. Nothing reaches the client until someone on your team approves it.
              </p>
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ maxWidth: 260 }}>
              <label htmlFor="report-month">Month</label>
              <select id="report-month" value={month} onChange={(e) => setMonth(e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>{monthName(`${m}-01`)}{m === months[0] ? ' (so far)' : ''}</option>
                ))}
              </select>
            </div>
            <button onClick={draft} disabled={busy}>
              <Icon name="plus" />
              {list.reports.some((r) => r.periodStart.startsWith(month)) ? 'Open this month’s report' : 'Draft the report'}
            </button>
          </div>
          <p className="hint">{list.writerReady ? 'A new draft gets an AI summary for 1 credit.' : 'Writing isn’t set up, so new drafts start without a summary: you write it.'}</p>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      )}

      <section className="card flush">
        {list.reports.length === 0 ? (
          <p className="empty">
            {canEdit ? (
              <><strong>No reports yet</strong>Draft one above, or wait for the 1st of the month.</>
            ) : (
              'No reports have been sent yet.'
            )}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Status</th>
                  <th>Named in answers</th>
                  <th>{canEdit ? 'Updated' : 'Sent'}</th>
                  <th><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {list.reports.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{monthName(r.periodStart)}</strong></td>
                    <td><span className={`pill ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span></td>
                    <td>{r.headline.answers ? `${Math.round((r.headline.named / r.headline.answers) * 100)}% of ${r.headline.answers}` : <span className="muted">no runs</span>}</td>
                    <td>{formatDate(r.sentAt ?? r.approvedAt ?? r.createdAt)}</td>
                    <td className="row-actions">
                      {canEdit ? (
                        <Link className="button secondary sm" href={`/clients/${clientId}/reports/${r.id}`}>Open</Link>
                      ) : (
                        <>
                          {r.liveUrl && <a className="button secondary sm" href={r.liveUrl} target="_blank" rel="noopener noreferrer">Open</a>}
                          {r.hasPdf && <a className="button secondary sm" href={`/api/v1/monthly-reports/${r.id}/pdf`}><Icon name="download" />PDF</a>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
