import { ResetForm } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { apiGet, getTenant } from '@/lib/server';

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const { token } = await params;
  const data = await apiGet<{ email: string }>(`/v1/auth/reset/${encodeURIComponent(token)}`);

  return (
    <main className="center">
      <div className="auth-card">
        <Brand tenant={tenant} />
        {data ? (
          <>
            <h1>Choose a new password</h1>
            <p className="muted">You will be signed in as soon as it is saved.</p>
            <ResetForm token={token} email={data.email} next={tenant.kind === 'platform' ? '/admin' : '/clients'} />
          </>
        ) : (
          <>
            <h1>This link is no longer valid</h1>
            <p className="muted">Reset links work once and expire after an hour. Request a new one to continue.</p>
            <a className="button block" href="/forgot">Request a new link</a>
          </>
        )}
      </div>
    </main>
  );
}
