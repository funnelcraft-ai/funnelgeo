'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { AuditListItem, Lead } from '@/lib/types';
import { Icon } from '../Icon';
import { PageHead } from '../Shell';

interface Props {
  audits: AuditListItem[];
  quota: { used: number; max: number };
  widgetEnabled: boolean;
  leads: Lead[];
  isOwner: boolean;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Result({ audit }: { audit: AuditListItem }) {
  if (audit.status === 'running') {
    return (
      <span className="muted">
        Running · {audit.progress.done} of {audit.progress.total} answers
      </span>
    );
  }
  if (audit.status === 'failed') return <span className="pill bad">Failed</span>;
  return (
    <span>
      Named in <strong>{audit.mentioned}</strong> of {audit.answers} answers
    </span>
  );
}

function LeadStatus({ lead }: { lead: Lead }) {
  if (lead.status === 'not_run') return <span className="muted small">{lead.note ?? 'Not run'}</span>;
  if (lead.status === 'received' || lead.auditStatus === 'running') return <span className="pill warn">Preparing report</span>;
  if (lead.auditStatus === 'completed') return <span className="pill ok">Report sent</span>;
  if (lead.auditStatus === 'failed') return <span className="pill bad">Audit failed</span>;
  return <span className="muted small">Audit deleted</span>;
}

export function AuditsPanel({ audits, quota, widgetEnabled, leads, isOwner }: Props) {
  const router = useRouter();
  const busy = audits.some((a) => a.status === 'running') || leads.some((l) => l.status === 'received');

  // Keep progress and new website leads current without a manual reload.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [busy, router]);

  const left = Math.max(quota.max - quota.used, 0);
  return (
    <>
      <PageHead
        crumbs="Overview / Audits"
        title="Prospect audits"
        sub={`Show a prospect where they stand in AI answers, share a branded report, then win the work. ${quota.used} of ${quota.max} audits used this month.`}
      >
        <a className={`button${left === 0 ? ' disabled' : ''}`} href={left === 0 ? undefined : '/audits/new'} aria-disabled={left === 0}>
          <Icon name="plus" />
          New audit
        </a>
      </PageHead>

      {left === 0 && <p className="notice warn">All of this month’s audits have been used. New ones become available on the 1st.</p>}

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Audits</h2>
            <p className="muted small">Prospects stay here until you convert them to clients.</p>
          </div>
        </div>
        {audits.length === 0 ? (
          <p className="empty">
            <strong>No audits yet</strong>
            Run one for a prospect you are about to pitch. It takes a few minutes.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Result</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((audit) => (
                <tr key={audit.id}>
                  <td>
                    <strong><a className="row-link" href={`/audits/${audit.id}`}>{audit.business}</a></strong>
                    <div className="muted small">
                      {audit.domain}
                      {audit.source === 'widget' && ' · from your website'}
                    </div>
                  </td>
                  <td><Result audit={audit} /></td>
                  <td>
                    {audit.clientStatus === 'prospect' ? <span className="pill">Prospect</span> : <span className="pill ok">Client</span>}
                  </td>
                  <td className="muted">{shortDate(audit.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Leads from your website</h2>
            <p className="muted small">
              {widgetEnabled
                ? 'People who asked for a report through the form on your website. Each one gets an audit and an email with the report.'
                : 'Add a free AI visibility report form to your website to collect leads. '}
              {!widgetEnabled && isOwner && <a href="/settings#widget">Set it up in Settings</a>}
            </p>
          </div>
        </div>
        {leads.length === 0 ? (
          <p className="empty">{widgetEnabled ? 'No requests yet.' : 'The website form is off.'}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Business</th>
                <th>Report</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <strong>{lead.name ?? lead.email}</strong>
                    {lead.name && <div className="muted small"><a href={`mailto:${lead.email}`}>{lead.email}</a></div>}
                  </td>
                  <td>
                    {lead.auditId ? <a className="row-link" href={`/audits/${lead.auditId}`}>{lead.business}</a> : lead.business}
                    <div className="muted small">{[lead.domain, lead.category, lead.location].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td><LeadStatus lead={lead} /></td>
                  <td className="muted">{shortDate(lead.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
