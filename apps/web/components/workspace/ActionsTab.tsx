'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { load, send } from '@/lib/client';
import type { Action, ActionAssetSummary, ActionQueue, ActionStatus, AssetKind, AssetView, Comparison, Tracker } from '@/lib/types';
import { Icon } from '../Icon';
import { formatDate } from './ClientWorkspace';

type Filter = 'review' | 'hand' | 'done' | 'dismissed';
const FILTERS: { key: Filter; label: string; statuses: ActionStatus[] }[] = [
  { key: 'review', label: 'To review', statuses: ['suggested'] },
  { key: 'hand', label: 'In hand', statuses: ['approved', 'in_progress'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
  { key: 'dismissed', label: 'Dismissed', statuses: ['dismissed'] },
];
const STATUS_LABEL: Record<ActionStatus, string> = { suggested: 'Suggested', approved: 'Approved', in_progress: 'In progress', done: 'Done', dismissed: 'Dismissed' };
const CODE_KINDS: AssetKind[] = ['robots_patch', 'llms_txt', 'faq_schema'];
const placeholders = (text: string) => (text.match(/\[ADD:/g) ?? []).length;

export function ActionsTab({ tracker, onGoTo }: { tracker: Tracker; onGoTo: (tab: 'runs') => void }) {
  const clientId = tracker.client.id;
  const [queue, setQueue] = useState<ActionQueue | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    try {
      setQueue(await load<ActionQueue>(`/v1/clients/${clientId}/actions`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [clientId]);
  useEffect(() => void reload(), [reload]);

  // Follow assets being written.
  const writing = queue?.actions.some((a) => a.assets.some((s) => s.status === 'pending'));
  useEffect(() => {
    if (!writing) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [writing, reload]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, queue?.actions.filter((a) => f.statuses.includes(a.status)).length ?? 0])) as Record<Filter, number>,
    [queue],
  );
  const active = filter ?? (counts.review > 0 ? 'review' : counts.hand > 0 ? 'hand' : 'review');
  const shown = queue?.actions.filter((a) => FILTERS.find((f) => f.key === active)!.statuses.includes(a.status)) ?? [];

  async function refreshSuggestions() {
    setRefreshing(true);
    setError('');
    try {
      await send('POST', `/v1/clients/${clientId}/actions/refresh`);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
    setRefreshing(false);
  }

  if (!queue) return error ? <p className="error" role="alert">{error}</p> : <p className="muted" aria-busy="true">Loading the action queue…</p>;
  if (!queue.hasRun && queue.actions.length === 0) {
    return (
      <section className="card">
        <p className="empty">
          <strong>No actions yet</strong>
          Fixes are suggested from each completed run’s diagnosis.{' '}
          <button className="link" onClick={() => onGoTo('runs')}>Runs and schedule</button>
        </p>
      </section>
    );
  }

  return (
    <div className="actions-tab">
      {!queue.writer.ready && (
        <p className="notice warn" role="note">
          <strong>Writing isn’t set up.</strong> {queue.writer.problem} Your platform administrator can set it on the API keys screen. The robots.txt and llms.txt fixes still work.
        </p>
      )}
      {queue.writer.mode === 'mock' && (
        <p className="notice" role="note"><strong>Demo writing.</strong> In mock mode, briefs, drafts and emails are stand-in text, not written by a model.</p>
      )}

      <div className="queue-bar">
        <div className="segmented" role="tablist" aria-label="Filter actions">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={active === f.key} onClick={() => setFilter(f.key)}>
              {f.label} <span className="count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="queue-meta">
          <span className="muted small">{queue.credits.toLocaleString()} credits left · writing: {queue.writer.label}</span>
          <button className="secondary sm" onClick={refreshSuggestions} disabled={refreshing} title="Rebuild suggestions from the latest completed run">
            <Icon name="refresh" />
            {refreshing ? 'Updating…' : 'Update suggestions'}
          </button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {shown.length === 0 ? (
        <section className="card">
          <p className="empty">
            {active === 'review' ? (
              <><strong>Nothing to review</strong>New suggestions arrive after each run.</>
            ) : active === 'hand' ? (
              <><strong>Nothing in hand</strong>Approve a suggestion to start work on it.</>
            ) : active === 'done' ? (
              'No finished actions yet.'
            ) : (
              'Nothing dismissed in the last 90 days.'
            )}
          </p>
        </section>
      ) : (
        <ol className="action-list">
          {shown.map((a) => (
            <ActionCard key={a.id} action={a} queue={queue} onChanged={reload} />
          ))}
        </ol>
      )}
      <p className="muted small queue-foot">
        Impact counts the lost questions an action addresses, with priority questions counting double. Nothing here is ever published automatically.
      </p>
    </div>
  );
}

function ActionCard({ action: a, queue, onChanged }: { action: Action; queue: ActionQueue; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [open, setOpen] = useState<AssetKind | null>(null);
  const [allQuestions, setAllQuestions] = useState(false);
  const working = a.status === 'approved' || a.status === 'in_progress';

  async function patch(body: object) {
    setBusy(true);
    setError('');
    try {
      await send('PATCH', `/v1/actions/${a.id}`, body);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  async function generate(kind: AssetKind) {
    setError('');
    try {
      await send('POST', `/v1/actions/${a.id}/assets`, { kind });
      setOpen(kind);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className={`action-card s-${a.status}`}>
      <div className="action-head">
        <div className="action-title">
          <span className="type-tag t-action">{a.typeLabel}</span>
          <h3>{a.title}</h3>
        </div>
        <div className="action-badges">
          {a.prompts.length > 0 ? (
            <span className="pill" title="Lost questions addressed; priority questions count double">Impact {a.impact % 1 ? a.impact.toFixed(1) : a.impact}</span>
          ) : (
            <span className="pill" title="Helps the whole site rather than particular questions">Whole site</span>
          )}
          <span className="pill" title="Effort">Effort {a.effort}</span>
          {a.status !== 'suggested' && <span className={`pill ${a.status === 'done' ? 'ok' : a.status === 'dismissed' ? '' : 'warn'}`}>{STATUS_LABEL[a.status]}</span>}
        </div>
      </div>
      <p className="action-why">{a.rationale}</p>

      {a.prompts.length > 0 && (
        <div className="action-questions">
          <span className="label">Lost {a.prompts.length === 1 ? 'question' : 'questions'}</span>
          <ul>
            {(allQuestions ? a.prompts : a.prompts.slice(0, 4)).map((p) => (
              <li key={p.id}>
                {p.priority && <Icon name="target" />}
                {p.text}
              </li>
            ))}
            {a.prompts.length > 4 && (
              <li>
                <button className="link quiet small-link" onClick={() => setAllQuestions(!allQuestions)} aria-expanded={allQuestions}>
                  {allQuestions ? 'Show fewer' : `and ${a.prompts.length - 4} more`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      {a.details.pages.length > 0 && (
        <div className="action-questions">
          <span className="label">{a.details.pages.length === 1 ? 'Page' : 'Pages'}</span>
          <ul>
            {a.details.pages.slice(0, 4).map((p) => (
              <li key={p.url}>
                <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title ?? p.url}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {working && (
        <div className="action-work">
          <div className="row top action-owner">
            <div className="field">
              <label htmlFor={`owner-${a.id}`}>Owner</label>
              <select id={`owner-${a.id}`} value={a.owner?.id ?? ''} disabled={busy} onChange={(e) => patch({ ownerUserId: e.target.value || null })}>
                <option value="">Nobody yet</option>
                {queue.team.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>

          {a.generators.length === 0 ? (
            <p className="muted small">Nothing to generate for this one: it’s work to do by hand, as described above.</p>
          ) : (
            <ul className="asset-list">
              {a.generators.map((g) => {
                const asset = a.assets.find((s) => s.kind === g.kind);
                return (
                  <AssetRow
                    key={g.kind}
                    action={a}
                    generator={g}
                    asset={asset}
                    canWrite={queue.writer.ready || g.credits === 0}
                    open={open === g.kind}
                    onToggle={() => setOpen(open === g.kind ? null : g.kind)}
                    onGenerate={() => generate(g.kind)}
                    onSaved={onChanged}
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}

      {a.status === 'done' && (
        <p className="action-done">
          <Icon name="check" /> Done {formatDate(a.doneAt!)}
          {a.doneUrl && <> · <a href={a.doneUrl} target="_blank" rel="noopener noreferrer">{a.doneUrl}</a></>}
          {a.doneNote && <> · {a.doneNote}</>}
        </p>
      )}
      {a.status === 'done' && a.comparison && <ChangeAfter comparison={a.comparison} />}
      {a.status === 'dismissed' && (
        <p className="muted small">
          {a.dismissReason === 'resolved' ? 'Closed automatically: the latest run no longer shows this problem.' : `Dismissed ${formatDate(a.dismissedAt!)}. It won’t be suggested again for 90 days.`}
        </p>
      )}

      {finishing && <FinishForm onCancel={() => setFinishing(false)} onDone={(body) => patch({ status: 'done', ...body }).then(() => setFinishing(false))} busy={busy} />}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="action-buttons">
        {a.status === 'suggested' && (
          <>
            <button onClick={() => patch({ status: 'approved' })} disabled={busy}><Icon name="check" />Approve</button>
            <button className="secondary" onClick={() => patch({ status: 'dismissed' })} disabled={busy}>Dismiss</button>
          </>
        )}
        {working && !finishing && (
          <>
            <button onClick={() => setFinishing(true)} disabled={busy}><Icon name="check" />Mark done</button>
            <button className="link quiet" onClick={() => patch({ status: 'dismissed' })} disabled={busy}>Dismiss</button>
          </>
        )}
        {a.status === 'done' && <button className="secondary sm" onClick={() => patch({ status: 'in_progress' })} disabled={busy}>Reopen</button>}
        {a.status === 'dismissed' && <button className="secondary sm" onClick={() => patch({ status: 'suggested' })} disabled={busy}>Restore</button>}
      </div>
    </li>
  );
}

function FinishForm({ onCancel, onDone, busy }: { onCancel: () => void; onDone: (body: { doneUrl: string | null; doneNote: string | null }) => void; busy: boolean }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      className="finish"
      onSubmit={(e) => {
        e.preventDefault();
        onDone({ doneUrl: url.trim() || null, doneNote: note.trim() || null });
      }}
    >
      <div className="row top">
        <div className="field">
          <label htmlFor="done-url">Live URL</label>
          <input id="done-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div className="field">
          <label htmlFor="done-note">Or a note</label>
          <input id="done-note" type="text" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Listing submitted, email sent to the editor…" />
        </div>
      </div>
      <p className="hint">Today’s date starts the before and after comparison for the linked questions.</p>
      <div className="row">
        <button disabled={busy || (!url.trim() && !note.trim())}>Save as done</button>
        <button type="button" className="link quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AssetRow({ action, generator: g, asset, canWrite, open, onToggle, onGenerate, onSaved }: {
  action: Action;
  generator: Action['generators'][number];
  asset: ActionAssetSummary | undefined;
  canWrite: boolean;
  open: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  onSaved: () => Promise<void>;
}) {
  const pending = asset?.status === 'pending';
  const cost = g.credits === 0 ? 'free' : `${g.credits} ${g.credits === 1 ? 'credit' : 'credits'}`;
  return (
    <li className="asset-row">
      <div className="asset-line">
        <div>
          <strong>{g.label}</strong>
          <span className="muted small">
            {!asset
              ? ` · ${cost}`
              : pending
                ? ' · writing…'
                : asset.status === 'failed'
                  ? ` · failed: ${asset.error ?? 'unknown error'}. No credits were used.`
                  : ` · version ${asset.version}${asset.origin === 'edited' ? ', edited' : ''}${asset.mode === 'mock' ? ', demo text' : ''}`}
          </span>
        </div>
        <div className="asset-buttons">
          {asset?.status === 'done' || (asset && asset.version > 1) ? (
            <button className="secondary sm" onClick={onToggle} aria-expanded={open}>{open ? 'Close' : 'Open'}</button>
          ) : null}
          <button
            className={asset ? 'link quiet' : 'secondary sm'}
            onClick={onGenerate}
            disabled={pending || !canWrite}
            title={canWrite ? `Uses ${cost}` : 'Writing isn’t set up'}
          >
            {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name={asset ? 'refresh' : 'plus'} />}
            {asset ? 'Write again' : 'Generate'}
          </button>
        </div>
      </div>
      {open && asset && !pending && <AssetEditor actionId={action.id} kind={g.kind} latestVersion={asset.version} onSaved={onSaved} />}
    </li>
  );
}

function AssetEditor({ actionId, kind, latestVersion, onSaved }: { actionId: string; kind: AssetKind; latestVersion: number; onSaved: () => Promise<void> }) {
  const [view, setView] = useState<AssetView | null>(null);
  const [text, setText] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [state, setState] = useState<{ busy?: boolean; error?: string; note?: string }>({});

  const open = useCallback(
    async (v?: number) => {
      try {
        const next = await load<AssetView>(`/v1/actions/${actionId}/assets/${kind}${v ? `?version=${v}` : ''}`);
        setView(next);
        setText(next.current.content ?? '');
        setVersion(next.current.version);
      } catch (err) {
        setState({ error: (err as Error).message });
      }
    },
    [actionId, kind],
  );
  useEffect(() => void open(), [open, latestVersion]);

  if (!view) return <p className="muted small" aria-busy="true">Opening…</p>;
  const original = view.current.content ?? '';
  const changed = text !== original;
  const left = placeholders(text);
  const meta = view.versions.find((v) => v.version === version);

  async function save() {
    setState({ busy: true });
    try {
      const res = await send<{ version: number }>('PUT', `/v1/actions/${actionId}/assets/${kind}`, { content: text });
      await onSaved();
      await open(res.version);
      setState({ note: `Saved as version ${res.version}.` });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }

  return (
    <div className="asset-editor">
      <div className="asset-toolbar">
        <label className="sr-only" htmlFor={`v-${actionId}-${kind}`}>Version</label>
        <select id={`v-${actionId}-${kind}`} value={version ?? ''} onChange={(e) => open(Number(e.target.value))}>
          {view.versions.filter((v) => v.status === 'done').map((v) => (
            <option key={v.version} value={v.version}>
              Version {v.version} · {v.origin === 'edited' ? `edited by ${v.createdBy ?? 'someone'}` : v.mode === 'mock' ? 'demo text' : v.model ? `written by ${v.model}` : 'built from rules'} · {formatDate(v.createdAt)}
            </option>
          ))}
        </select>
        <span className={`pill ${left ? 'warn' : 'ok'}`}>{left ? `${left} [ADD: …] to fill in` : 'No placeholders left'}</span>
      </div>
      <label className="sr-only" htmlFor={`t-${actionId}-${kind}`}>{view.label}</label>
      <textarea
        id={`t-${actionId}-${kind}`}
        className={CODE_KINDS.includes(kind) ? 'code' : undefined}
        rows={Math.min(24, Math.max(8, text.split('\n').length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={!CODE_KINDS.includes(kind)}
      />
      <div className="asset-toolbar">
        <button className="sm" onClick={save} disabled={!changed || state.busy}>Save as new version</button>
        <button
          className="secondary sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => {});
            setState({ note: 'Copied.' });
          }}
        >
          Copy
        </button>
        <a className="button secondary sm" href={`/api/v1/assets/${view.current.id}/download`} aria-disabled={changed} onClick={(e) => changed && e.preventDefault()} title={changed ? 'Save your changes first' : undefined}>
          <Icon name="download" />Download
        </a>
        {changed && <button className="link quiet" onClick={() => setText(original)}>Undo changes</button>}
        {state.note && <span className="success small" role="status">{state.note}</span>}
        {meta?.version !== view.versions[0]?.version && <span className="muted small">An older version: saving it makes it the newest.</span>}
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
    </div>
  );
}

const CHANGE_LABEL: Record<Comparison['label'], { text: string; tone: string }> = {
  improved: { text: 'Improved', tone: 'ok' },
  no_change: { text: 'No clear change', tone: '' },
  declined: { text: 'Declined', tone: 'bad' },
  too_early: { text: 'Too early', tone: '' },
};
const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);

/** What followed the action: never presented as what the action caused. */
function ChangeAfter({ comparison: c }: { comparison: Comparison }) {
  const label = CHANGE_LABEL[c.label];
  return (
    <section className="change-after" aria-label="Change after this action">
      <div className="change-head">
        <span className="label">Change after this action</span>
        {c.questions > 0 && <span className={`pill ${label.tone}`}>{label.text}</span>}
      </div>
      <p>{c.sentence}</p>
      {c.questions > 0 && c.before.answers > 0 && c.after.answers > 0 && (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th>Named in answers</th>
                <th>{c.windowDays / 7} weeks before</th>
                <th>{c.complete ? `${c.windowDays / 7} weeks after` : 'After, so far'}</th>
              </tr>
            </thead>
            <tbody>
              {c.byEngine.map((e) => (
                <tr key={e.key}>
                  <td>{e.label}</td>
                  <td>{pct(e.before.rate)} <span className="muted small">({e.before.named} of {e.before.answers})</span></td>
                  <td>{pct(e.after.rate)} <span className="muted small">({e.after.named} of {e.after.answers})</span></td>
                </tr>
              ))}
              <tr className="total">
                <td>All engines</td>
                <td>{pct(c.before.rate)} <span className="muted small">({c.before.named} of {c.before.answers}, {c.before.runs} {c.before.runs === 1 ? 'run' : 'runs'})</span></td>
                <td>{pct(c.after.rate)} <span className="muted small">({c.after.named} of {c.after.answers}, {c.after.runs} {c.after.runs === 1 ? 'run' : 'runs'})</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {c.visits && (
        <p className="muted small">
          AI visits to {c.visits.path}: {c.visits.before} in the {c.windowDays / 7} weeks before, {c.visits.after} after{c.complete ? '' : ' so far'}.
        </p>
      )}
      <p className="muted small">AI answers change from month to month for many reasons, so this shows what followed the action, not proof it caused it.</p>
    </section>
  );
}
