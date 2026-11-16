'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { AdminAgency, Plan } from '@/lib/types';
import { initials } from './Brand';
import { Icon } from './Icon';
import { PageHead } from './Shell';

export function AdminPanel({ agencies, plans }: { agencies: AdminAgency[]; plans: Plan[] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? agencies.filter((a) => a.name.toLowerCase().includes(q) || a.workspaceUrl.toLowerCase().includes(q)) : agencies;
  }, [agencies, query]);

  const active = agencies.filter((a) => a.status === 'active').length;
  const clients = agencies.reduce((sum, a) => sum + a.clientCount, 0);
  const users = agencies.reduce((sum, a) => sum + a.userCount, 0);

  async function update(id: string, body: { planKey?: string; status?: 'active' | 'suspended' }) {
    setError('');
    try {
      await send('PATCH', `/v1/admin/agencies/${id}`, body);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHead crumbs="Platform / Agencies" title="Agencies" sub="Every workspace on the platform, with its plan and status.">
        <div className="search">
          <Icon name="search" />
          <label className="sr-only" htmlFor="agency-search">Search agencies</label>
          <input id="agency-search" type="search" placeholder="Search agencies" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </PageHead>

      <div className="grid-3">
        <div className="card stat">
          <span className="label">Active agencies</span>
          <strong>{active}</strong>
          <p className="muted">{agencies.length - active} suspended</p>
        </div>
        <div className="card stat">
          <span className="label">Clients managed</span>
          <strong>{clients}</strong>
          <p className="muted">Across all workspaces</p>
        </div>
        <div className="card stat">
          <span className="label">People with a login</span>
          <strong>{users}</strong>
          <p className="muted">Agency staff and client viewers</p>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="card flush">
        {agencies.length === 0 ? (
          <p className="empty"><strong>No agencies yet</strong>Workspaces appear here as soon as an agency signs up.</p>
        ) : shown.length === 0 ? (
          <p className="empty">No agency matches “{query}”.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agency</th>
                <th>Clients</th>
                <th>Users</th>
                <th>Plan</th>
                <th>Status</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((agency) => (
                <tr key={agency.id}>
                  <td>
                    <div className="who-cell">
                      <span className="avatar sm neutral" aria-hidden="true">{initials(agency.name)}</span>
                      <div>
                        <strong>{agency.name}</strong>
                        <span>
                          <a href={agency.workspaceUrl} target="_blank" rel="noreferrer">{agency.workspaceUrl.replace(/^https?:\/\//, '')}</a>
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>{agency.clientCount}</td>
                  <td>{agency.userCount}</td>
                  <td>
                    <select
                      aria-label={`Plan for ${agency.name}`}
                      value={agency.planKey}
                      onChange={(e) => update(agency.id, { planKey: e.target.value })}
                      style={{ width: 190, height: 38 }}
                    >
                      {plans.map((plan) => (
                        <option key={plan.key} value={plan.key}>{plan.name} · {plan.clientLimit} clients</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`pill ${agency.status === 'active' ? 'ok' : 'bad'}`}>{agency.status === 'active' ? 'Active' : 'Suspended'}</span>
                  </td>
                  <td className="actions">
                    {agency.status === 'active' ? (
                      <button
                        className="link danger"
                        onClick={() => {
                          if (window.confirm(`Suspend ${agency.name}? Its team and clients will be locked out until you reactivate it.`)) {
                            update(agency.id, { status: 'suspended' });
                          }
                        }}
                      >
                        Suspend
                      </button>
                    ) : (
                      <button className="link" onClick={() => update(agency.id, { status: 'active' })}>Reactivate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
