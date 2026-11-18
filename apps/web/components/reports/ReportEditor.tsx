'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { load, send } from '@/lib/client';
import type { MonthlyReport } from '@/lib/types';
import { Icon } from '../Icon';
import { ClientReport, PlanText, SummaryText } from './ClientReport';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function ReportEditor({ reportId, clientId, agencyName, logoUrl }: { reportId: string; clientId: string; agencyName: string; logoUrl: string | null }) {
  const [view, setView] = useState<{ report: MonthlyReport; clientName: string; suggestedRecipients: string[] } | null>(null);
  const [summary, setSummary] = useState('');
  const [plan, setPlan] = useState('');
  const [state, setState] = useState<{ busy?: string; error?: string; note?: string }>({});
  const [sending, setSending] = useState(false);
  const [recipients, setRecipients] = useState('');

  const reload = useCallback(
    async (resetText = false) => {
      const next = await load<{ report: MonthlyReport; clientName: string; suggestedRecipients: string[] }>(`/v1/monthly-reports/${reportId}`);
      setView((prev) => {
        // Keep what's being typed unless asked to reset, or the AI has just written the summary.
        if (resetText || !prev || (prev.report.summaryState === 'pending' && next.report.summaryState !== 'pending')) {
          setSummary(next.report.summaryText ?? '');
          setPlan(next.report.planText ?? '');
        }
        return next;
      });
      return next;
    },
    [reportId],
  );
  useEffect(() => {
    reload(true).catch((err) => setState({ error: (err as Error).message }));
  }, [reload]);

  const r = view?.report;
  const following = r?.summaryState === 'pending' || r?.sendState === 'pending';
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => reload().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [following, reload]);

  if (!view || !r) return state.error ? <p className="error" role="alert">{state.error}</p> : <p className="muted" aria-busy="true">Opening the report…</p>;
  const draft = r.status === 'draft';
  const dirty = draft && (summary !== (r.summaryText ?? '') || plan !== (r.planText ?? ''));

  async function act(label: string, fn: () => Promise<unknown>, note?: string) {
    setState({ busy: label });
    try {
      await fn();
      await reload(label !== 'save');
      setState({ note });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }
  const save = () => act('save', () => send('PATCH', `/v1/monthly-reports/${reportId}`, { summaryText: summary, planText: plan }), 'Saved.');
  const approve = () =>
    act('approve', async () => {
      if (dirty) await send('PATCH', `/v1/monthly-reports/${reportId}`, { summaryText: summary, planText: plan });
      await send('PATCH', `/v1/monthly-reports/${reportId}`, { status: 'approved' });
    }, 'Approved. The figures are now fixed, and the live link works.');
  const openSend = () => {
    setRecipients((r.recipients.length ? r.recipients : view.suggestedRecipients).join('\n'));
    setSending(true);
  };
  const doSend = () =>
    act('send', async () => {
      const list = recipients.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
      await send('POST', `/v1/monthly-reports/${reportId}/send`, { recipients: list });
      setSending(false);
    });

  const statusPill = { draft: ['Draft', 'warn'], approved: ['Approved', ''], sent: ['Sent', 'ok'] }[r.status];

  return (
    <div className="report-editor">
      <p className="crumbs">
        <Link href="/clients">Clients</Link> / <Link href={`/clients/${clientId}`}>{view.clientName}</Link> / Reports
      </p>
      <div className="editor-bar">
        <div>
          <h1>{r.data.period.label}</h1>
          <p className="muted small">
            <span className={`pill ${statusPill[1]}`}>{statusPill[0]}</span>{' '}
            {r.status === 'sent' && r.sentAt
              ? `Sent ${when(r.sentAt)} to ${r.recipients.join(', ')}`
              : r.approvedAt
                ? `Approved by ${r.approvedBy ?? 'someone'} ${when(r.approvedAt)}`
                : `Figures as of ${when(r.dataAt)}`}
          </p>
        </div>
        <div className="editor-buttons">
          {draft && (
            <>
              <button className="secondary sm" onClick={() => act('refresh', () => send('POST', `/v1/monthly-reports/${reportId}/refresh`), 'Figures updated.')} disabled={!!state.busy}>
                <Icon name="refresh" />Update figures
              </button>
              <button className="sm" onClick={approve} disabled={!!state.busy || r.summaryState === 'pending'}>
                <Icon name="check" />Approve
              </button>
            </>
          )}
          {r.status === 'approved' && (
            <button className="secondary sm" onClick={() => act('reopen', () => send('PATCH', `/v1/monthly-reports/${reportId}`, { status: 'draft' }))} disabled={!!state.busy || r.sendState === 'pending'}>
              Reopen as draft
            </button>
          )}
          {r.liveUrl && (
            <a className="button secondary sm" href={r.liveUrl} target="_blank" rel="noopener noreferrer"><Icon name="link" />Live link</a>
          )}
          {r.hasPdf && <a className="button secondary sm" href={`/api/v1/monthly-reports/${reportId}/pdf`}><Icon name="download" />PDF</a>}
          {r.status !== 'draft' && (
            <button className="sm" onClick={openSend} disabled={!!state.busy || r.sendState === 'pending'}>
              {r.sendState === 'pending' ? 'Sending…' : r.status === 'sent' ? 'Send again' : 'Send to client'}
            </button>
          )}
        </div>
      </div>

      {r.sendState === 'failed' && <p className="notice warn" role="alert"><strong>Not sent.</strong> {r.sendError}</p>}
      {r.status === 'sent' && r.sendError && <p className="notice warn">{r.sendError}</p>}
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.note && <p className="success" role="status">{state.note}</p>}

      {sending && (
        <section className="card send-panel" aria-labelledby="send-head">
          <h2 id="send-head">Send {r.data.period.label} to {view.clientName}</h2>
          <div className="field">
            <label htmlFor="recipients">Recipients, one per line (up to 10)</label>
            <textarea id="recipients" rows={4} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="name@client.com" />
            <p className="hint">They get an email from {agencyName} with the PDF attached and a link to the live report. Your platform is never named.</p>
          </div>
          <div className="row">
            <button onClick={doSend} disabled={!!state.busy || !recipients.trim()}>Send now</button>
            <button className="link quiet" onClick={() => setSending(false)}>Cancel</button>
          </div>
        </section>
      )}

      {draft && (
        <section className="card editor-fields">
          <div className="field">
            <div className="label-row">
              <label htmlFor="summary">Summary</label>
              <button
                className="link quiet small-link"
                onClick={() => act('summary', () => send('POST', `/v1/monthly-reports/${reportId}/summary`))}
                disabled={!!state.busy || r.summaryState === 'pending'}
                title="Uses 1 credit"
              >
                <Icon name="refresh" />{r.summaryText ? 'Rewrite with AI' : 'Write with AI'} · 1 credit
              </button>
            </div>
            {r.summaryState === 'pending' ? (
              <p className="muted" aria-busy="true"><span className="spinner" aria-hidden="true" /> Writing the summary from this month’s figures…</p>
            ) : (
              <textarea id="summary" rows={7} maxLength={6000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Two or three short paragraphs: how visibility moved, what you did, what comes next." />
            )}
            {r.summaryState === 'failed' && <p className="error">The AI summary couldn’t be written ({r.summaryError}). No credit was used. Write it here, or try again.</p>}
            {r.summaryMode === 'mock' && r.summaryState === 'done' && <p className="hint">Demo text, written without a model in mock mode.</p>}
            <p className="hint">Check every number against the figures below before approving. The AI is told not to claim an action caused a change.</p>
          </div>
          <div className="field">
            <label htmlFor="plan">Next month</label>
            <textarea id="plan" rows={5} maxLength={6000} value={plan} onChange={(e) => setPlan(e.target.value)} />
            <p className="hint">Lines starting with “- ” become a list. Prefilled from the action queue.</p>
          </div>
          <div className="row">
            <button className="secondary" onClick={save} disabled={!dirty || !!state.busy}>Save</button>
            {dirty && <span className="muted small">Unsaved changes</span>}
          </div>
        </section>
      )}

      <div className="report-preview">
        <p className="preview-label no-print">{draft ? 'Preview: what the client will see' : 'What the client sees'}</p>
        <ClientReport
          data={r.data}
          agencyName={agencyName}
          logoUrl={logoUrl}
          summary={summary.trim() ? <SummaryText text={summary} /> : <p className="muted">The summary goes here.</p>}
          plan={<PlanText text={plan} />}
        />
      </div>
    </div>
  );
}
