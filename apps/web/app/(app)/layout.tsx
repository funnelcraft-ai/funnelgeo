import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Brand, initials } from '@/components/Brand';
import { NavLinks, SignOutButton, type NavItem } from '@/components/Shell';
import { getSession, getTenant } from '@/lib/server';
import { ROLE_LABEL } from '@/lib/types';

/** Shell for signed-in agency and client users. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  if (tenant.kind === 'platform') redirect('/admin');
  const session = await getSession();
  if (!session) redirect('/login');

  const { role, name } = session.user;
  const isStaff = role === 'agency_owner' || role === 'agency_member';
  const items: NavItem[] = [{ href: '/clients', label: 'Overview', icon: 'grid' }];
  if (isStaff) items.push({ href: '/audits', label: 'Audits', icon: 'target' }, { href: '/team', label: 'Team', icon: 'users' }, { href: '/usage', label: 'Usage', icon: 'gauge' });
  if (role === 'agency_owner') items.push({ href: '/settings', label: 'Settings', icon: 'sliders' });

  return (
    <div className="shell">
      <header className="topbar">
        <Brand tenant={tenant} href="/clients" />
        <NavLinks items={items} />
        <div className="top-right">
          <div className="user">
            <span className="avatar" aria-hidden="true">{initials(name)}</span>
            <span className="user-text">
              <strong>{name}</strong>
              <span>{ROLE_LABEL[role]}</span>
            </span>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
