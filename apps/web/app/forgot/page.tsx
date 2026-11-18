import { ForgotForm } from '@/components/AuthForms';
import { AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { getTenant } from '@/lib/server';

export const metadata = { title: 'Reset your password' };

export default async function ForgotPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  return (
    <AuthLayout
      tenant={tenant}
      headline={<>Locked out? It happens.</>}
      card={
        <>
          <AuthCardHead title="Reset your password" sub="Enter the email you sign in with and we’ll send you a link." alt={{ href: '/login', label: 'Sign in' }} />
          <ForgotForm />
        </>
      }
    />
  );
}
