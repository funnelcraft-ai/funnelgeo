'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { Agency } from '@/lib/types';

const DEFAULT_PRIMARY = '#1f4fd8';
const DEFAULT_ACCENT = '#f59e0b';

export function SettingsPanel({ initial }: { initial: Agency }) {
  const [agency, setAgency] = useState(initial);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted small">How your workspace looks and where it lives. Clients only ever see your brand.</p>
        </div>
      </div>
      <BrandingCard agency={agency} onSaved={setAgency} />
      <DomainCard agency={agency} onSaved={setAgency} />
      <PlanCard agency={agency} />
    </>
  );
}

function BrandingCard({ agency, onSaved }: { agency: Agency; onSaved: (a: Agency) => void }) {
  const router = useRouter();
  const [name, setName] = useState(agency.name);
  const [logoUrl, setLogoUrl] = useState(agency.branding.logoUrl ?? '');
  const [faviconUrl, setFaviconUrl] = useState(agency.branding.faviconUrl ?? '');
  const [primary, setPrimary] = useState(agency.branding.primaryColor ?? DEFAULT_PRIMARY);
  const [accent, setAccent] = useState(agency.branding.accentColor ?? DEFAULT_ACCENT);
  const [senderName, setSenderName] = useState(agency.branding.senderName ?? '');
  const [state, setState] = useState<{ error?: string; saved?: boolean; busy?: boolean }>({});

  async function save(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true });
    try {
      const res = await send<{ agency: Agency }>('PATCH', '/v1/agency', {
        name,
        branding: {
          logoUrl: logoUrl.trim() || null,
          faviconUrl: faviconUrl.trim() || null,
          primaryColor: primary,
          accentColor: accent,
          senderName: senderName.trim() || null,
        },
      });
      onSaved(res.agency);
      setState({ saved: true });
      router.refresh(); // re-theme the page with the new colours and logo
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Branding</h2>
      <div className="preview" aria-label="Preview">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" style={{ maxHeight: 32, maxWidth: 160 }} />
        ) : (
          <strong>{name}</strong>
        )}
        <span className="swatch" style={{ background: primary }} title="Primary colour" />
        <span className="swatch" style={{ background: accent }} title="Accent colour" />
        <span className="muted small">Preview</span>
      </div>
      <div className="row top" style={{ marginBottom: 14 }}>
        <div className="field">
          <label htmlFor="agency-name">Agency name</label>
          <input id="agency-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="sender">Email sender name</label>
          <input id="sender" type="text" value={senderName} onChange={(e) => setSenderName(e.target.value)} maxLength={80} placeholder={name} />
        </div>
      </div>
      <div className="row top" style={{ marginBottom: 14 }}>
        <div className="field">
          <label htmlFor="logo">Logo URL</label>
          <input id="logo" type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://youragency.com/logo.png" />
          <p className="hint">An https link to a PNG or SVG. Shown up to 32px tall.</p>
        </div>
        <div className="field">
          <label htmlFor="favicon">Favicon URL</label>
          <input id="favicon" type="url" value={faviconUrl} onChange={(e) => setFaviconUrl(e.target.value)} placeholder="https://youragency.com/favicon.png" />
        </div>
      </div>
      <div className="row top" style={{ marginBottom: 16 }}>
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
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.saved && <p className="success" role="status">Branding saved.</p>}
      <button disabled={state.busy}>{state.busy ? 'Saving…' : 'Save branding'}</button>
    </form>
  );
}

function DomainCard({ agency, onSaved }: { agency: Agency; onSaved: (a: Agency) => void }) {
  const [domain, setDomain] = useState('');
  const [state, setState] = useState<{ error?: string; detail?: string; busy?: boolean }>({});

  async function run(action: () => Promise<{ agency: Agency; detail?: string }>) {
    setState({ busy: true });
    try {
      const res = await action();
      onSaved(res.agency);
      setState({ detail: res.detail });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  const status = agency.domainStatus;
  return (
    <div className="card">
      <h2>Workspace address</h2>
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Default address</dt>
        <dd><code>{agency.defaultHost}</code></dd>
        {agency.customDomain && (
          <>
            <dt>Custom domain</dt>
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
              <p className="hint">Pick a subdomain you control. Your default address keeps working.</p>
            </div>
            <button disabled={state.busy}>Add domain</button>
          </div>
        </form>
      ) : (
        <>
          {status !== 'verified' && (
            <>
              <p>At your DNS provider, add this record, then check the connection:</p>
              <dl className="kv" style={{ marginBottom: 16 }}>
                <dt>Type</dt>
                <dd><code>CNAME</code></dd>
                <dt>Name</dt>
                <dd><code>{agency.customDomain}</code></dd>
                <dt>Value</dt>
                <dd><code>{agency.cnameTarget}</code></dd>
              </dl>
            </>
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
      {state.detail && <p className="muted small" role="status" style={{ marginTop: 12 }}>{state.detail}</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
    </div>
  );
}

function PlanCard({ agency }: { agency: Agency }) {
  const { plan } = agency;
  return (
    <div className="card">
      <h2>Plan</h2>
      <dl className="kv">
        <dt>Current plan</dt>
        <dd>{plan.name}</dd>
        <dt>Active clients</dt>
        <dd>Up to {plan.clientLimit}</dd>
        <dt>Prompts per client</dt>
        <dd>Up to {plan.promptsPerClient}</dd>
        <dt>Prospect audits</dt>
        <dd>{plan.auditsPerMonth} a month</dd>
      </dl>
    </div>
  );
}
