'use client';

import { useState, type FormEvent } from 'react';
import { send } from '@/lib/client';
import { INTENT_LABEL, type Intent, type Tracker } from '@/lib/types';
import type { Act } from './ClientWorkspace';

export function PromptsTab({ tracker, act }: { tracker: Tracker; act: Act }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const limit = tracker.limits?.prompts ?? 0;
  const active = tracker.prompts.filter((p) => p.active).length;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote('');
    await act(async () => {
      const res = await send<{ added: unknown[]; skipped: number }>('POST', `/v1/clients/${tracker.client.id}/prompts`, {
        prompts: lines.map((line) => ({ text: line })),
      });
      setText('');
      setNote(`${res.added.length} added${res.skipped ? `, ${res.skipped} already on the list` : ''}.`);
    });
    setBusy(false);
  }

  return (
    <>
      <form className="card" onSubmit={add}>
        <div className="card-head">
          <div>
            <h2>Add prompts</h2>
            <p className="muted small">
              The questions this client’s buyers ask AI assistants. One per line. {active} of {limit} in use on your plan.
            </p>
          </div>
        </div>
        <label className="sr-only" htmlFor="new-prompts">Prompts, one per line</label>
        <textarea
          id="new-prompts"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Best dental clinic for implants in Pune\nWhich dentist in Pune is good for children?'}
        />
        <p className="hint">Write them the way a customer would ask, without the client’s name. A prompt’s wording cannot be changed later, so results stay comparable.</p>
        {note && <p className="success" role="status">{note}</p>}
        <button disabled={busy || lines.length === 0} style={{ marginTop: 12 }}>
          {busy ? 'Adding…' : lines.length > 1 ? `Add ${lines.length} prompts` : 'Add prompt'}
        </button>
      </form>

      <div className="card flush">
        {tracker.prompts.length === 0 ? (
          <p className="empty"><strong>No prompts yet</strong>Add the first ones above. Ten to twenty-five is a good set.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Type</th>
                <th>Status</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {tracker.prompts.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.text} {p.priority && <span className="pill warn">Priority</span>}
                  </td>
                  <td>
                    <select
                      className="compact"
                      aria-label={`Type of “${p.text}”`}
                      value={p.intent}
                      onChange={(e) => act(() => send('PATCH', `/v1/prompts/${p.id}`, { intent: e.target.value as Intent }))}
                    >
                      {(Object.keys(INTENT_LABEL) as Intent[]).map((intent) => (
                        <option key={intent} value={intent}>{INTENT_LABEL[intent]}</option>
                      ))}
                    </select>
                  </td>
                  <td><span className={`pill ${p.active ? 'ok' : ''}`}>{p.active ? 'Tracked' : 'Paused'}</span></td>
                  <td className="actions">
                    <button className="link quiet" onClick={() => act(() => send('PATCH', `/v1/prompts/${p.id}`, { priority: !p.priority }))}>
                      {p.priority ? 'Unmark priority' : 'Mark priority'}
                    </button>
                    <button className="link quiet" onClick={() => act(() => send('PATCH', `/v1/prompts/${p.id}`, { active: !p.active }))}>
                      {p.active ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      className="link danger"
                      onClick={() => {
                        if (window.confirm('Remove this prompt? Results from past runs are kept.')) act(() => send('DELETE', `/v1/prompts/${p.id}`));
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
      </div>
    </>
  );
}
