import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One .env at the repository root serves both apps.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Keeps the development badge out of the corner of screenshots.
  devIndicators: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      // Nothing may be shown inside another site's frame, so a page cannot be
      // overlaid to trick someone into clicking. The audit form is the exception:
      // agencies embed it on their own websites.
      {
        source: '/((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
      { source: '/embed/:path*', headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }] },
      // Shared reports: links in them must not pass the report's address on, and search engines must not list them.
      {
        source: '/r/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/report/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
