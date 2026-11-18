import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppFrame, type NavGroup, type NavItem } from '@/components/AppFrame';
import { Brand, initials } from '@/components/Brand';
import { Icon } from '@/components/Icon';
import { apiGet, getSession, getTenant } from '@/lib/server';
import { ROLE_LABEL, type Client, type Usage } from '@/lib/types';

/** Frame for signed-in agency staff and client viewers. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  if (tenant.kind === 'platform') redirect('/admin');
  const session = await getSession();
  if (!session) redirect('/login');

  const { role, name } = session.user;
  const isStaff = role === 'agency_owner' || role === 'agency_member';
  const [clients, usage] = await Promise.all([
    apiGet<{ clients: Client[] }>('/v1/clients'),
    isStaff ? apiGet<Usage>('/v1/usage') : Promise.resolve(null),
  ]);

  const groups: NavGroup[] = [{ heading: 'Main', items: [{ href: '/clients', label: 'Overview', icon: 'grid' }] }];
  if (isStaff) {
    groups.push(
      { heading: 'Growth', items: [{ href: '/audits', label: 'Audits', icon: 'target' }] },
      {
        heading: 'Workspace',
        items: [
          { href: '/team', label: 'Team', icon: 'users' },
          { href: '/usage', label: 'Usage', icon: 'gauge' },
          ...(role === 'agency_owner' ? [{ href: '/settings', label: 'Settings', icon: 'settings' } as NavItem] : []),
        ],
      },
    );
  }

  const pct = usage ? Math.min(100, Math.round(usage.percentUsed * 100)) : 0;
  const foot = usage ? (
    <a className="drawer-card clickable" href="/usage" style={{ display: 'block', textDecoration: 'none' }}>
      <strong>Credits this month</strong>
      {usage.used.toLocaleString('en-IN')} of {usage.available.toLocaleString('en-IN')} used
      <div className="bar"><span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : undefined }} /></div>
      <span className="muted">{usage.plan} plan</span>
    </a>
  ) : undefined;

  return (
    <AppFrame
      brand={<Brand tenant={tenant} href="/clients" />}
      groups={groups}
      who={{ name, detail: ROLE_LABEL[role], initials: initials(name) }}
      menuLinks={role === 'agency_owner' ? [{ href: '/settings', label: 'Workspace settings', icon: 'settings' }] : []}
      drawerFoot={foot}
      search={{
        placeholder: 'Search clients',
        items: (clients?.clients ?? []).map((c) => ({ href: `/clients/${c.id}`, title: c.name, detail: c.domain ?? '' })),
      }}
      actions={isStaff ? <a className="button tonal sm hide-sm" href="/audits/new"><Icon name="plus" />New audit</a> : undefined}
    >
      {children}
    </AppFrame>
  );
}
