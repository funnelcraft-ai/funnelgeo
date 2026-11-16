'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import { ROLE_LABEL, type Client, type TeamInvite, type TeamUser } from '@/lib/types';
import { initials } from './Brand';
import { Icon } from './Icon';
import { PageHead } from './Shell';

interface Props {
  users: TeamUser[];
  invites: TeamInvite[];
  clients: Client[];
  isOwner: boolean;
  selfId: string;
}

export function TeamPanel({ users, invites, clients, isOwner, selfId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<'agency_member' | 'client_viewer'>('agency_member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    setBusy(true);
    setCopied(false);
    try {
      const res = await send<{ inviteUrl: string; emailed: boolean }>('POST', '/v1/team/invites', {
        role,
        email: data.email,
        ...(role === 'client_viewer' ? { clientId: data.clientId } : {}),
      });
      setResult({ email: data.email ?? '', url: res.inviteUrl, emailed: res.emailed });
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
      <PageHead crumbs="Overview / Team" title="Team" sub="People at your agency, and clients you have given a login.">
        {isOwner && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Icon name="plus" />
            Invite someone
          </button>
        )}
      </PageHead>

      {isOwner && open && (
        <form className="card" onSubmit={invite} style={{ marginBottom: 20 }}>
          <div className="card-head">
            <h2>Invite someone</h2>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoFocus />
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
            <button disabled={busy}>
              <Icon name="mail" />
              {busy ? 'Sending…' : 'Send invite'}
            </button>
          </div>
          {result && (
            <div className="notice" style={{ marginTop: 16 }}>
              <p className={result.emailed ? 'success' : 'small'} role="status" style={{ marginBottom: 0 }}>
                {result.emailed
                  ? `Invite emailed to ${result.email}. You can also share this link; it works once and expires in 7 days.`
                  : `The invite for ${result.email} is ready, but the email was not sent. Share this link with them; it works once and expires in 7 days.`}
              </p>
              <div className="copy-box">
                <input type="text" readOnly value={result.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(result.url);
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

      <section className="card flush">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Access</th>
              <th>Last signed in</th>
              {isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="who-cell">
                    <span className="avatar sm" aria-hidden="true">{initials(user.name)}</span>
                    <div>
                      <strong>{user.name}{user.id === selfId && <span style={{ display: 'inline', fontWeight: 400 }}> (you)</span>}</strong>
                      <span>{user.email}</span>
                    </div>
                  </div>
                </td>
                <td>
                  {ROLE_LABEL[user.role]}
                  {user.clientName && <span className="muted"> · {user.clientName}</span>}
                </td>
                <td className="muted">
                  {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'}
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
                <td>
                  <div className="who-cell">
                    <span className="avatar sm neutral" aria-hidden="true"><Icon name="mail" /></span>
                    <div>
                      <strong>{inv.email}</strong>
                      <span>Invite sent</span>
                    </div>
                  </div>
                </td>
                <td>
                  {ROLE_LABEL[inv.role]}
                  {inv.clientName && <span className="muted"> · {inv.clientName}</span>}
                </td>
                <td><span className="pill warn">Pending</span></td>
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
      </section>
    </>
  );
}
