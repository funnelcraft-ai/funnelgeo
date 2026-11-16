import { redirect } from 'next/navigation';
import { Handoff } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { getTenant } from '@/lib/server';

export default async function HandoffPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const { token } = await searchParams;
  if (!token) redirect('/login');
  return (
    <main className="center">
      <div className="auth-card">
        <Brand tenant={tenant} />
        <Handoff token={token} />
      </div>
    </main>
  );
}
