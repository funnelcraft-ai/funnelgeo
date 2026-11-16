import { agencyHost, config, originFor } from './config.js';
import type { Mail } from './mailer.js';
import type { Tenant } from './tenant.js';

/** Who an email appears to come from. Agency emails never mention the platform. */
export interface Brand {
  name: string;
  fromName: string;
  origin: string;
  primaryColor: string;
  logoUrl: string | null;
}

const DEFAULT_PRIMARY = '#2450e6';

export function brandFor(tenant: Tenant): Brand {
  if (tenant.kind === 'agency') {
    const { agency } = tenant;
    const origin = originFor(agencyHost(agency));
    const logo = agency.branding.logoUrl;
    return {
      name: agency.name,
      fromName: agency.branding.senderName ?? agency.name,
      origin,
      primaryColor: agency.branding.primaryColor ?? DEFAULT_PRIMARY,
      // Uploaded logos are stored as a path on the workspace's own address.
      logoUrl: logo ? (logo.startsWith('/') ? `${origin}${logo}` : logo) : null,
    };
  }
  return {
    name: config.platformName,
    fromName: config.platformName,
    origin: originFor(config.platformDomain),
    primaryColor: DEFAULT_PRIMARY,
    logoUrl: null,
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Black or white, whichever reads better on the given background colour. */
function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#16181d' : '#ffffff';
}

interface Content {
  heading: string;
  lines: string[];
  button: string;
  url: string;
  footnote: string;
}

function render(brand: Brand, content: Content): { text: string; html: string } {
  const text = [content.heading, '', ...content.lines, '', `${content.button}: ${content.url}`, '', content.footnote, '', brand.name].join('\n');
  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="32" style="height:32px;max-width:180px;border:0;">`
    : `<span style="font-size:18px;font-weight:700;color:#16181d;">${escapeHtml(brand.name)}</span>`;
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e6e8ec;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16181d;">
<tr><td style="padding:28px 32px 0;">${header}</td></tr>
<tr><td style="padding:24px 32px 0;font-size:20px;font-weight:700;line-height:1.3;">${escapeHtml(content.heading)}</td></tr>
${content.lines.map((line) => `<tr><td style="padding:12px 32px 0;font-size:15px;line-height:1.6;color:#3d4350;">${escapeHtml(line)}</td></tr>`).join('\n')}
<tr><td style="padding:24px 32px 0;"><a href="${escapeHtml(content.url)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:${brand.primaryColor};color:${readableOn(brand.primaryColor)};font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(content.button)}</a></td></tr>
<tr><td style="padding:24px 32px 28px;font-size:13px;line-height:1.6;color:#6b7280;">${escapeHtml(content.footnote)}<br>If the button does not work, paste this link into your browser:<br><a href="${escapeHtml(content.url)}" style="color:#6b7280;word-break:break-all;">${escapeHtml(content.url)}</a></td></tr>
</table></td></tr></table>
</body></html>`;
  return { text, html };
}

export function inviteEmail(brand: Brand, input: { to: string; inviterName: string; clientName: string | null; url: string }): Mail {
  const access = input.clientName
    ? `${input.inviterName} has given you access to the ${input.clientName} dashboard and reports.`
    : `${input.inviterName} has invited you to join the ${brand.name} team workspace.`;
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: input.clientName ? `Your ${brand.name} dashboard is ready` : `Join ${brand.name}`,
    ...render(brand, {
      heading: input.clientName ? 'Your dashboard is ready' : `You are invited to ${brand.name}`,
      lines: [access, 'Choose your name and a password to get started.'],
      button: 'Accept invite',
      url: input.url,
      footnote: 'This link works once and expires in 7 days.',
    }),
  };
}

export function resetEmail(brand: Brand, input: { to: string; url: string }): Mail {
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `Reset your ${brand.name} password`,
    ...render(brand, {
      heading: 'Reset your password',
      lines: [`We received a request to reset the password for your ${brand.name} account.`],
      button: 'Choose a new password',
      url: input.url,
      footnote: 'This link works once and expires in 1 hour. If you did not ask for it, you can ignore this email; your password stays the same.',
    }),
  };
}
