import { ForgotForm } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { getTenant } from '@/lib/server';

export default async function ForgotPage() {
  const tenant = await getTenant();
  if (!tenant) return null;
  return (
    <main className="center">
      <div className="auth-card">
        <Brand tenant={tenant} />
        <h1>Reset your password</h1>
        <p className="muted">Enter the email you sign in with and we will send you a link.</p>
        <ForgotForm />
      </div>
    </main>
  );
}
