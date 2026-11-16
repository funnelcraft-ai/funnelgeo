'use client';

import { useState, type FormEvent } from 'react';
import { send } from '@/lib/client';
import type { Tracker } from '@/lib/types';
import { initials } from '../Brand';
import type { Act } from './ClientWorkspace';

const toList = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

export function BrandsTab({ tracker, act }: { tracker: Tracker; act: Act }) {
  const { client, competitors } = tracker;
  const [aliases, setAliases] = useState(client.brandAliases.join(', '));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const max = tracker.limits?.competitors ?? 5;

  async function saveAliases(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    await act(async () => {
      await send('PATCH', `/v1/clients/${client.id}`, { brandAliases: toList(aliases) });
      setSaved(true);
    });
  }

  async function addCompetitor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    await act(async () => {
      await send('POST', `/v1/clients/${client.id}/competitors`, {
        name: data.name,
        ...(data.domain ? { domain: data.domain } : {}),
        aliases: toList(data.aliases ?? ''),
      });
      form.reset();
    });
    setBusy(false);
  }

  return (
    <>
      <form className="card" onSubmit={saveAliases}>
        <div className="card-head">
          <div>
            <h2>How answers refer to {client.name}</h2>
            <p className="muted small">
              An answer counts as naming the client when it contains the name, one of these other names, or the website address.
            </p>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="aliases">Other names, separated by commas</label>
            <input id="aliases" type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Short name, former name, common misspelling" />
          </div>
          <button>Save names</button>
        </div>
        <p className="hint">
          Matched as whole words, ignoring capitals. After changing names or competitors, use “Re-read answers” on the Visibility tab to apply them to the latest run without spending credits.
        </p>
        {saved && <p className="success" role="status" style={{ marginTop: 10, marginBottom: 0 }}>Names saved.</p>}
      </form>

      <div className="card flush">
        <div className="card-head">
          <div>
            <h2>Competitors</h2>
            <p className="muted small">{competitors.length} of {max}. Each is counted in every answer, for share of voice.</p>
          </div>
        </div>
        {competitors.length === 0 ? (
          <p className="empty"><strong>No competitors yet</strong>Add the brands this client is most often compared with.</p>
        ) : (
          <table>
            <tbody>
              {competitors.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="who-cell">
                      <span className="avatar sm neutral" aria-hidden="true">{initials(c.name)}</span>
                      <div>
                        <strong>{c.name}</strong>
                        <span>{[c.domain, c.aliases.length ? `also: ${c.aliases.join(', ')}` : null].filter(Boolean).join(' · ') || 'No website or other names'}</span>
                      </div>
                    </div>
                  </td>
                  <td className="actions">
                    <button
                      className="link danger"
                      onClick={() => {
                        if (window.confirm(`Remove ${c.name}? It is dropped from share of voice, including in past runs.`)) act(() => send('DELETE', `/v1/competitors/${c.id}`));
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {competitors.length < max && (
          <form className="inline-form" onSubmit={addCompetitor}>
            <div className="row">
              <div className="field">
                <label htmlFor="competitor-name">Competitor name</label>
                <input id="competitor-name" name="name" type="text" required maxLength={160} />
              </div>
              <div className="field">
                <label htmlFor="competitor-domain">Website</label>
                <input id="competitor-domain" name="domain" type="text" placeholder="example.com" />
              </div>
              <div className="field">
                <label htmlFor="competitor-aliases">Other names</label>
                <input id="competitor-aliases" name="aliases" type="text" placeholder="Separated by commas" />
              </div>
              <button disabled={busy}>{busy ? 'Adding…' : 'Add competitor'}</button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
