'use client';

import { useState, type FormEvent } from 'react';
import { send } from '@/lib/client';
import type { Client } from '@/lib/types';

export function ClientsPanel({ initial, canEdit, clientLimit }: { initial: Client[]; canEdit: boolean; clientLimit: number | null }) {
  const [clients, setClients] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = clients.filter((c) => c.status === 'active').length;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    setBusy(true);
    try {
      const res = await send<{ client: Client }>('POST', '/v1/clients', {
        name: data.name,
        ...(data.domain ? { domain: data.domain } : {}),
      });
      setClients((list) => [res.client, ...list]);
      form.reset();
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{canEdit ? 'Clients' : 'Overview'}</h1>
          {canEdit && clientLimit !== null && (
            <p className="muted small">
              {active} of {clientLimit} active clients on your plan
            </p>
          )}
        </div>
      </div>

      {canEdit && (
        <form className="card" onSubmit={add}>
          <h2>Add a client</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="name">Client name</label>
              <input id="name" name="name" type="text" required maxLength={160} />
            </div>
            <div className="field">
              <label htmlFor="domain">Website</label>
              <input id="domain" name="domain" type="text" placeholder="example.com" />
            </div>
            <button disabled={busy}>{busy ? 'Adding…' : 'Add client'}</button>
          </div>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className="card" style={{ padding: 0 }}>
        {clients.length === 0 ? (
          <p className="empty">{canEdit ? 'No clients yet. Add your first client above.' : 'Nothing has been shared with you yet.'}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Website</th>
                <th>Status</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id}>
                  <td><strong>{client.name}</strong></td>
                  <td className="muted">{client.domain ?? '—'}</td>
                  <td>
                    <span className={`pill ${client.status === 'active' ? 'ok' : ''}`}>{client.status === 'active' ? 'Active' : 'Paused'}</span>
                  </td>
                  {canEdit && (
                    <td className="actions">
                      <button className="link" onClick={() => setStatus(client, client.status === 'active' ? 'paused' : 'active')}>
                        {client.status === 'active' ? 'Pause' : 'Activate'}
                      </button>
                      <button className="link danger" onClick={() => remove(client)}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
