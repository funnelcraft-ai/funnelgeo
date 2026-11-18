'use client';

import { useCallback, useEffect, useState } from 'react';
import { load, send } from '@/lib/client';
import type { Tracker, VisitsView } from '@/lib/types';
import { Icon } from '../Icon';
import { formatDateTime } from './ClientWorkspace';

const RANGES = [7, 30, 90] as const;

export function VisitsTab({ tracker, canEdit, onGoTo }: { tracker: Tracker; canEdit: boolean; onGoTo: (tab: 'brands') => void }) {
  const clientId = tracker.client.id;
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [view, setView] = useState<VisitsView | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setView(await load<VisitsView>(`/v1/clients/${clientId}/visits?days=${days}`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [clientId, days]);
  useEffect(() => void reload(), [reload]);
  // New visits show up without a reload; faster while waiting for the install.
  const waiting = canEdit && view?.snippet && !view.snippet.seenAt;
  useEffect(() => {
    const timer = setInterval(reload, waiting ? 5000 : 10000);
    return () => clearInterval(timer);
  }, [reload, waiting]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!view) return <p className="muted" aria-busy="true">Loading AI visits…</p>;

  const max = Math.max(1, ...view.byDay.map((d) => d.visits));
  const engineMax = Math.max(1, ...view.byEngine.map((e) => e.visits));
  const tests = view.recent.filter((r) => r.isTest).length;

  return (
    <div className="visits">
      {view.snippet && <Install snippet={view.snippet} clientId={clientId} onChanged={reload} onGoTo={onGoTo} />}

      <div className="visits-head">
        <div className="segmented" role="tablist" aria-label="Period">
          {RANGES.map((d) => (
            <button key={d} role="tab" aria-selected={days === d} onClick={() => setDays(d)}>
              Last {d} days
            </button>
          ))}
        </div>
      </div>

      <div className="grid-3">
        <div className="card stat">
          <span className="label">AI visits</span>
          <strong>{view.totals.visits.toLocaleString()}</strong>
          <p className="muted">From AI assistants to the website</p>
        </div>
        <div className="card stat">
          <span className="label">Sessions</span>
          <strong>{view.totals.sessions.toLocaleString()}</strong>
          <p className="muted">Browser tabs those visits came in</p>
        </div>
        <div className="card stat">
          <span className="label">Conversions</span>
          <strong>{view.totals.conversions.toLocaleString()}</strong>
          <p className="muted">Marked by the site during an AI visit</p>
        </div>
      </div>

      <section className="card" aria-labelledby="daily-head">
        <div className="card-head">
          <h2 id="daily-head">Visits by day</h2>
        </div>
        {view.totals.visits === 0 ? (
          <p className="empty">No AI visits in this period{tests ? ' apart from test visits' : ''}.</p>
        ) : (
          <div className="day-bars" role="img" aria-label={`AI visits per day over the last ${view.days} days, ${view.totals.visits} in total`}>
            {view.byDay.map((d) => (
              <span key={d.day} title={`${d.day}: ${d.visits}`} style={{ height: `${(d.visits / max) * 100}%` }} className={d.visits ? '' : 'zero'} />
            ))}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="card flush" aria-labelledby="engine-head">
          <div className="card-head"><h2 id="engine-head">By assistant</h2></div>
          {view.byEngine.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <ul className="hbars">
              {view.byEngine.map((e) => (
                <li key={e.key}>
                  <span className="hbar-label">{e.label}</span>
                  <span className="hbar"><span style={{ width: `${(e.visits / engineMax) * 100}%` }} /></span>
                  <span className="hbar-value">{e.visits}{e.conversions ? <span className="muted small"> · {e.conversions} conv.</span> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card flush" aria-labelledby="pages-head">
          <div className="card-head"><h2 id="pages-head">Landing pages</h2></div>
          {view.pages.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Page</th><th>Visits</th><th>Conversions</th></tr>
                </thead>
                <tbody>
                  {view.pages.map((p) => (
                    <tr key={p.path}><td className="path">{p.path}</td><td>{p.visits}</td><td>{p.conversions}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="card flush" aria-labelledby="recent-head">
        <div className="card-head">
          <div>
            <h2 id="recent-head">Latest visits</h2>
            <p className="muted small">Updates on its own. Test visits are shown here but left out of every total.</p>
          </div>
        </div>
        {view.recent.length === 0 ? (
          <p className="empty">No visits recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>From</th><th>Page</th><th>Conversion</th></tr>
              </thead>
              <tbody>
                {view.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.occurredAt)}</td>
                    <td>
                      {r.engineLabel}
                      {r.isTest && <span className="pill warn">Test</span>}
                      <span className="muted small"> · {r.via === 'utm' ? 'tagged link' : 'referrer'}</span>
                    </td>
                    <td className="path">{r.path}</td>
                    <td>{r.converted ? r.conversionName ?? 'Yes' : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small">
        Counts visits that arrive from ChatGPT, Perplexity, Gemini, Claude, Copilot and other AI assistants, by their referring site or a utm_source tag. Visits from Google’s AI Overviews look the same as ordinary Google search, so no snippet can count them. No cookies or IP addresses are stored.
      </p>
    </div>
  );
}

function Install({ snippet, clientId, onChanged, onGoTo }: { snippet: NonNullable<VisitsView['snippet']>; clientId: string; onChanged: () => Promise<void>; onGoTo: (tab: 'brands') => void }) {
  const [copied, setCopied] = useState('');
  const [open, setOpen] = useState(!snippet.seenAt);
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(what);
    setTimeout(() => setCopied(''), 2000);
  };
  async function rotate() {
    if (!window.confirm('Replace the site key? The snippet on the website stops recording until it is updated with the new one.')) return;
    await send('POST', `/v1/clients/${clientId}/site-key`);
    await onChanged();
  }

  return (
    <section className="card install" aria-labelledby="install-head">
      <div className="card-head">
        <div>
          <h2 id="install-head">Tracking snippet</h2>
          <p className="muted small">
            {snippet.seenAt ? (
              <><Icon name="check" /> Installed: last heard from the website {formatDateTime(snippet.seenAt)}.</>
            ) : (
              'Not seen on the website yet. This page checks every few seconds.'
            )}
          </p>
        </div>
        {snippet.seenAt && (
          <button className="secondary sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show snippet'}</button>
        )}
      </div>
      {!snippet.domain ? (
        <p className="notice warn">Add the client’s website address first: only visits to that site are recorded. <button className="link" onClick={() => onGoTo('brands')}>Brands</button></p>
      ) : (
        open && (
          <ol className="install-steps">
            <li>
              <p>Add this line to every page of {snippet.domain}, just before <code>&lt;/head&gt;</code>. In WordPress, a header-scripts plugin does it; in Shopify, theme.liquid.</p>
              <div className="code-line">
                <code>{snippet.tag}</code>
                <button className="secondary sm" onClick={() => copy(snippet.tag, 'tag')}>{copied === 'tag' ? 'Copied' : 'Copy'}</button>
              </div>
            </li>
            <li>
              <p>Check it: open the client’s site from this link. A test visit from ChatGPT should appear below within a few seconds.</p>
              {snippet.testUrl && (
                <a className="button secondary sm" href={snippet.testUrl} target="_blank" rel="noopener noreferrer">
                  <Icon name="link" />Send a test visit
                </a>
              )}
            </li>
            <li>
              <p>Optional: to count bookings or purchases that come from AI, call this when the form is sent or the order is placed.</p>
              <div className="code-line">
                <code>{snippet.convert}</code>
                <button className="secondary sm" onClick={() => copy(snippet.convert, 'convert')}>{copied === 'convert' ? 'Copied' : 'Copy'}</button>
              </div>
            </li>
          </ol>
        )
      )}
      {open && snippet.domain && (
        <p className="muted small install-foot">
          The snippet sets no cookies. If it was copied somewhere it shouldn’t be, <button className="link quiet" onClick={rotate}>replace the site key</button>.
        </p>
      )}
    </section>
  );
}
