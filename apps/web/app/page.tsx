import { redirect } from 'next/navigation';
import { getSession, getTenant } from '@/lib/server';

export default async function Home() {
  const tenant = await getTenant();
  if (!tenant) return null; // the root layout shows "Workspace not found"
  const session = await getSession();

  if (tenant.kind === 'agency') redirect(session ? '/clients' : '/login');
  if (session) redirect('/admin');

  // The platform's own address: the only place the platform name appears.
  return (
    <main className="center">
      <div className="auth-card">
        <div className="brand">{tenant.name}</div>
        <h1>Run AI visibility services under your own brand</h1>
        <p className="muted">
          Create a workspace for your agency. Your clients see your name, your colours and your domain.
        </p>
        <p>
          <a className="button block" href="/signup">Create your workspace</a>
        </p>
        <p className="small muted">
          Already have a workspace? Sign in at your workspace address. <a href="/login">Platform admin sign in</a>
        </p>
      </div>
    </main>
  );
}
