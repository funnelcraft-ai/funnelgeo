import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/AuthForms';
import { AGENCY_SECTIONS, AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { getSession, getTenant } from '@/lib/server';
import { SIGNUP_SECTIONS } from '@/lib/signup-copy';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  const home = tenant.kind === 'platform' ? '/admin' : '/clients';
  if (await getSession()) redirect(home);
  const platform = tenant.kind === 'platform';

  return (
    <AuthLayout
      tenant={tenant}
      headline={platform ? <>AI search visibility, sold under your brand.</> : <>See how AI answers talk about you.</>}
      sections={platform ? SIGNUP_SECTIONS.slice(0, 1) : AGENCY_SECTIONS}
      card={
        <>
          <AuthCardHead
            title="Sign in"
            sub={platform ? 'Platform administrators. Agencies sign in at their own workspace address.' : 'Use the email you were invited with.'}
            alt={platform ? { href: '/signup', label: 'Create a workspace' } : undefined}
          />
          {tenant.kind === 'agency' && tenant.suspended ? (
            <p className="error">This workspace is suspended. Contact your account manager.</p>
          ) : (
            <LoginForm next={home} />
          )}
        </>
      }
    />
  );
}
