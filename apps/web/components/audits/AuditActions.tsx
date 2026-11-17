'use client';

import { useState } from 'react';
import { send } from '@/lib/client';
import { Icon } from '../Icon';

interface Props {
  auditId: string;
  shareUrl: string;
  clientId: string;
  clientStatus: string;
  running: boolean;
  lead: { name: string | null; email: string; createdAt: string } | null;
}

export function PrintButton({ className = 'secondary' }: { className?: string }) {
  return (
    <button className={`${className} no-print`} onClick={() => window.print()} title="Opens the print dialog. Choose “Save as PDF”.">
      <Icon name="download" />
      Download PDF
    </button>
  );
}

export function AuditActions({ auditId, shareUrl: initialUrl, clientId, clientStatus, running, lead }: Props) {
  const [shareUrl, setShareUrl] = useState(initialUrl);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const prospect = clientStatus === 'prospect';

  async function act(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card audit-actions no-print">
      <div className="card-head">
        <div>
          <h2>Share this report</h2>
          <p className="muted small">
            Anyone with the link can read the report. It shows only your brand.
            {lead && ` Requested through your website by ${lead.name ? `${lead.name}, ` : ''}${lead.email}.`}
          </p>
        </div>
        <div className="toolbar">
          <PrintButton />
          {prospect && !running && (
            <button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await send('PATCH', `/v1/clients/${clientId}`, { status: 'active' });
                  window.location.assign(`/clients/${clientId}`);
                })
              }
            >
              Convert to client
            </button>
          )}
          {!prospect && (
            <a className="button secondary" href={`/clients/${clientId}`}>Open client</a>
          )}
        </div>
      </div>
      <div className="copy-box">
        <label className="sr-only" htmlFor="share-url">Share link</label>
        <input id="share-url" type="text" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
          }}
        >
          <Icon name="link" />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="hint">
        {prospect ? 'Converting keeps the questions, competitors and results, and makes this a client you can track every week. ' : ''}
        <button
          className="link quiet"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Make a new link? Anyone using the current link will no longer be able to open the report.')) return;
            act(async () => {
              const res = await send<{ shareUrl: string }>('POST', `/v1/audits/${auditId}/share-link`);
              setShareUrl(res.shareUrl);
              setCopied(false);
            });
          }}
        >
          Replace the link
        </button>
        {prospect && (
          <>
            {' · '}
            <button
              className="link danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Delete this audit and the prospect? The share link stops working.')) return;
                act(async () => {
                  await send('DELETE', `/v1/audits/${auditId}`);
                  window.location.assign('/audits');
                });
              }}
            >
              Delete audit
            </button>
          </>
        )}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
