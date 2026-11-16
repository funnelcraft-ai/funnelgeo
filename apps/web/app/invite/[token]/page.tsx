import { AcceptInviteForm } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { apiGet, getTenant } from '@/lib/server';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const { token } = await params;
  const data = await apiGet<{ invite: { email: string } }>(`/v1/invites/${encodeURIComponent(token)}`);

  return (
    <main className="center">
      <div className="auth-card">
        <Brand tenant={tenant} />
        {data ? (
          <>
            <h1>Join {tenant.name}</h1>
            <p className="muted">Set your name and a password to get started.</p>
            <AcceptInviteForm token={token} email={data.invite.email} />
          </>
        ) : (
          <>
            <h1>This invite is no longer valid</h1>
            <p className="muted">It may have expired or already been used. Ask for a new invite, or sign in if you already have an account.</p>
            <a className="button block" href="/login">Go to sign in</a>
          </>
        )}
      </div>
    </main>
  );
}
