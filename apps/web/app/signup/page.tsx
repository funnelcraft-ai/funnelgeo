import { notFound } from 'next/navigation';
import { SignupForm } from '@/components/AuthForms';
import { AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { getTenant } from '@/lib/server';
import { SIGNUP_SECTIONS } from '@/lib/signup-copy';

export const metadata = { title: 'Create your workspace' };

export default async function SignupPage() {
  const tenant = await getTenant();
  // New agencies are created only from the platform's own address.
  if (tenant?.kind !== 'platform') notFound();
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
