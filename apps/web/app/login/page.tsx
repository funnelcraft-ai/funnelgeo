import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { getSession, getTenant } from '@/lib/server';

export default async function LoginPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  const home = tenant.kind === 'platform' ? '/admin' : '/clients';
  if (await getSession()) redirect(home);

  return (
    <main className="center">
      <div className="auth-card">
        <Brand tenant={tenant} />
        <h1>Sign in</h1>
        {tenant.kind === 'agency' && tenant.suspended ? (
          <p className="error">This workspace is suspended. Contact your account manager.</p>
        ) : (
          <>
            <p className="muted">{tenant.kind === 'platform' ? 'Platform administrators only.' : 'Use the email you were invited with.'}</p>
            <LoginForm next={home} />
          </>
        )}
      </div>
    </main>
  );
}
