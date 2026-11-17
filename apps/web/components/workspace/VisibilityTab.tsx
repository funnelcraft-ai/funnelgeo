'use client';

import { Fragment, useEffect, useState } from 'react';
import { load } from '@/lib/client';
import { INTENT_LABEL, type Answer, type Run, type Tracker, type Visibility } from '@/lib/types';
import { Icon } from '../Icon';
import { formatDate } from './ClientWorkspace';

interface Props {
  tracker: Tracker;
  run: Run | null;
  visibility: Visibility | null;
  canEdit: boolean;
  onReparse: (runId: string) => void;
  onGoTo: (tab: 'prompts' | 'brands' | 'runs') => void;
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** A count with what it is out of, and a bar of the same proportion. */
export function Measure({ label, part, whole, strong, tag }: { label: string; part: number; whole: number; strong?: boolean; tag?: string }) {
  return (
    <div className={`measure${strong ? ' strong' : ''}`}>
      <div className="measure-head">
        <span>
          {label}
          {tag && <span className="pill">{tag}</span>}
        </span>
        <span className="measure-value">
          <strong>{part}</strong> of {whole}
        </span>
      </div>
      <div className="bar" role="img" aria-label={`${label}: ${part} of ${whole}`}>
        <span style={{ width: `${share(part, whole)}%` }} />
      </div>
    </div>
  );
}

export function VisibilityTab({ tracker, run, visibility: v, canEdit, onReparse, onGoTo }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const runId = run?.id;
  useEffect(() => setOpen(null), [runId]);

  if (!run || !v) {
    return (
      <div className="card">
        <p className="empty">
          <strong>No results yet</strong>
          {canEdit
            ? 'Results appear here after the first completed run.'
            : 'Your agency has not run a visibility check for you yet. Results will appear here.'}
        </p>
        {canEdit && (
          <ol className="setup-steps">
            <li className={tracker.prompts.length > 0 ? 'done' : undefined}>
              <span className="tick"><Icon name="check" /></span>
              <button className="link" onClick={() => onGoTo('prompts')}>Add the questions buyers ask</button>
              <span className="muted">{tracker.prompts.length} added</span>
            </li>
            <li className={tracker.competitors.length > 0 ? 'done' : undefined}>
              <span className="tick"><Icon name="check" /></span>
              <button className="link" onClick={() => onGoTo('brands')}>Add competitors to compare against</button>
              <span className="muted">{tracker.competitors.length} added</span>
            </li>
            <li>
              <span className="tick"><Icon name="check" /></span>
              <span>Press Run now</span>
            </li>
          </ol>
        )}
      </div>
    );
  }

  const engineKeys = v.engines.map((e) => e.key);
  const trend = tracker.trend;
  const previous = trend.length >= 2 && trend[trend.length - 1]!.runId === run.id ? trend[trend.length - 2]! : null;

  return (
    <>
      <div className="grid-main">
        <section className="card" aria-label="Named in AI answers">
          <span className="label">{tracker.client.name} was named in</span>
          <div className="figure">
            <strong>{v.totals.mentioned}</strong>
            <span className="of">of {v.totals.answers} answers</span>
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            {run.promptCount} prompts, asked {run.samples} times on each engine, {formatDate(run.finishedAt ?? run.createdAt)}.
            {previous && ` The run before: ${previous.mentioned} of ${previous.answers}.`}
            {v.totals.failed > 0 && ` ${v.totals.failed} calls failed and are not counted.`}
          </p>
          <div className="measures">
            {v.engines.map((e) => (
              <Measure key={e.key} label={e.label} part={e.mentioned} whole={e.answers} />
            ))}
          </div>
          <div className="mini-stats two">
            <div>
              <span className="label">Own website cited</span>
              <strong>{v.totals.cited}</strong>
              <span className="muted">of {v.totals.answers} answers linked to {tracker.client.domain ?? 'the client’s site'}</span>
            </div>
            <div>
              <span className="label">Prompts with no mention</span>
              <strong>{v.prompts.filter((p) => p.mentioned === 0).length}</strong>
              <span className="muted">of {v.prompts.length} prompts, on any engine</span>
            </div>
          </div>
        </section>

        <aside className="panel" aria-label="Share of voice">
          <div className="panel-inner">
            <span className="label">Share of voice</span>
            <h2>Who the answers name</h2>
            <div className="measures tight">
              {v.brands.map((b) => (
                <Measure key={b.id ?? 'client'} label={b.name} part={b.mentions} whole={v.totals.answers} strong={b.isClient} tag={b.isClient ? 'Client' : undefined} />
              ))}
            </div>
            {v.brands.length === 1 && canEdit && (
              <p className="muted small" style={{ margin: '14px 0 0' }}>
                <button className="link" onClick={() => onGoTo('brands')}>Add competitors</button> to compare.
              </p>
            )}
          </div>
        </aside>
      </div>

      {trend.length >= 2 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Run by run</h2>
              <p className="muted small">Answers naming {tracker.client.name}, out of the answers in each run.</p>
            </div>
          </div>
          <ol className="trend">
            {trend.map((t) => (
              <li key={t.runId} className={t.runId === run.id ? 'current' : undefined}>
                <div className="trend-bar" role="img" aria-label={`${t.mentioned} of ${t.answers}`}>
                  <span style={{ height: `${Math.max(share(t.mentioned, t.answers), 2)}%` }} />
                </div>
                <strong>{t.mentioned} of {t.answers}</strong>
                <span className="muted">{new Date(t.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Prompt by prompt</h2>
            <p className="muted small">Answers naming {tracker.client.name}, out of the answers each engine gave. Open a row to read them.</p>
          </div>
          {canEdit && (
            <button className="secondary sm" onClick={() => onReparse(run.id)} title="Use this after changing brand names or competitors">
              <Icon name="refresh" />
              Re-read answers
            </button>
          )}
        </div>
        <table className="prompt-table">
          <thead>
            <tr>
              <th>Prompt</th>
              {v.engines.map((e) => (
                <th key={e.key} className="num">{e.label}</th>
              ))}
              <th className="num">All</th>
            </tr>
          </thead>
          <tbody>
            {v.prompts.map((p) => (
              <Fragment key={p.id}>
                <tr className={open === p.id ? 'open' : undefined}>
                  <td>
                    <button className="row-toggle" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                      <Icon name="chevron" />
                      <span>
                        {p.text}
                        <span className="tags">
                          {p.priority && <span className="pill warn">Priority</span>}
                          <span className="pill">{INTENT_LABEL[p.intent]}</span>
                        </span>
                      </span>
                    </button>
                  </td>
                  {engineKeys.map((key) => {
                    const cell = p.engines[key];
                    return (
                      <td key={key} className="num" data-label={v.engines.find((e) => e.key === key)?.label}>
                        {cell && cell.answers > 0 ? (
                          <span className={`score ${cell.mentioned === 0 ? 'none' : cell.mentioned === cell.answers ? 'all' : 'some'}`}>
                            {cell.mentioned}/{cell.answers}
                          </span>
                        ) : (
                          <span className="muted" title="No answer was received">–</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="num" data-label="All"><strong>{p.mentioned}</strong> of {p.answers}</td>
                </tr>
                {open === p.id && (
                  <tr className="detail">
                    <td colSpan={engineKeys.length + 2}>
                      <Answers runId={run.id} promptId={p.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Most cited sources</h2>
            <p className="muted small">The sites the engines linked to, by how many answers cited them.</p>
          </div>
        </div>
        {v.domains.length === 0 ? (
          <p className="empty">The engines gave no sources in this run.</p>
        ) : (
          <table>
            <tbody>
              {v.domains.map((d) => (
                <tr key={d.domain}>
                  <td>
                    <strong>{d.domain}</strong>{' '}
                    {d.isClient ? <span className="pill ok">Client’s site</span> : d.competitor ? <span className="pill warn">{d.competitor}</span> : null}
                  </td>
                  <td className="actions"><strong>{d.answers}</strong> of {v.totals.answers} answers</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Answers({ runId, promptId }: { runId: string; promptId: string }) {
  const [state, setState] = useState<{ answers?: Answer[]; error?: string }>({});
  useEffect(() => {
    let stale = false;
    load<{ answers: Answer[] }>(`/v1/runs/${runId}/answers?prompt=${promptId}`)
      .then((res) => !stale && setState({ answers: res.answers }))
      .catch((err: Error) => !stale && setState({ error: err.message }));
    return () => {
      stale = true;
    };
  }, [runId, promptId]);

  if (state.error) return <p className="error" role="alert">{state.error}</p>;
  if (!state.answers) return <p className="muted small">Loading answers…</p>;
  return (
    <div className="answers">
      {state.answers.map((a) => (
        <article key={a.id} className="answer">
          <header>
            <strong>{a.engineLabel}</strong>
            <span className="muted">answer {a.sampleNo}</span>
            {a.status === 'failed' && <span className="pill bad">Failed</span>}
            {a.mentions.map((m) => (
              <span key={m.name} className={`pill ${m.isClient ? 'ok' : ''}`}>
                {m.position}. {m.name}
              </span>
            ))}
            {a.status === 'ok' && a.mentions.length === 0 && <span className="pill">No tracked brand named</span>}
          </header>
          {a.status === 'failed' ? <p className="muted small">{a.error}</p> : <p className="answer-text">{a.text}</p>}
          {a.citations.length > 0 && (
            <ul className="sources">
              {a.citations.map((c) => (
                <li key={c.url}>
                  <a href={c.url} target="_blank" rel="noreferrer noopener nofollow">{c.domain}</a>
                  {c.isClient && <span className="pill ok">Client’s site</span>}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}
