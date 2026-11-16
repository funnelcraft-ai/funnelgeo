import { notFound } from 'next/navigation';
import { SignupForm } from '@/components/AuthForms';
import { getTenant } from '@/lib/server';

export default async function SignupPage() {
  const tenant = await getTenant();
  // New agencies are created only from the platform's own address.
  if (tenant?.kind !== 'platform') notFound();
  return (
    <main className="center">
      <div className="auth-card">
        <a className="brand" href="/">{tenant.name}</a>
        <h1>Create your workspace</h1>
        <p className="muted">Takes about a minute. You can add your logo and domain next.</p>
        <SignupForm />
      </div>
    </main>
  );
}
