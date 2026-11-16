'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { send } from '@/lib/client';
import type { Agency, Client } from '@/lib/types';
import { initials } from './Brand';
import { Icon } from './Icon';
import { Greeting, PageHead } from './Shell';

interface Props {
  firstName: string;
  initial: Client[];
  canEdit: boolean;
  isOwner: boolean;
  agency: Agency | null;
  teamCount: number;
  viewerCount: number;
  pendingInvites: number;
  credits: { allowance: number; remaining: number } | null;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function OverviewPanel({ firstName, initial, canEdit, isOwner, agency, teamCount, viewerCount, pendingInvites, credits }: Props) {
  const [clients, setClients] = useState(initial);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl+K or Cmd+K jumps to search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = clients.filter((c) => c.status === 'active').length;
  const limit = agency?.plan.clientLimit ?? 0;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? clients.filter((c) => c.name.toLowerCase().includes(q) || (c.domain ?? '').includes(q)) : clients;
  }, [clients, query]);

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
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Client viewers get a simple view of what has been shared with them.
  if (!canEdit) {
    return (
      <>
        <PageHead crumbs="Overview" title={<Greeting name={firstName} />} sub="Here is what your agency has shared with you." />
        <div className="card flush">
          {clients.length === 0 ? (
            <p className="empty"><strong>Nothing here yet</strong>Your agency has not shared anything with you so far.</p>
          ) : (
            <table>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <div className="who-cell">
                        <span className="avatar sm" aria-hidden="true">{initials(client.name)}</span>
                        <div>
                          <strong><a className="row-link" href={`/clients/${client.id}`}>{client.name}</a></strong>
                          <span>{client.domain ?? 'No website on file'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="actions"><a className="button secondary sm" href={`/clients/${client.id}`}>View results</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </>
    );
  }

  const steps = agency
    ? [
        { label: 'Add your logo', done: Boolean(agency.branding.logoUrl), href: '/settings' },
        { label: 'Set your brand colours', done: Boolean(agency.branding.primaryColor), href: '/settings' },
        { label: 'Connect your own domain', done: agency.domainStatus === 'verified', href: '/settings' },
        { label: 'Add your first client', done: clients.length > 0, href: null },
        { label: 'Invite a teammate or client', done: teamCount + viewerCount + pendingInvites > 1, href: '/team' },
      ]
    : [];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <>
      <PageHead
        crumbs="Overview / Clients"
        title={<Greeting name={firstName} />}
        sub="Here is where your workspace and clients stand today."
      >
        <div className="search">
          <Icon name="search" />
          <label className="sr-only" htmlFor="client-search">Search clients</label>
          <input id="client-search" ref={searchRef} type="search" placeholder="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>Ctrl K</kbd>
        </div>
        <button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          <Icon name="plus" />
          Add client
        </button>
      </PageHead>

      <div className="grid-main">
        <section className="card" aria-label="Active clients">
          <span className="label">Active clients</span>
          <div className="figure">
            <strong>{active}</strong>
            <span className="of">of {limit}</span>
            <span className="pill">{agency?.plan.name} plan</span>
          </div>
          <div className="meter" role="img" aria-label={`${active} of ${limit} client slots used`}>
            {Array.from({ length: limit }, (_, i) => (
              <span key={i} className={i < active ? 'on' : undefined} />
            ))}
          </div>
          <div className="meter-foot">
            <span>{Math.max(limit - active, 0)} {limit - active === 1 ? 'slot' : 'slots'} free</span>
            <span>{clients.length - active} paused</span>
          </div>
          <div className="mini-stats">
            <div>
              <span className="label">Team members</span>
              <strong>{teamCount}</strong>
              <span className="muted">{pendingInvites} {pendingInvites === 1 ? 'invite' : 'invites'} pending</span>
            </div>
            <div>
              <span className="label">Client logins</span>
              <strong>{viewerCount}</strong>
              <span className="muted">Can view their own dashboard</span>
            </div>
            <div>
              <span className="label">Credits left this month</span>
              <strong>{credits ? credits.remaining.toLocaleString() : '0'}</strong>
              <span className="muted">of {credits ? credits.allowance.toLocaleString() : '0'} on your plan</span>
            </div>
          </div>
        </section>

        <aside className="panel" aria-label="Workspace setup">
          <div className="panel-inner">
            <span className="label">Workspace setup</span>
            <h2>{doneCount === steps.length ? 'Your workspace is ready.' : `${steps.length - doneCount} ${steps.length - doneCount === 1 ? 'step' : 'steps'} left to finish.`}</h2>
            <ul className="checklist">
              {steps.map((step) => (
                <li key={step.label} className={step.done ? 'done' : undefined}>
                  <span className="tick"><Icon name="check" /></span>
                  {step.href && isOwner && !step.done ? <a href={step.href}>{step.label}</a> : <span>{step.label}</span>}
                </li>
              ))}
            </ul>
            <div className="steps" aria-hidden="true">
              {steps.map((step, i) => (
                <span key={step.label} className={i < doneCount ? 'on' : undefined} />
              ))}
            </div>
          </div>
        </aside>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Clients</h2>
            <p className="muted small">{clients.length} in total</p>
          </div>
        </div>

        {adding && (
          <form onSubmit={add} style={{ padding: '0 24px 20px' }}>
            <div className="row notice">
              <div className="field">
                <label htmlFor="name">Client name</label>
                <input id="name" name="name" type="text" required maxLength={160} autoFocus />
              </div>
              <div className="field">
                <label htmlFor="domain">Website</label>
                <input id="domain" name="domain" type="text" placeholder="example.com" />
              </div>
              <button disabled={busy}>{busy ? 'Adding…' : 'Save client'}</button>
              <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        )}

        {clients.length === 0 ? (
          <p className="empty"><strong>No clients yet</strong>Add your first client to start tracking their AI visibility.</p>
        ) : shown.length === 0 ? (
          <p className="empty">No clients match “{query}”.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((client) => (
                <tr key={client.id}>
                  <td>
                    <div className="who-cell">
                      <span className="avatar sm" aria-hidden="true">{initials(client.name)}</span>
                      <div>
                        <strong><a className="row-link" href={`/clients/${client.id}`}>{client.name}</a></strong>
                        <span>{client.domain ?? 'No website on file'}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${client.status === 'active' ? 'ok' : ''}`}>{client.status === 'active' ? 'Active' : 'Paused'}</span>
                  </td>
                  <td className="muted">{formatDate(client.createdAt)}</td>
                  <td className="actions">
                    <button className="link quiet" onClick={() => setStatus(client, client.status === 'active' ? 'paused' : 'active')}>
                      {client.status === 'active' ? 'Pause' : 'Activate'}
                    </button>
                    <button className="link danger" onClick={() => remove(client)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
