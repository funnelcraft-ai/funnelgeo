import { notFound, redirect } from 'next/navigation';
import { AdminPanel } from '@/components/AdminPanel';
import { Brand, initials } from '@/components/Brand';
import { NavLinks, SignOutButton } from '@/components/Shell';
import { apiGet, getSession, getTenant } from '@/lib/server';
import type { AdminAgency, Plan } from '@/lib/types';

export default async function AdminPage() {
  const tenant = await getTenant();
  // Platform administration exists only on the platform's own address.
  if (tenant?.kind !== 'platform') notFound();
  const session = await getSession();
  if (!session) redirect('/login');

  const [agencies, plans] = await Promise.all([
    apiGet<{ agencies: AdminAgency[] }>('/v1/admin/agencies'),
    apiGet<{ plans: Plan[] }>('/v1/admin/plans'),
  ]);

  return (
    <div className="shell">
      <header className="topbar">
        <Brand tenant={tenant} href="/admin" />
        <NavLinks items={[{ href: '/admin', label: 'Agencies', icon: 'building' }]} />
        <div className="top-right">
          <div className="user">
            <span className="avatar" aria-hidden="true">{initials(session.user.name)}</span>
            <span className="user-text">
              <strong>{session.user.name}</strong>
              <span>{session.user.email}</span>
            </span>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main>
        <AdminPanel agencies={agencies?.agencies ?? []} plans={plans?.plans ?? []} />
      </main>
    </div>
  );
}
