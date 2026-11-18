'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { Usage } from '@/lib/types';
import { PageHead } from './Shell';

const KIND_LABEL: Record<Usage['byKind'][number]['kind'], string> = {
  scheduled_runs: 'Weekly tracking runs',
  manual_runs: 'Runs started by hand',
  audits: 'Audits and leads',
  assets: 'Generated fixes',
  summaries: 'Report summaries',
};

const n = (v: number) => v.toLocaleString('en-IN');

export function UsagePanel({ usage, isOwner, month }: { usage: Usage; isOwner: boolean; month: string }) {
  const pct = Math.round(usage.percentUsed * 100);
  const state = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  const maxDay = Math.max(1, ...usage.daily.map((d) => d.credits));
  const maxClient = Math.max(1, ...usage.byClient.map((c) => c.credits));
  const fc = usage.forecast;

  return (
    <>
      <PageHead crumbs="Workspace / Usage" title="Usage" sub={`Credits used in ${month} on the ${usage.plan} plan. The allowance resets on the 1st.`} />

      {pct >= 80 && (
        <p className={`notice banner ${state}`} role="status">
          {pct >= 100
            ? usage.topup.enabled
              ? `This month’s credits are used up. Top-up is covering work, up to ${n(usage.topup.limit)} more credits.`
              : 'This month’s credits are used up, so new runs, fixes and summaries are paused until the 1st.' + (isOwner ? ' Turn on top-up below to carry on.' : ' An owner can turn on top-up to carry on.')
            : `${pct}% of this month’s credits are used.`}
        </p>
      )}

      <div className="grid-main">
        <div className="card">
          <span className="label">Credits used this month</span>
          <div className="figure">
            <strong>{n(usage.used)}</strong>
            <span className="of">of {n(usage.available)}</span>
            <span className={`pill ${state}`}>{pct}%</span>
          </div>
          <div className="bar usage-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, pct)}%` }} className={state} />
            <i style={{ left: '80%' }} />
          </div>
          <div className="meter-foot">
            <span>{usage.remaining >= 0 ? `${n(usage.remaining)} left` : `${n(-usage.remaining)} over, from top-up`}</span>
            <span>{usage.granted > 0 ? `${n(usage.allowance)} on the plan + ${n(usage.granted)} granted` : `${n(usage.allowance)} on the plan`}</span>
          </div>

          <div className="mini-stats">
            <div>
              <span className="muted">Forecast for the month</span>
              <strong className={fc.overBy > 0 ? 'over' : undefined}>{n(fc.credits)}</strong>
              <span className="muted">{fc.overBy > 0 ? `${n(fc.overBy)} over the allowance` : 'Within the allowance'}</span>
            </div>
            <div>
              <span className="muted">Weekly runs still to come</span>
              <strong>{n(fc.scheduledAhead)}</strong>
              <span className="muted">Credits, at today’s questions</span>
            </div>
            <div>
              <span className="muted">Everything else, at this pace</span>
              <strong>{n(fc.otherAhead)}</strong>
              <span className="muted">Over the {fc.daysLeft} days left</span>
            </div>
          </div>
        </div>

        <TopupCard usage={usage} isOwner={isOwner} />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h2>What used credits</h2></div>
          <div className="measures tight">
            {usage.byKind.map((k) => (
              <div className="measure strong" key={k.kind}>
                <div className="measure-head">
                  <span>{KIND_LABEL[k.kind]}</span>
                  <span className="measure-value"><strong>{n(k.credits)}</strong></span>
                </div>
                <div className="bar"><span style={{ width: `${usage.used ? (k.credits / usage.used) * 100 : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>By client</h2></div>
          {usage.byClient.length === 0 ? (
            <p className="muted">No client work this month yet.</p>
          ) : (
            <div className="measures tight">
              {usage.byClient.map((c) => (
                <div className="measure" key={c.name}>
                  <div className="measure-head">
                    <span>{c.name}</span>
                    <span className="measure-value"><strong>{n(c.credits)}</strong></span>
                  </div>
                  <div className="bar"><span style={{ width: `${(c.credits / maxClient) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Day by day</h2><span className="muted small">Credits, UTC days</span></div>
        <ol className="days" aria-label="Credits used each day">
          {usage.daily.map((d) => (
            <li key={d.day} title={`${d.day}: ${d.credits} credits`}>
              <span className="days-bar"><span style={{ height: `${(d.credits / maxDay) * 100}%` }} /></span>
              <span className="days-label">{Number(d.day.slice(8))}</span>
              <span className="sr-only">{d.credits} credits</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function TopupCard({ usage, isOwner }: { usage: Usage; isOwner: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(usage.topup.enabled);
  const [limit, setLimit] = useState(String(usage.topup.limit || Math.max(100, Math.round(usage.allowance * 0.25))));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(nextEnabled: boolean) {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      await send('PATCH', '/v1/usage/topup', { enabled: nextEnabled, limit: Number(limit) || 0 });
      setEnabled(nextEnabled);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <span className="label">Top-up</span>
      <h2 style={{ margin: '4px 0 8px' }}>{enabled ? 'On' : 'Off'}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        At 100%, work stops until the 1st. With top-up on, runs, fixes and summaries carry on past the allowance, up to the cap you set. Owners are emailed at 80% and 100%.
      </p>
      {usage.topup.inUse > 0 && <p className="small">{n(usage.topup.inUse)} top-up credits used this month.</p>}
      {isOwner ? (
        <>
          <div className="field">
            <label htmlFor="topup-limit">Cap for the month, in credits</label>
            <input id="topup-limit" type="number" min={1} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {saved && <p className="success" role="status">Saved.</p>}
          <div className="toolbar">
            {enabled ? (
              <>
                <button className="sm" disabled={busy} onClick={() => save(true)}>Save cap</button>
                <button className="sm secondary" disabled={busy} onClick={() => save(false)}>Turn off</button>
              </>
            ) : (
              <button className="sm" disabled={busy} onClick={() => save(true)}>Turn on top-up</button>
            )}
          </div>
        </>
      ) : (
        <p className="muted small">Only an owner can change top-up.</p>
      )}
    </div>
  );
}
