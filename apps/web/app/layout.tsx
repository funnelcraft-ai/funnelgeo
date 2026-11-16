import type { CSSProperties, ReactNode } from 'react';
import type { Metadata } from 'next';
import { getTenant } from '@/lib/server';
import './globals.css';

export const dynamic = 'force-dynamic';

// The tab title and icon are the agency's, never the platform's.
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenant();
  if (!tenant) return { title: 'Not found' };
  const favicon = tenant.kind === 'agency' ? tenant.branding.faviconUrl : undefined;
  return { title: tenant.name, icons: favicon ? [{ url: favicon }] : undefined };
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
  const style: Record<string, string> = {};
  if (tenant?.kind === 'agency') {
    const { primaryColor, accentColor } = tenant.branding;
    if (primaryColor) {
      style['--primary'] = primaryColor;
      style['--on-primary'] = readableOn(primaryColor);
    }
    if (accentColor) style['--accent'] = accentColor;
  }

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
