'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { send, uploadImage } from '@/lib/client';
import type { Agency } from '@/lib/types';
import { Icon } from './Icon';
import { PageHead } from './Shell';

const DEFAULT_PRIMARY = '#2450e6';
const DEFAULT_ACCENT = '#8b5cf6';

export function SettingsPanel({ initial }: { initial: Agency }) {
  const [agency, setAgency] = useState(initial);
  return (
    <>
      <PageHead crumbs="Overview / Settings" title="Settings" sub="How your workspace looks and where it lives. Clients only ever see your brand." />
      <div className="stack">
        <BrandingCard agency={agency} onSaved={setAgency} />
        <DomainCard agency={agency} onSaved={setAgency} />
        <AuditSettingsCard agency={agency} onSaved={setAgency} />
        <PlanCard agency={agency} />
      </div>
    </>
  );
}

function ImageUpload({ kind, label, hint, url, onChange }: { kind: 'logo' | 'favicon'; label: string; hint: string; url?: string; onChange: (url?: string) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ error?: string; busy?: boolean }>({});

  async function run(action: () => Promise<string | undefined>) {
    setState({ busy: true });
    try {
      onChange(await action());
      setState({});
      router.refresh(); // show the new image in the page header straight away
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <div className="field">
      <label htmlFor={`${kind}-file`}>{label}</label>
      <div className="uploader">
        <div className={`thumb ${kind === 'favicon' ? 'square' : ''}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url ? <img src={url} alt={`Current ${label.toLowerCase()}`} /> : 'None'}
        </div>
        <div>
          <div className="uploader-actions">
            <input
              id={`${kind}-file`}
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) run(async () => (await uploadImage<{ url: string }>(`/v1/agency/branding/${kind}`, file)).url);
              }}
            />
            <button type="button" className="secondary sm" disabled={state.busy} onClick={() => input.current?.click()}>
              <Icon name="upload" />
              {state.busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}
            </button>
            {url && (
              <button
                type="button"
                className="link danger"
                disabled={state.busy}
                onClick={() => run(async () => { await send('DELETE', `/v1/agency/branding/${kind}`); return undefined; })}
              >
                Remove
              </button>
            )}
          </div>
          <p className="hint">{hint}</p>
          {state.error && <p className="error" role="alert" style={{ margin: '6px 0 0' }}>{state.error}</p>}
        </div>
      </div>
    </div>
  );
}

function BrandingCard({ agency, onSaved }: { agency: Agency; onSaved: (a: Agency) => void }) {
  const router = useRouter();
  const [name, setName] = useState(agency.name);
  const [primary, setPrimary] = useState(agency.branding.primaryColor ?? DEFAULT_PRIMARY);
  const [accent, setAccent] = useState(agency.branding.accentColor ?? DEFAULT_ACCENT);
  const [senderName, setSenderName] = useState(agency.branding.senderName ?? '');
  const [state, setState] = useState<{ error?: string; saved?: boolean; busy?: boolean }>({});

  const setImage = (key: 'logoUrl' | 'faviconUrl') => (url?: string) =>
    onSaved({ ...agency, branding: { ...agency.branding, [key]: url } });

  async function save(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true });
    try {
      const res = await send<{ agency: Agency }>('PATCH', '/v1/agency', {
        name,
        branding: { primaryColor: primary, accentColor: accent, senderName: senderName.trim() || null },
      });
      onSaved(res.agency);
      setState({ saved: true });
      router.refresh(); // re-theme the page with the new colours
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Branding</h2>
          <p className="muted small">Shown on your sign-in page, dashboard, emails and reports.</p>
        </div>
      </div>

      <div className="row top">
        <ImageUpload kind="logo" label="Logo" hint="PNG, JPEG or WebP, up to 1 MB. A wide logo on a transparent background works best." url={agency.branding.logoUrl} onChange={setImage('logoUrl')} />
        <ImageUpload kind="favicon" label="Browser tab icon" hint="A square image, 64 pixels or larger." url={agency.branding.faviconUrl} onChange={setImage('faviconUrl')} />
      </div>

      <hr className="divider" />

      <form onSubmit={save}>
        <div className="row top" style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="agency-name">Agency name</label>
            <input id="agency-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="sender">Email sender name</label>
            <input id="sender" type="text" value={senderName} onChange={(e) => setSenderName(e.target.value)} maxLength={80} placeholder={name} />
            <p className="hint">Who invites and reports appear to come from.</p>
          </div>
        </div>
        <div className="row top" style={{ marginBottom: 18 }}>
          <div className="field">
            <label htmlFor="primary">Primary colour</label>
            <div className="color-row">
              <input id="primary" type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
              <code>{primary}</code>
            </div>
          </div>
          <div className="field">
            <label htmlFor="accent">Accent colour</label>
            <div className="color-row">
              <input id="accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
              <code>{accent}</code>
            </div>
          </div>
          <div className="field">
            <label>Preview</label>
            <div className="preview" style={{ ['--primary' as string]: primary }}>
              <span className="button sm" style={{ background: primary, color: readableOn(primary) }}>Button</span>
              <span className="pill" style={{ background: `color-mix(in srgb, ${accent} 16%, white)`, color: `color-mix(in srgb, ${accent} 70%, black)` }}>Highlight</span>
            </div>
          </div>
        </div>
        {state.error && <p className="error" role="alert">{state.error}</p>}
        {state.saved && <p className="success" role="status">Branding saved.</p>}
        <button disabled={state.busy}>{state.busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </section>
  );
}

function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#16181d' : '#ffffff';
}

function DomainCard({ agency, onSaved }: { agency: Agency; onSaved: (a: Agency) => void }) {
  const [domain, setDomain] = useState('');
  const [state, setState] = useState<{ error?: string; detail?: string; busy?: boolean }>({});

  async function run(action: () => Promise<{ agency: Agency; detail?: string }>) {
    setState({ busy: true });
    try {
      const res = await action();
      onSaved({ ...res.agency, branding: agency.branding });
      setState({ detail: res.detail });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  const status = agency.domainStatus;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Workspace address</h2>
          <p className="muted small">Where you and your clients sign in.</p>
        </div>
      </div>
      <dl className="kv" style={{ marginBottom: 20 }}>
        <dt>Default address</dt>
        <dd><code>{agency.defaultHost}</code></dd>
        {agency.customDomain && (
          <>
            <dt>Your domain</dt>
            <dd>
              <code>{agency.customDomain}</code>{' '}
              <span className={`pill ${status === 'verified' ? 'ok' : status === 'failed' ? 'bad' : 'warn'}`}>
                {status === 'verified' ? 'Connected' : status === 'failed' ? 'Not connected' : 'Waiting for DNS'}
              </span>
            </dd>
          </>
        )}
      </dl>

      {!agency.customDomain ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => send('PUT', '/v1/agency/domain', { domain }));
          }}
        >
          <div className="row">
            <div className="field">
              <label htmlFor="domain">Use your own domain</label>
              <input id="domain" type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="seo.youragency.com" required />
            </div>
            <button disabled={state.busy}>Add domain</button>
          </div>
          <p className="hint">Pick a subdomain you control. Your default address keeps working.</p>
        </form>
      ) : (
        <>
          {status !== 'verified' && (
            <div className="notice" style={{ marginBottom: 18 }}>
              <p className="small">At your DNS provider, add this record, then check the connection:</p>
              <dl className="kv">
                <dt>Type</dt>
                <dd><code>CNAME</code></dd>
                <dt>Name</dt>
                <dd><code>{agency.customDomain}</code></dd>
                <dt>Value</dt>
                <dd><code>{agency.cnameTarget}</code></dd>
              </dl>
            </div>
          )}
          <div className="row">
            {status !== 'verified' && (
              <button disabled={state.busy} onClick={() => run(() => send('POST', '/v1/agency/domain/verify'))}>
                {state.busy ? 'Checking…' : 'Check connection'}
              </button>
            )}
            <button
              className="secondary"
              disabled={state.busy}
              onClick={() => {
                if (window.confirm(`Disconnect ${agency.customDomain}? Links using it will stop working.`)) {
                  run(() => send('DELETE', '/v1/agency/domain'));
                }
              }}
            >
              Remove domain
            </button>
          </div>
        </>
      )}
      {state.detail && <p className="muted small" role="status" style={{ margin: '14px 0 0' }}>{state.detail}</p>}
      {state.error && <p className="error" role="alert" style={{ margin: '14px 0 0' }}>{state.error}</p>}
    </section>
  );
}

function AuditSettingsCard({ agency, onSaved }: { agency: Agency; onSaved: (a: Agency) => void }) {
  const [ctaLabel, setCtaLabel] = useState(agency.branding.ctaLabel ?? '');
  const [ctaUrl, setCtaUrl] = useState(agency.branding.ctaUrl ?? '');
  const [state, setState] = useState<{ error?: string; saved?: string; busy?: boolean }>({});
  const [copied, setCopied] = useState(false);
  const snippet = `<div data-ai-visibility-audit></div>\n<script src="${agency.workspaceUrl}/embed/audit.js" async></script>`;

  async function save(body: object, saved: string) {
    setState({ busy: true });
    try {
      const res = await send<{ agency: Agency }>('PATCH', '/v1/agency', body);
      onSaved(res.agency);
      setState({ saved });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <section className="card" id="widget">
      <div className="card-head">
        <div>
          <h2>Audit reports and website form</h2>
          <p className="muted small">The button at the end of every shared report, and a form that turns visitors to your website into leads.</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const both = ctaLabel.trim() && ctaUrl.trim();
          if ((ctaLabel.trim() || ctaUrl.trim()) && !both) return setState({ error: 'Fill in both the button text and the link, or neither.' });
          save({ branding: { ctaLabel: ctaLabel.trim() || null, ctaUrl: ctaUrl.trim() || null } }, 'Report button saved.');
        }}
      >
        <div className="row top" style={{ marginBottom: 16 }}>
          <div className="field">
            <label htmlFor="cta-label">Report button text</label>
            <input id="cta-label" type="text" maxLength={40} value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Book a free call" />
          </div>
          <div className="field">
            <label htmlFor="cta-url">Report button link</label>
            <input id="cta-url" type="url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://youragency.com/book" />
            <p className="hint">Your booking page or contact form. Must start with https://.</p>
          </div>
        </div>
        <button className="secondary" disabled={state.busy}>Save report button</button>
      </form>

      <div className="divider" />
      <div className="toggle-row">
        <div>
          <strong>Website form</strong>
          <p className="muted small">
            {agency.widgetEnabled
              ? 'On. Each request runs an audit, emails the report to the visitor and tells you about the lead. It uses one of your monthly audits and its credits; when those run out, requests are still saved as leads.'
              : 'Off. Turn it on, then paste the code below into any page of your website.'}
          </p>
        </div>
        <button
          className={agency.widgetEnabled ? 'secondary' : undefined}
          disabled={state.busy}
          aria-pressed={agency.widgetEnabled}
          onClick={() => save({ widgetEnabled: !agency.widgetEnabled }, agency.widgetEnabled ? 'Website form turned off.' : 'Website form turned on.')}
        >
          {agency.widgetEnabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <label className="label" htmlFor="snippet" style={{ display: 'block', margin: '16px 0 6px' }}>Code for your website</label>
      <textarea id="snippet" className="code" rows={2} readOnly value={snippet} onFocus={(e) => e.currentTarget.select()} />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="secondary sm"
          onClick={async () => {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <a className="button secondary sm" href="/embed/audit" target="_blank" rel="noreferrer">Preview the form</a>
      </div>
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {state.saved && <p className="success" role="status" style={{ marginTop: 12 }}>{state.saved}</p>}
    </section>
  );
}

function PlanCard({ agency }: { agency: Agency }) {
  const { plan } = agency;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Plan</h2>
        <span className="pill">{plan.name}</span>
      </div>
      <dl className="kv">
        <dt>Active clients</dt>
        <dd>Up to {plan.clientLimit}</dd>
        <dt>Prompts per client</dt>
        <dd>Up to {plan.promptsPerClient}</dd>
        <dt>Prospect audits</dt>
        <dd>{plan.auditsPerMonth} a month</dd>
      </dl>
    </section>
  );
}
