import type { ReactNode } from 'react';
import { Brand, initials } from './Brand';
import { NavLinks, SignOutButton } from './Shell';
import type { Tenant, Session } from '@/lib/types';

/** Header and navigation for the super admin pages on the platform's own address. */
export function AdminShell({ tenant, session, children }: { tenant: Tenant; session: Session; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Brand tenant={tenant} href="/admin" />
        <NavLinks
          items={[
            { href: '/admin', label: 'Agencies', icon: 'building', exact: true },
            { href: '/admin/plans', label: 'Plans', icon: 'layers' },
            { href: '/admin/costs', label: 'Costs', icon: 'coins' },
            { href: '/admin/settings', label: 'API keys', icon: 'key' },
          ]}
        />
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
      <main>{children}</main>
    </div>
  );
}
