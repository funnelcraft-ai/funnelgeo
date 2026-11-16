import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { LogoutButton } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { getSession, getTenant } from '@/lib/server';
import { ROLE_LABEL } from '@/lib/types';

/** Shell for signed-in agency and client users. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  if (tenant.kind === 'platform') redirect('/admin');
  const session = await getSession();
  if (!session) redirect('/login');

  const { role } = session.user;
  const isStaff = role === 'agency_owner' || role === 'agency_member';

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand tenant={tenant} href="/clients" />
          <nav className="nav" aria-label="Main">
            <a href="/clients">{isStaff ? 'Clients' : 'Overview'}</a>
            {isStaff && <a href="/team">Team</a>}
            {role === 'agency_owner' && <a href="/settings">Settings</a>}
          </nav>
          <div className="who">
            <span>
              {session.user.name} · {ROLE_LABEL[role]}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="main">{children}</main>
    </>
  );
}
