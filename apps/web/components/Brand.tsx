import type { Tenant } from '@/lib/types';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/**
 * On an agency's address: the agency's logo, or its name with a monogram.
 * On the platform's own address: the Funnelcraft logo and the product name.
 * The platform identity is never rendered on an agency's address.
 */
export function Brand({ tenant, href }: { tenant: Tenant; href?: string }) {
  let inner;
  if (tenant.kind === 'platform') {
    inner = (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/funnelcraft-logo.png" alt="Funnelcraft" style={{ height: 20, maxHeight: 20 }} />
        <span className="product">{tenant.name}</span>
      </>
    );
  } else if (tenant.branding.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    inner = <img src={tenant.branding.logoUrl} alt={tenant.name} />;
  } else {
    inner = (
      <>
        <span className="brand-mark" aria-hidden="true">{initials(tenant.name)}</span>
        <span>{tenant.name}</span>
      </>
    );
  }
  return href ? (
    <a className="brand" href={href}>{inner}</a>
  ) : (
    <div className="brand">{inner}</div>
  );
}
