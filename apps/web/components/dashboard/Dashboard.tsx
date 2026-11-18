'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { Agency, Client, Health, Overview } from '@/lib/types';
import { initials } from '../Brand';
import { Icon, type IconName } from '../Icon';
import { Greeting } from '../Shell';
import { TrendChart } from './TrendChart';

interface Props {
  firstName: string;
  overview: Overview;
  clients: Client[];
  canEdit: boolean;
  isOwner: boolean;
  agency: Agency | null;
  invited: boolean;
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const n = (v: number) => v.toLocaleString('en-IN');

/** Status colours are fixed and always come with an icon and a label. */
export const HEALTH: Record<Health, { label: string; icon: IconName; color: string }> = {
  healthy: { label: 'Healthy', icon: 'ok', color: '#0ca30c' },
  watch: { label: 'Watch', icon: 'warning', color: '#fab219' },
  attention: { label: 'Needs attention', icon: 'error', color: '#d03b3b' },
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function Delta({ value, unit = 'pts', invert = false }: { value: number | null; unit?: 'pts' | '%'; invert?: boolean }) {
  if (value === null) return null;
  const shown = unit === 'pts' ? Math.round(value * 100) : Math.round(value * 100);
  const kind = shown === 0 ? 'flat' : (shown > 0) !== invert ? 'up' : 'down';
  return (
    <span className={`delta ${kind}`}>
      <Icon name={shown > 0 ? 'up' : shown < 0 ? 'down' : 'flat'} size={16} />
      {shown > 0 ? '+' : ''}{shown}{unit === 'pts' ? ' pts' : '%'}
    </span>
  );
}

export function Dashboard({ firstName, overview, clients: initialClients, canEdit, isOwner, agency, invited }: Props) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | Health>('all');
  const k = overview.kpis;
  const engineNames = overview.trend.engines.map((e) => e.label);

  const perf = useMemo(() => new Map(overview.clients.map((c) => [c.id, c])), [overview.clients]);
  const rows = useMemo(() => {
    const order: Record<Health, number> = { attention: 0, watch: 1, healthy: 2 };
    return [...clients]
      .filter((c) => filter === 'all' || perf.get(c.id)?.health === filter)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        const pa = perf.get(a.id), pb = perf.get(b.id);
        return (pa ? order[pa.health] : 3) - (pb ? order[pb.health] : 3) || a.name.localeCompare(b.name);
      });
  }, [clients, perf, filter]);

  const active = clients.filter((c) => c.status === 'active').length;
  const limit = agency?.plan.clientLimit ?? 0;
  const visitsChange = k.visits.previous28 > 0 ? (k.visits.last28 - k.visits.previous28) / k.visits.previous28 : null;
  const visChange = k.visibility.rate !== null && k.visibility.previous !== null ? k.visibility.rate - k.visibility.previous : null;
  const total = overview.health.healthy + overview.health.watch + overview.health.attention;

  const steps = agency && isOwner
    ? [
        { label: 'Add your logo', done: Boolean(agency.branding.logoUrl), href: '/settings' },
        { label: 'Set your brand colour', done: Boolean(agency.branding.primaryColor), href: '/settings' },
        { label: 'Connect your own domain', done: agency.domainStatus === 'verified', href: '/settings' },
        { label: 'Add your first client', done: clients.length > 0, href: '#clients' },
        { label: 'Invite a teammate or client', done: invited, href: '/team' },
      ]
    : [];
  const left = steps.filter((s) => !s.done).length;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    setBusy(true);
    try {
      const res = await send<{ client: Client }>('POST', '/v1/clients', { name: data.name, ...(data.domain ? { domain: data.domain } : {}) });
      setClients((list) => [res.client, ...list]);
      form.reset();
      setAdding(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(client: Client, status: 'active' | 'paused') {
    setError('');
    try {
      const res = await send<{ client: Client }>('PATCH', `/v1/clients/${client.id}`, { status });
      setClients((list) => list.map((c) => (c.id === client.id ? res.client : c)));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(client: Client) {
    if (!window.confirm(`Delete ${client.name}? This removes the client and everything recorded for it.`)) return;
    setError('');
    try {
      await send('DELETE', `/v1/clients/${client.id}`);
      setClients((list) => list.filter((c) => c.id !== client.id));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="dashboard">
      <div className="page-head">
        <div>
          <Greeting name={firstName} />
          <p className="sub">
            {canEdit
              ? `Tracking ${active} ${active === 1 ? 'client' : 'clients'} across ${engineNames.length ? engineNames.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'the answer engines'}.`
              : 'How the AI answer engines talk about your business.'}
          </p>
        </div>
        {canEdit && (
          <div className="toolbar">
            <a className="button secondary" href="/audits/new"><Icon name="target" />Run an audit</a>
            <button onClick={() => { setAdding(true); document.getElementById('clients')?.scrollIntoView({ behavior: 'smooth' }); }}>
              <Icon name="plus" />Add client
            </button>
          </div>
        )}
      </div>

      {left > 0 && (
        <section className="setup-strip" aria-label="Workspace setup">
          <div>
            <strong>Finish setting up your workspace</strong>
            <span>{left} of {steps.length} steps left</span>
          </div>
          <ul>
            {steps.map((s) => (
              <li key={s.label} className={s.done ? 'done' : undefined}>
                {s.done ? (
                  <span className="chip-step"><Icon name="check" size={18} />{s.label}</span>
                ) : (
                  <a className="chip-step clickable" href={s.href}>{s.label}<Icon name="arrow" size={18} /></a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="kpis" aria-label="Headline figures">
        <article className="kpi hero">
          <span className="kpi-icon"><Icon name="visibility" /></span>
          <div>
            <span className="kpi-label">AI visibility</span>
            <div className="kpi-value"><strong>{pct(k.visibility.rate)}</strong><Delta value={visChange} /></div>
            <p>{k.visibility.answers ? `${n(k.visibility.mentioned)} of ${n(k.visibility.answers)} answers named ${canEdit ? 'your clients' : 'you'}` : 'No completed runs yet'}</p>
          </div>
        </article>
        <article className="kpi">
          <span className="kpi-icon"><Icon name="visits" /></span>
          <div>
            <span className="kpi-label">AI visits, 28 days</span>
            <div className="kpi-value"><strong>{n(k.visits.last28)}</strong><Delta value={visitsChange} unit="%" /></div>
            <p>{visitsChange === null ? 'From the tracking snippet' : `vs ${n(k.visits.previous28)} the 28 days before`}</p>
          </div>
        </article>
        <article className="kpi">
          <span className="kpi-icon"><Icon name="question" /></span>
          <div>
            <span className="kpi-label">Questions tracked</span>
            <div className="kpi-value"><strong>{n(k.questions.active)}</strong></div>
            <p>Across {k.questions.clients} {k.questions.clients === 1 ? 'client' : 'clients'}, asked weekly</p>
          </div>
        </article>
        <article className="kpi">
          <span className="kpi-icon"><Icon name="flag" /></span>
          <div>
            <span className="kpi-label">Needing attention</span>
            <div className="kpi-value">
              <strong>{k.attention.clients}</strong>
              {k.attention.openActions > 0 && <span className="delta neutral">{k.attention.openActions} open fixes</span>}
            </div>
            <p>{k.attention.clients === 0 ? 'Every client is on track' : `${k.attention.clients === 1 ? 'Client' : 'Clients'} with a drop, a failed run or no recent run`}</p>
          </div>
        </article>
      </section>

      <div className="dash-row">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>AI visibility by engine</h2>
              <p className="muted small">Share of answers that named {canEdit ? 'a client' : 'you'}, by week</p>
            </div>
          </div>
          <TrendChart trend={overview.trend} />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Client health</h2>
            {filter !== 'all' && <button className="link" onClick={() => setFilter('all')}>Show all</button>}
          </div>
          {total === 0 ? (
            <p className="muted">Health shows once clients are active.</p>
          ) : (
            <>
              <div className="health-figure"><strong>{overview.health.healthy}</strong><span>of {total} healthy</span></div>
              <div className="segbar" role="img" aria-label={`${overview.health.healthy} healthy, ${overview.health.watch} to watch, ${overview.health.attention} need attention`}>
                {(['healthy', 'watch', 'attention'] as Health[]).map((h) =>
                  overview.health[h] > 0 ? <span key={h} style={{ flex: overview.health[h], background: HEALTH[h].color }} /> : null,
                )}
              </div>
              <ul className="health-list">
                {(['healthy', 'watch', 'attention'] as Health[]).map((h) => (
                  <li key={h}>
                    <button className={`health-row clickable${filter === h ? ' on' : ''}`} onClick={() => setFilter(filter === h ? 'all' : h)} aria-pressed={filter === h}>
                      <span className="health-icon" style={{ color: HEALTH[h].color }}><Icon name={HEALTH[h].icon} filled /></span>
                      {HEALTH[h].label}
                      <b>{overview.health[h]}</b>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="hint">Needs attention: a failed run, no run for {14} days, or visibility down 10+ points. Watch: down 5–10 points.</p>
            </>
          )}
        </section>
      </div>

      <div className="dash-stack">
        <section className="card flush" id="clients">
          <div className="card-head">
            <div>
              <h2>Clients</h2>
              <p className="muted small">
                {canEdit ? `${active} of ${limit} active on the ${agency?.plan.name ?? ''} plan` : `${clients.length} shared with you`}
                {filter !== 'all' && ` · showing ${HEALTH[filter].label.toLowerCase()}`}
              </p>
            </div>
            {canEdit && !adding && <button className="tonal sm" onClick={() => setAdding(true)}><Icon name="plus" />Add client</button>}
          </div>

          {adding && (
            <form onSubmit={add} className="add-client">
              <div className="field">
                <label htmlFor="name">Client name</label>
                <input id="name" name="name" type="text" required maxLength={160} autoFocus />
              </div>
              <div className="field">
                <label htmlFor="domain">Website</label>
                <input id="domain" name="domain" type="text" placeholder="example.com" />
              </div>
              <div className="toolbar">
                <button disabled={busy}>{busy ? 'Adding…' : 'Save client'}</button>
                <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </form>
          )}
          {error && <p className="error" role="alert" style={{ padding: '0 24px' }}>{error}</p>}

          {clients.length === 0 ? (
            <p className="empty"><strong>{canEdit ? 'No clients yet' : 'Nothing here yet'}</strong>{canEdit ? 'Add your first client to start tracking their AI visibility.' : 'Your agency has not shared anything with you so far.'}</p>
          ) : rows.length === 0 ? (
            <p className="empty">No clients in this group.</p>
          ) : (
            <table className="perf">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Visibility</th>
                  <th>Share of voice</th>
                  <th>AI visits</th>
                  <th>Health</th>
                  {canEdit && <th><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const p = perf.get(c.id);
                  const paused = c.status !== 'active';
                  return (
                    <tr key={c.id} className={paused ? 'paused' : undefined}>
                      <td>
                        <div className="who-cell">
                          <span className="avatar sm" aria-hidden="true">{initials(c.name)}</span>
                          <div>
                            <strong><a className="row-link" href={`/clients/${c.id}`}>{c.name}</a></strong>
                            <span>{c.domain ?? 'No website on file'}</span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Visibility">
                        {p && p.visibility !== null ? (
                          <span className="vis">
                            <b>{pct(p.visibility)}</b>
                            <Delta value={p.change} />
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td data-label="Share of voice">{p ? pct(p.shareOfVoice) : '—'}</td>
                      <td data-label="AI visits">{p ? n(p.visits) : '—'}</td>
                      <td data-label="Health">
                        {paused ? (
                          <span className="pill">Paused</span>
                        ) : p ? (
                          <span className={`pill ${p.health === 'healthy' ? 'ok' : p.health === 'watch' ? 'warn' : 'bad'}`} title={p.reason}>
                            <Icon name={HEALTH[p.health].icon} size={16} />{HEALTH[p.health].label}
                          </span>
                        ) : null}
                        {p && !paused && p.health !== 'healthy' && <span className="reason">{p.reason}</span>}
                      </td>
                      {canEdit && (
                        <td className="actions">
                          <RowMenu
                            items={[
                              { label: 'Open', icon: 'open', onClick: () => router.push(`/clients/${c.id}`) },
                              { label: paused ? 'Activate' : 'Pause', icon: paused ? 'play' : 'schedule', onClick: () => setStatus(c, paused ? 'active' : 'paused') },
                              { label: 'Delete', icon: 'delete', danger: true, onClick: () => remove(c) },
                            ]}
                            label={`Actions for ${c.name}`}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Recent activity</h2></div>
          {overview.activity.length === 0 ? (
            <p className="muted">Runs, finished fixes and sent reports show up here.</p>
          ) : (
            <ul className="activity">
              {overview.activity.map((a) => (
                <li key={`${a.kind}-${a.ref}`}>
                  <span className={`act-icon ${a.kind}`}><Icon name={ACT[a.kind].icon} size={20} /></span>
                  <div>
                    <p>{ACT[a.kind].text(a)}</p>
                    <span><a href={`/clients/${a.clientId}${ACT[a.kind].tab}`}>{a.client}</a> · {ago(a.at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

type Activity = Overview['activity'][number];
const ACT: Record<Activity['kind'], { icon: IconName; tab: string; text: (a: Activity) => string }> = {
  run: { icon: 'insights', tab: '', text: (a) => `Weekly check done: named in ${a.mentioned} of ${a.answers} answers` },
  run_failed: { icon: 'error', tab: '?tab=runs', text: () => 'A run failed' },
  action_done: { icon: 'task', tab: '?tab=actions', text: (a) => `Fix done: ${a.title}` },
  report_sent: { icon: 'report', tab: '?tab=reports', text: (a) => `${a.title} report sent` },
  audit: { icon: 'target', tab: '', text: (a) => `Audit completed for ${a.title ?? a.client}` },
};

function RowMenu({ items, label }: { items: { label: string; icon: IconName; danger?: boolean; onClick: () => void }[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="row-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button className="icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((i) => (
            <button key={i.label} className={`menu-item${i.danger ? ' danger' : ''}`} role="menuitem" onClick={() => { setOpen(false); i.onClick(); }}>
              <Icon name={i.icon} />{i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
