import type { ReactNode } from 'react';
import { AppFrame } from './AppFrame';
import { Brand, initials } from './Brand';
import type { Session, Tenant } from '@/lib/types';

/** Frame for the super admin pages on the platform's own address. */
export function AdminShell({ tenant, session, children }: { tenant: Tenant; session: Session; children: ReactNode }) {
  return (
    <AppFrame
      brand={<Brand tenant={tenant} href="/admin" />}
      groups={[
        { heading: 'Platform', items: [{ href: '/admin', label: 'Agencies', icon: 'building', exact: true }] },
        {
          heading: 'Business',
          items: [
            { href: '/admin/plans', label: 'Plans', icon: 'layers' },
            { href: '/admin/costs', label: 'Costs', icon: 'coins' },
          ],
        },
        { heading: 'Setup', items: [{ href: '/admin/settings', label: 'API keys', icon: 'key' }] },
      ]}
      who={{ name: session.user.name, detail: session.user.email, initials: initials(session.user.name) }}
    >
      {children}
    </AppFrame>
  );
}
