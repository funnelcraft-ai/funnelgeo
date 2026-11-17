'use client';

import { useState } from 'react';
import { send } from '@/lib/client';
import type { PlatformSetting, PlatformSettingGroup, PlatformSettings, SettingTestResult } from '@/lib/types';
import { Icon } from './Icon';
import { PageHead } from './Shell';

/** Settings that have a sensible default, so leaving them empty is not a problem. */
const OPTIONAL = new Set(['WRITER_PROVIDER', 'WRITER_MODEL', 'ANTHROPIC_API_KEY', 'MAIL_FROM']);

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function ApiKeysPanel({ initial }: { initial: PlatformSettings }) {
  const [settings, setSettings] = useState(initial);

  function replace(updated: PlatformSetting) {
    setSettings((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, items: g.items.map((i) => (i.key === updated.key ? updated : i)) })) }));
  }

  return (
    <>
      <PageHead
        crumbs="Platform / API keys"
        title="API keys"
        sub="Keys for the answer engines and the email server. They are encrypted before they are stored and are never shown again in full. Changes reach the running app within 15 seconds, with no restart."
      />

      {!settings.encryptionReady && (
        <div className="notice warn" role="alert">
          <p><strong>Keys can’t be saved yet.</strong> The server needs an encryption key first. Run <code>openssl rand -base64 32</code>, put the result in the server environment as <code>SETTINGS_ENCRYPTION_KEY</code>, and restart the API and the worker. Keep a copy somewhere safe: without it, saved keys can’t be read.</p>
        </div>
      )}
      {settings.engineMode === 'mock' && (
        <div className="notice">
          <p><strong>Demo mode is on.</strong> The server is set to <code>ENGINE_MODE=mock</code>, so runs use stand-in answers and the engine keys below are not used for runs yet. The Test buttons still make a real call.</p>
        </div>
      )}

      <div className="stack">
        {settings.groups.map((group) => (
          <GroupCard key={group.key} group={group} canSaveSecrets={settings.encryptionReady} onSaved={replace} />
        ))}
      </div>
    </>
  );
}

function groupStatus(group: PlatformSettingGroup): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  // Optional settings don't count as missing: the email sender and, for writing, everything but what the chosen provider needs.
  const optional = (i: PlatformSetting) => (group.key === 'email' && i.key !== 'SMTP_URL') || group.key === 'writer';
  const missing = group.items.filter((i) => i.source === 'none' && !optional(i));
  if (group.key === 'writer') return { label: 'Uses the defaults unless changed', tone: 'ok' };
  if (group.items.some((i) => i.unreadable && i.source === 'none')) return { label: 'Enter the key again', tone: 'bad' };
  if (missing.length === 0) return { label: 'Set up', tone: 'ok' };
  if (missing.length === group.items.length || group.key === 'email') return { label: 'Not set up', tone: 'warn' };
  return { label: `${missing.map((m) => m.label).join(' and ')} missing`, tone: 'warn' };
}

function GroupCard({ group, canSaveSecrets, onSaved }: { group: PlatformSettingGroup; canSaveSecrets: boolean; onSaved: (s: PlatformSetting) => void }) {
  const [test, setTest] = useState<{ busy?: boolean; result?: SettingTestResult; error?: string }>({});
  const status = groupStatus(group);
  const isEmail = group.key === 'email';

  async function runTest() {
    setTest({ busy: true });
    try {
      setTest({ result: await send<SettingTestResult>('POST', `/v1/admin/settings/test/${group.key}`) });
    } catch (err) {
      setTest({ error: (err as Error).message });
    }
  }

  return (
    <section className="card" aria-labelledby={`group-${group.key}`}>
      <div className="card-head">
        <div>
          <h2 id={`group-${group.key}`}>{group.label}</h2>
          <p className="muted small">{group.description}</p>
        </div>
        <span className={`pill ${status.tone}`}>{status.label}</span>
      </div>

      <div className="key-list">
        {group.items.map((item) => (
          <SettingRow key={item.key} item={item} disabled={item.secret && !canSaveSecrets} onSaved={onSaved} />
        ))}
      </div>

      <div className="key-test">
        <button type="button" className="secondary sm" onClick={runTest} disabled={test.busy}>
          <Icon name={isEmail ? 'mail' : 'play'} />
          {test.busy ? (isEmail ? 'Sending…' : 'Asking…') : isEmail ? 'Send a test email' : group.key === 'writer' ? 'Test writing' : 'Test connection'}
        </button>
        <p className="hint">
          {isEmail ? 'Sends one email to your own address.' : 'Asks one short question with the key and model in use. Costs a fraction of a cent.'}
        </p>
      </div>
      {test.error && <p className="error" role="alert">{test.error}</p>}
      {test.result && (
        <div className={`test-result ${test.result.ok ? 'ok' : 'bad'}`} role="status">
          <strong>{test.result.ok ? 'Working.' : 'Not working.'}</strong> {test.result.message}
          {test.result.sample && <blockquote>{test.result.sample}</blockquote>}
        </div>
      )}
    </section>
  );
}

function describe(raw: PlatformSetting): string {
  // Show a choice by its label, not its stored value.
  const item = raw.choices ? { ...raw, shown: raw.choices.find((c) => c.value === raw.shown)?.label ?? raw.shown } : raw;
  if (item.source === 'saved') {
    const value = item.secret ? `Saved, ending in ${item.shown}` : `Saved: ${item.shown}`;
    return `${value}. Updated ${when(item.updatedAt!)}${item.updatedBy ? ` by ${item.updatedBy}` : ''}.`;
  }
  const unreadable = item.unreadable ? 'A saved key can’t be read with the server’s current encryption key, so enter it again. ' : '';
  if (item.source === 'environment') {
    return `${unreadable}Using the server environment${item.secret ? `, ending in ${item.shown}` : `: ${item.shown}`}. Save one here to replace it.`;
  }
  return `${unreadable}Not set.`;
}

function SettingRow({ item, disabled, onSaved }: { item: PlatformSetting; disabled: boolean; onSaved: (s: PlatformSetting) => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string; saved?: string }>({});
  const id = `setting-${item.key}`;

  async function act(method: 'PUT' | 'DELETE') {
    setState({ busy: true });
    try {
      const res = await send<{ setting: PlatformSetting }>(method, `/v1/admin/settings/${item.key}`, method === 'PUT' ? { value } : undefined);
      onSaved(res.setting);
      setValue('');
      setState({ saved: method === 'PUT' ? 'Saved.' : res.setting.source === 'environment' ? 'Removed. The server environment value is used again.' : 'Removed.' });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <form
      className="key-row"
      onSubmit={(e) => {
        e.preventDefault();
        act('PUT');
      }}
    >
      <div className="row">
        <div className="field">
          <label htmlFor={id}>
            {item.label} <code className="env-name">{item.key}</code>
          </label>
          {item.choices ? (
            <select id={id} value={value || (item.source !== 'none' ? item.shown ?? '' : '')} onChange={(e) => setValue(e.target.value)} disabled={disabled}>
              {item.source === 'none' && <option value="">Choose…</option>}
              {item.choices.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          ) : (
          <input
            id={id}
            type={item.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={item.placeholder ?? (item.secret ? (item.source === 'none' ? 'Paste the key' : 'Paste a new key to replace it') : item.source === 'none' ? 'Model name' : 'New model name')}
            disabled={disabled}
            required
          />
          )}
        </div>
        <button disabled={disabled || state.busy || value.trim() === ''}>Save</button>
        {item.source === 'saved' && (
          <button type="button" className="link danger" onClick={() => act('DELETE')} disabled={state.busy}>
            Remove
          </button>
        )}
      </div>
      <p className={`hint ${item.source === 'none' && !OPTIONAL.has(item.key) ? 'missing' : ''}`}>
        {item.source !== 'none' && <Icon name="check" />} {describe(item)} {item.help}
      </p>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.saved && <p className="success" role="status">{state.saved}</p>}
    </form>
  );
}
