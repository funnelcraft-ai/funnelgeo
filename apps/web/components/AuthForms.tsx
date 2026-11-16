'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { send } from '@/lib/client';

function useSubmit() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return { error, busy, run };
}

function values(event: FormEvent<HTMLFormElement>): Record<string, string> {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
}

export function LoginForm({ next }: { next: string }) {
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        const v = values(e);
        run(async () => {
          await send('POST', '/v1/auth/login', { email: v.email, password: v.password });
          window.location.assign(next);
        });
      }}
    >
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}

export function SignupForm() {
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        const v = values(e);
        run(async () => {
          const res = await send<{ workspaceUrl: string }>('POST', '/v1/signup', {
            agencyName: v.agencyName,
            name: v.name,
            email: v.email,
            password: v.password,
          });
          // Continue on the new workspace's own address, where the session lives.
          window.location.assign(res.workspaceUrl);
        });
      }}
    >
      <div className="field">
        <label htmlFor="agencyName">Agency name</label>
        <input id="agencyName" name="agencyName" type="text" required minLength={2} maxLength={120} autoFocus />
        <p className="hint">Your clients will see this name. You can change it later.</p>
      </div>
      <div className="field">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" type="text" autoComplete="name" required maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <p className="hint">At least 10 characters.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="block" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</button>
    </form>
  );
}

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const { error, busy, run } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        const v = values(e);
        run(async () => {
          await send('POST', '/v1/invites/accept', { token, name: v.name, password: v.password });
          window.location.assign('/clients');
        });
      }}
    >
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} readOnly autoComplete="username" />
      </div>
      <div className="field">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" type="text" autoComplete="name" required maxLength={120} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Choose a password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <p className="hint">At least 10 characters.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="block" disabled={busy}>{busy ? 'Setting up…' : 'Join workspace'}</button>
    </form>
  );
}

/** Exchanges the one-minute signup token for a session on this hostname. */
export function Handoff({ token }: { token: string }) {
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    send('POST', '/v1/auth/handoff', { token })
      .then(() => window.location.replace('/clients'))
      .catch((err: Error) => setError(err.message));
  }, [token]);

  if (!error) return <p className="muted">Opening your workspace…</p>;
  return (
    <>
      <p className="error" role="alert">{error}</p>
      <a className="button block" href="/login">Go to sign in</a>
    </>
  );
}

export function LogoutButton() {
  return (
    <button
      className="link"
      onClick={async () => {
        await send('POST', '/v1/auth/logout').catch(() => {});
        window.location.assign('/login');
      }}
    >
      Sign out
    </button>
  );
}
