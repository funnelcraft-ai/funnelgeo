'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import { Icon, type IconName } from './Icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Active only on this exact path, not on pages below it. */
  exact?: boolean;
}
export interface NavGroup {
  heading?: string;
  items: NavItem[];
}
export interface Who {
  name: string;
  detail: string;
  initials: string;
}

/**
 * The signed-in frame: a navigation drawer (modal on narrow screens) and a top
 * app bar with search and the account menu. Used by agency and super admin pages.
 */
export function AppFrame({
  brand,
  groups,
  who,
  menuLinks = [],
  drawerFoot,
  search,
  actions,
  children,
}: {
  brand: ReactNode;
  groups: NavGroup[];
  who: Who;
  menuLinks?: NavItem[];
  drawerFoot?: ReactNode;
  search?: { placeholder: string; items: { href: string; title: string; detail: string }[] };
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className={`app${open ? ' drawer-open' : ''}`}>
      <aside className="drawer" aria-label="Navigation">
        <div className="drawer-head">
          {brand}
          <button className="icon-button close" aria-label="Close navigation" onClick={() => setOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="Main">
          {groups.map((group, i) => (
            <div className="nav-group" key={group.heading ?? i}>
              {group.heading && <span className="nav-heading">{group.heading}</span>}
              {group.items.map((item) => {
                const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <a key={item.href} className="nav-item" href={item.href} aria-current={active ? 'page' : undefined}>
                    <Icon name={item.icon} filled={active} />
                    {item.label}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        {drawerFoot && <div className="drawer-foot">{drawerFoot}</div>}
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setOpen(true)}>
            <Icon name="menu" />
          </button>
          {search && <TopSearch {...search} />}
          <div className="top-right">
            {actions}
            <AccountMenu who={who} links={menuLinks} />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

/** Jump-to search over a short list (clients). */
function TopSearch({ placeholder, items }: { placeholder: string; items: { href: string; title: string; detail: string }[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 6);
    return items.filter((i) => i.title.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q)).slice(0, 8);
  }, [items, query]);
  useEffect(() => setIndex(0), [query]);

  return (
    <div className="top-search" role="search">
      <Icon name="search" />
      <label className="sr-only" htmlFor="top-search">{placeholder}</label>
      <input
        id="top-search"
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && matches[index]) router.push(matches[index]!.href);
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        role="combobox"
        aria-expanded={focused}
        aria-controls="top-search-results"
      />
      {focused && (
        <ul className="search-results" id="top-search-results" role="listbox">
          {matches.length === 0 ? (
            <li><p className="muted">No client matches “{query}”.</p></li>
          ) : (
            matches.map((m, i) => (
              <li key={m.href}>
                <a href={m.href} role="option" aria-selected={i === index}>
                  <Icon name="clients" />
                  <div>
                    <div>{m.title}</div>
                    <span>{m.detail}</span>
                  </div>
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function AccountMenu({ who, links }: { who: Who; links: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="account" ref={ref}>
      <button className="account-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar sm" aria-hidden="true">{who.initials}</span>
        <span className="user-text">
          <strong>{who.name}</strong>
          <span>{who.detail}</span>
        </span>
        <Icon name="expand" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{who.name}</strong>
            <span>{who.detail}</span>
          </div>
          {links.map((l) => (
            <a key={l.href} className="menu-item" role="menuitem" href={l.href}>
              <Icon name={l.icon} />
              {l.label}
            </a>
          ))}
          <button
            className="menu-item"
            role="menuitem"
            onClick={async () => {
              await send('POST', '/v1/auth/logout').catch(() => {});
              window.location.assign('/login');
            }}
          >
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
