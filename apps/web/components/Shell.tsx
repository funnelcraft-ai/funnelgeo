'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { send } from '@/lib/client';
import { Icon, type IconName } from './Icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {items.map((item) => (
        <a key={item.href} href={item.href} aria-current={pathname.startsWith(item.href) ? 'page' : undefined}>
          <Icon name={item.icon} />
          {item.label}
        </a>
      ))}
    </nav>
  );
}

export function SignOutButton() {
  return (
    <button
      className="icon-button"
      title="Sign out"
      aria-label="Sign out"
      onClick={async () => {
        await send('POST', '/v1/auth/logout').catch(() => {});
        window.location.assign('/login');
      }}
    >
      <Icon name="logout" />
    </button>
  );
}

/** Greets by the visitor's own clock, so it is right in any time zone. */
export function Greeting({ name }: { name: string }) {
  const [part, setPart] = useState('Welcome back');
  useEffect(() => {
    const hour = new Date().getHours();
    setPart(hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
  }, []);
  return (
    <h1>
      {part}, {name}.
    </h1>
  );
}

export function PageHead({ crumbs, title, sub, children }: { crumbs: string; title: ReactNode; sub?: string; children?: ReactNode }) {
  return (
    <>
      <p className="crumbs">{crumbs}</p>
      <div className="page-head">
        <div>
          {typeof title === 'string' ? <h1>{title}</h1> : title}
          {sub && <p className="sub">{sub}</p>}
        </div>
        {children && <div className="toolbar">{children}</div>}
      </div>
    </>
  );
}
