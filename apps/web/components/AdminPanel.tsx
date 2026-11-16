'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { AdminAgency, Plan } from '@/lib/types';

export function AdminPanel({ agencies, plans }: { agencies: AdminAgency[]; plans: Plan[] }) {
  const router = useRouter();
  const [error, setError] = useState('');

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
      <div className="page-head">
        <div>
          <h1>Agencies</h1>
          <p className="muted small">{agencies.length} {agencies.length === 1 ? 'workspace' : 'workspaces'}</p>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="card" style={{ padding: 0 }}>
        {agencies.length === 0 ? (
          <p className="empty">No agencies have signed up yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agency</th>
                <th>Clients</th>
                <th>Users</th>
                <th>Plan</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agencies.map((agency) => (
                <tr key={agency.id}>
                  <td>
                    <strong>{agency.name}</strong>
                    <div className="small">
                      <a href={agency.workspaceUrl} target="_blank" rel="noreferrer">{agency.workspaceUrl.replace(/^https?:\/\//, '')}</a>
                    </div>
                  </td>
                  <td>{agency.clientCount}</td>
                  <td>{agency.userCount}</td>
                  <td>
                    <select
                      aria-label={`Plan for ${agency.name}`}
                      value={agency.planKey}
                      onChange={(e) => update(agency.id, { planKey: e.target.value })}
                      style={{ width: 140 }}
                    >
                      {plans.map((plan) => (
                        <option key={plan.key} value={plan.key}>{plan.name} ({plan.clientLimit})</option>
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
