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

export interface RunSummary {
  client: string;
  demo: boolean;
  answers: number;
  named: number;
  previous: { answers: number; named: number } | null;
  questions: number;
  lost: number;
  newlyLost: string[];
  newlyWon: string[];
  causes: { question: string; sentence: string }[];
  gaps: { count: number; top: string[] };
  newActions: number;
}

const quoted = (items: string[], max = 3) =>
  items.slice(0, max).map((q) => `“${q}”`).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '');

/** To the agency after each completed run of a tracked client. */
export function runSummaryEmail(brand: Brand, input: RunSummary & { to: string; url: string }): Mail {
  const rate = `${input.named} of ${input.answers}`;
  const before = input.previous
    ? (() => {
        const was = `${input.previous.named} of ${input.previous.answers}`;
        const now = input.answers ? input.named / input.answers : 0;
        const then = input.previous.answers ? input.previous.named / input.previous.answers : 0;
        return now > then ? ` That is up from ${was} last run.` : now < then ? ` That is down from ${was} last run.` : ` The same share as last run (${was}).`;
      })()
    : ' This is the first completed run.';
  const lines = [
    `${input.client} was named in ${rate} AI answers.${before}`,
    input.lost === 0
      ? `No questions were lost to a competitor this run.`
      : `${input.lost} of ${input.questions} questions were lost to a competitor.`,
  ];
  if (input.newlyLost.length) lines.push(`Newly lost: ${quoted(input.newlyLost)}.`);
  if (input.newlyWon.length) lines.push(`Newly won: ${quoted(input.newlyWon)}.`);
  for (const c of input.causes.slice(0, 3)) lines.push(`“${c.question}”: ${c.sentence}`);
  if (input.gaps.count > 0) {
    lines.push(
      `${input.gaps.count} ${input.gaps.count === 1 ? 'site cites' : 'sites cite'} competitors in answers where ${input.client} is missing, led by ${input.gaps.top.slice(0, 3).join(', ')}.`,
    );
  }
  if (input.newActions > 0) lines.push(`${input.newActions} new suggested ${input.newActions === 1 ? 'action is' : 'actions are'} waiting in the queue for approval.`);
  if (input.demo) lines.push('These results are demo data: the engines were in mock mode.');
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `${input.demo ? '[Demo] ' : ''}${input.client}: named in ${rate} AI answers`,
    ...render(brand, {
      heading: `${input.client}: run complete`,
      lines,
      button: 'Open the diagnosis',
      url: input.url,
      footnote: `Sent after every completed run. Agency owners can change who receives these in Settings.`,
    }),
  };
}

/** To the client: the monthly report, from the agency, with the PDF attached. */
export function clientReportEmail(brand: Brand, input: { to: string; client: string; period: string; url: string; pdf: Buffer; filename: string }): Mail {
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `${input.client}: AI visibility report for ${input.period}`,
    attachments: [{ filename: input.filename, content: input.pdf, contentType: 'application/pdf' }],
    ...render(brand, {
      heading: `Your AI visibility report for ${input.period}`,
      lines: [
        `Here is ${input.client}’s report for ${input.period}: how often AI assistants named ${input.client}, what we did, and what changed afterwards.`,
        'The PDF is attached. The link below opens the same report in your browser.',
      ],
      button: 'Open the report',
      url: input.url,
      footnote: `Sent by ${brand.name}.`,
    }),
  };
}

/** To the agency's owners: monthly drafts are waiting for review. */
export function reportsReadyEmail(brand: Brand, input: { to: string; period: string; clients: string[]; url: string }): Mail {
  const n = input.clients.length;
  return {
    to: input.to,
    fromName: brand.fromName,
    subject: `${n} ${n === 1 ? 'report' : 'reports'} for ${input.period} ready to review`,
    ...render(brand, {
      heading: `Monthly reports for ${input.period}`,
      lines: [
        `Drafts are ready for ${n === 1 ? input.clients[0] : `${n} clients: ${input.clients.slice(0, 5).join(', ')}${n > 5 ? ` and ${n - 5} more` : ''}`}.`,
        'Each has an AI-written summary to check and edit. Nothing is sent to a client until someone on your team approves it.',
      ],
      button: 'Review the reports',
      url: input.url,
    }),
  };
}
