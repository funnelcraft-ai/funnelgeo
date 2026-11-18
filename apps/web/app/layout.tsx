import type { CSSProperties, ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTenant } from '@/lib/server';
import '@fontsource-variable/roboto-flex/opsz.css';
import { themeVars } from '@/lib/theme';
import './globals.css';

export const dynamic = 'force-dynamic';

// The tab title and icon are the agency's, never the platform's.
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenant();
  if (!tenant) return { title: 'Not found' };
  const branding = tenant.kind === 'agency' ? tenant.branding : {};
  return { title: tenant.name, icons: [{ url: branding.faviconUrl ?? monogramIcon(tenant.name, branding.primaryColor ?? '#1d2024') }] };
}

/** A tab icon made from the name's first letter, used until a favicon is uploaded. */
function monogramIcon(name: string, color: string): string {
  const letter = (name.trim()[0] ?? '?').toUpperCase().replace(/[<>&"']/g, '?');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="44" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="${readableOn(color)}">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Black or white, whichever reads better on the given background. */
function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? '#16181d' : '#ffffff';
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const tenant = await getTenant();
  // Material 3 colour roles from the agency's brand colour; charcoal on the platform's own pages.
  const branding = tenant?.kind === 'agency' ? tenant.branding : null;
  const style = themeVars(branding?.primaryColor, branding?.accentColor);

  return (
    <html lang="en">
      <body style={style as CSSProperties}>
        {tenant ? (
          children
        ) : (
          <main className="center">
            <div className="auth-card">
              <h1>Workspace not found</h1>
              <p className="muted">There is no workspace at this address. Check the link and try again.</p>
            </div>
          </main>
        )}
      </body>
    </html>
  );
}
