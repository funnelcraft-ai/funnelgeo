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
  button?: string;
  url?: string;
  footnote?: string;
}

function render(brand: Brand, content: Content): { text: string; html: string } {
  const action = content.button && content.url ? ['', `${content.button}: ${content.url}`] : [];
  const text = [content.heading, '', ...content.lines, ...action, ...(content.footnote ? ['', content.footnote] : []), '', brand.name].join('\n');
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
${content.button && content.url ? `<tr><td style="padding:24px 32px 0;"><a href="${escapeHtml(content.url)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:${brand.primaryColor};color:${readableOn(brand.primaryColor)};font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(content.button)}</a></td></tr>` : ''}
<tr><td style="padding:24px 32px 28px;font-size:13px;line-height:1.6;color:#6b7280;">${content.footnote ? escapeHtml(content.footnote) : ''}${content.url ? `${content.footnote ? '<br>' : ''}If the button does not work, paste this link into your browser:<br><a href="${escapeHtml(content.url)}" style="color:#6b7280;word-break:break-all;">${escapeHtml(content.url)}</a>` : ''}</td></tr>
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

/** To the person who asked for an audit on the agency's website. */
export function auditReadyEmail(brand: Brand, input: { to: string; business: string; url: string }): Mail {
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `Your AI visibility report for ${input.business}`,
    ...render(brand, {
      heading: `Your AI visibility report is ready`,
      lines: [
        `We asked ChatGPT, Perplexity and Gemini the questions your customers ask, and checked how ready ${input.business}'s website is for AI search.`,
        'The report shows where you are named, where competitors are named instead, and the first fixes to make.',
      ],
      button: 'Open your report',
      url: input.url,
      footnote: `Sent by ${brand.name} because you asked for this report.`,
    }),
  };
}

/** To the visitor, when their audit could not be run. */
export function leadThanksEmail(brand: Brand, input: { to: string; business: string }): Mail {
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `Your AI visibility report for ${input.business}`,
    ...render(brand, {
      heading: 'Thanks for your request',
      lines: [`We could not prepare the automatic report for ${input.business} this time. The ${brand.name} team will be in touch with you directly.`],
      footnote: `Sent by ${brand.name} because you asked for an AI visibility report.`,
    }),
  };
}

/** To the agency's owners, for each lead from the website widget. */
export function leadAgencyEmail(
  brand: Brand,
  input: { to: string; lead: { business: string; domain: string; email: string; name: string | null }; url: string; outcome: 'ready' | 'failed' | 'not_run'; reason?: string },
): Mail {
  const who = `${input.lead.name ? `${input.lead.name}, ` : ''}${input.lead.email}`;
  const outcome = {
    ready: `The audit is ready and the report link has been emailed to them.`,
    failed: `The audit could not be completed, so they were told your team will be in touch.`,
    not_run: `The audit did not run${input.reason ? `: ${input.reason}` : ''}. They were told your team will be in touch.`,
  }[input.outcome];
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `New lead: ${input.lead.business}`,
    ...render(brand, {
      heading: `New lead from your website`,
      lines: [`${input.lead.business} (${input.lead.domain}) asked for an AI visibility report. Contact: ${who}.`, outcome],
      button: input.outcome === 'ready' ? 'Open the audit' : 'Open leads',
      url: input.url,
    }),
  };
}
