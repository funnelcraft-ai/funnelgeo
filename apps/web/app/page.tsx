import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/AuthForms';
import { AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { getSession, getTenant } from '@/lib/server';
import { SIGNUP_SECTIONS } from '@/lib/signup-copy';

export default async function Home() {
  const tenant = await getTenant();
  if (!tenant) return null; // the root layout shows "Workspace not found"
  const session = await getSession();

  if (tenant.kind === 'agency') redirect(session ? '/clients' : '/login');
  if (session) redirect('/admin');

  // The platform's own address: the only place the platform identity appears.
  return (
    <AuthLayout
      tenant={tenant}
      headline={<>Grow your clients’ visibility in AI search.</>}
      sections={SIGNUP_SECTIONS}
      card={
        <>
          <AuthCardHead title="Create your workspace" sub="Takes about a minute. Your logo and domain come next." alt={{ href: '/login', label: 'Sign in' }} />
          <SignupForm />
        </>
      }
    />
  );
}
