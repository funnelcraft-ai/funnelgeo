'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import { ROLE_LABEL, type Client, type TeamInvite, type TeamUser } from '@/lib/types';

interface Props {
  users: TeamUser[];
  invites: TeamInvite[];
  clients: Client[];
  isOwner: boolean;
  selfId: string;
}

export function TeamPanel({ users, invites, clients, isOwner, selfId }: Props) {
  const router = useRouter();
  const [role, setRole] = useState<'agency_member' | 'client_viewer'>('agency_member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    setBusy(true);
    setCopied(false);
    try {
      const res = await send<{ inviteUrl: string }>('POST', '/v1/team/invites', {
        role,
        email: data.email,
        ...(role === 'client_viewer' ? { clientId: data.clientId } : {}),
      });
      setLink({ email: data.email ?? '', url: res.inviteUrl });
      form.reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="muted small">People at your agency, and clients you have given a login.</p>
        </div>
      </div>

      {isOwner && (
        <form className="card" onSubmit={invite}>
          <h2>Invite someone</h2>
          <div className="row">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required />
            </div>
            <div className="field">
              <label htmlFor="role">Access</label>
              <select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="agency_member">Team member</option>
                <option value="client_viewer">Client viewer (one client)</option>
              </select>
            </div>
            {role === 'client_viewer' && (
              <div className="field">
                <label htmlFor="clientId">Client</label>
                <select id="clientId" name="clientId" required defaultValue="">
                  <option value="" disabled>Choose a client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <button disabled={busy}>{busy ? 'Creating…' : 'Create invite'}</button>
          </div>
          {link && (
            <div style={{ marginTop: 16 }}>
              <p className="success" role="status">Invite created for {link.email}. Send them this link; it works once and expires in 7 days.</p>
              <div className="copy-box">
                <input type="text" readOnly value={link.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link.url);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Access</th>
              {isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.name}</strong>{user.id === selfId && <span className="muted"> (you)</span>}</td>
                <td className="muted">{user.email}</td>
                <td>
                  {ROLE_LABEL[user.role]}
                  {user.clientName && <span className="muted"> · {user.clientName}</span>}
                </td>
                {isOwner && (
                  <td className="actions">
                    {user.role !== 'agency_owner' && (
                      <button
                        className="link danger"
                        onClick={() => {
                          if (window.confirm(`Remove ${user.name}? They lose access immediately.`)) {
                            act(() => send('DELETE', `/v1/team/users/${user.id}`));
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {invites.map((inv) => (
              <tr key={inv.id}>
                <td className="muted">Invited</td>
                <td className="muted">{inv.email}</td>
                <td>
                  <span className="pill warn">Pending</span> {ROLE_LABEL[inv.role]}
                  {inv.clientName && <span className="muted"> · {inv.clientName}</span>}
                </td>
                {isOwner && (
                  <td className="actions">
                    <button className="link danger" onClick={() => act(() => send('DELETE', `/v1/team/invites/${inv.id}`))}>
                      Cancel invite
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
