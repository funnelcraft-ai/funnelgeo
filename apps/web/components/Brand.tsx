import type { Tenant } from '@/lib/types';

/** The agency's logo if it has one, otherwise its name. */
export function Brand({ tenant, href }: { tenant: Tenant; href?: string }) {
  const logo = tenant.kind === 'agency' ? tenant.branding.logoUrl : undefined;
  const inner = logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logo} alt={tenant.name} />
  ) : (
    <span>{tenant.name}</span>
  );
  return href ? (
    <a className="brand" href={href}>
      {inner}
    </a>
  ) : (
    <div className="brand">{inner}</div>
  );
}
