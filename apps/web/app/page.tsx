import { redirect } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { Icon } from '@/components/Icon';
import { getSession, getTenant } from '@/lib/server';

const POINTS = [
  'Your name, logo, colours and domain on every screen and email',
  'Separate, private workspaces for each of your clients',
  'Logins for your team and read-only access for clients',
];

export default async function Home() {
  const tenant = await getTenant();
  if (!tenant) return null; // the root layout shows "Workspace not found"
  const session = await getSession();

  if (tenant.kind === 'agency') redirect(session ? '/clients' : '/login');
  if (session) redirect('/admin');

  // The platform's own address: the only place the platform identity appears.
  return (
    <main className="center">
      <div className="auth-card wide landing">
        <Brand tenant={tenant} />
        <h1>Sell AI visibility services under your own brand</h1>
        <p className="muted">
          {tenant.name} gives your agency a workspace to find where clients are missing from AI answers, fix it, and show what changed.
        </p>
        <ul className="points">
          {POINTS.map((point) => (
            <li key={point}>
              <span className="tick"><Icon name="check" /></span>
              {point}
            </li>
          ))}
        </ul>
        <a className="button block" href="/signup">
          Create your workspace
          <Icon name="arrow" />
        </a>
        <p className="auth-foot">
          Already have a workspace? Sign in at your workspace address. <a href="/login">Platform admin</a>
        </p>
      </div>
    </main>
  );
}
