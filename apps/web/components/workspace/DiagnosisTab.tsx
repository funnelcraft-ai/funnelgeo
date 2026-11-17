'use client';

import { useCallback, useEffect, useState } from 'react';
import { load, send } from '@/lib/client';
import type { Diagnosis, DiagnosisPrompt, DiagnosisSource, DiagnosisView, PageCheck, Run, SourceType, Tracker } from '@/lib/types';
import { CHECK } from '../audits/ReportView';
import { Icon } from '../Icon';
import { formatDate } from './ClientWorkspace';

const CHECK_BADGE: Record<PageCheck, { label: (client: string) => string; tone: string }> = {
  not_listed: { label: (c) => `Doesn’t list ${c}`, tone: 'bad' },
  listed: { label: (c) => `Lists ${c}`, tone: 'ok' },
  unchecked: { label: () => 'Not checked yet', tone: '' },
  failed: { label: () => 'Couldn’t open', tone: '' },
};

const QUESTIONS_SHOWN = 8;
const SOURCES_SHOWN = 3;

const TYPE_ORDER: SourceType[] = ['own', 'competitor', 'list_review', 'directory', 'forum', 'news', 'other'];

interface Props {
  tracker: Tracker;
  run: Run | null;
  onGoTo: (tab: 'visibility' | 'prompts' | 'brands' | 'runs') => void;
}

export function DiagnosisTab({ tracker, run, onGoTo }: Props) {
  const clientId = tracker.client.id;
  const [view, setView] = useState<DiagnosisView | null>(null);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const runId = run?.id;

  const refresh = useCallback(async () => {
    try {
      setView(await load<DiagnosisView>(`/v1/clients/${clientId}/diagnosis${runId ? `?run=${runId}` : ''}`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [clientId, runId]);

  useEffect(() => {
    setView(null);
    void refresh();
  }, [refresh]);

  // While the cited pages are being opened, or the website checked, follow along.
  const following = view?.diagnosis?.status === 'pending' || view?.diagnosis?.site?.status === 'pending';
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [following, refresh]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!view) return <p className="muted" aria-busy="true">Loading the diagnosis…</p>;
  const d = view.diagnosis;
  if (!run || !d) {
    return (
      <section className="card">
        <p className="empty">
          <strong>Nothing to diagnose yet</strong>
          The diagnosis appears after the first completed run: which questions are lost, why, and which sites to get listed on.
        </p>
      </section>
    );
  }

  const client = tracker.client.name;
  const lost = d.prompts.filter((p) => p.status === 'lost');
  const shownLost = showAll ? lost : lost.slice(0, QUESTIONS_SHOWN);

  return (
    <div className="diagnosis">
      {d.status === 'pending' && (
        <p className="notice" role="status">
          Opening the pages the engines cited, to check whether they list {client}. The causes below update as each page is checked.
        </p>
      )}

      <div className="grid-4">
        <div className="card stat">
          <span className="label">Questions lost</span>
          <strong>{d.totals.lost}<span className="of"> of {d.totals.questions}</span></strong>
          <p className="muted">A competitor was named more often</p>
        </div>
        <div className="card stat">
          <span className="label">Citation gaps</span>
          <strong>{d.totals.gaps}</strong>
          <p className="muted">{d.totals.gaps === 1 ? 'Site' : 'Sites'} citing competitors only</p>
        </div>
        <div className="card stat">
          <span className="label">Website readiness</span>
          <strong>{d.site?.findings ? <>{d.site.passed}<span className="of"> of {d.site.findings.checks.length}</span></> : '–'}</strong>
          <p className="muted">{d.site?.findings ? 'Checks passed' : d.site?.status === 'pending' ? 'Being checked' : 'Not checked yet'}</p>
        </div>
        <div className="card stat">
          <span className="label">Sites cited</span>
          <strong>{d.totals.domains}</strong>
          <p className="muted">{d.totals.uncitedAnswers} of {d.totals.answers} answers cited nothing</p>
        </div>
      </div>

      <section className="card flush" aria-labelledby="lost-head">
        <div className="card-head">
          <div>
            <h2 id="lost-head">Why questions are lost</h2>
            <p className="muted small">
              One cause per lost question, worked out from what the answers cited. It describes what the engines did; it can’t prove why.
            </p>
          </div>
        </div>
        {lost.length === 0 ? (
          <p className="empty">
            <strong>No question lost in this run</strong>
            {client} was named at least as often as every competitor on each question it was asked.
          </p>
        ) : (
          <>
            <ol className="causes">
              {shownLost.map((p) => (
                <LostQuestion key={p.id} prompt={p} client={client} />
              ))}
            </ol>
            {lost.length > QUESTIONS_SHOWN && (
              <button className="show-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
                {showAll ? 'Show fewer' : `Show all ${lost.length} lost questions`}
              </button>
            )}
          </>
        )}
        {(d.totals.open > 0 || d.totals.won > 0) && (
          <p className="causes-foot muted small">
            {d.totals.won} won and {d.totals.open} with no brand named are left out.{' '}
            <button className="link" onClick={() => onGoTo('visibility')}>See every question</button>
          </p>
        )}
      </section>

      <Gaps diagnosis={d} client={client} />
      <SourceMap view={view} onChanged={refresh} />
      <Readiness diagnosis={d} clientId={clientId} hasDomain={Boolean(tracker.client.domain)} onChanged={refresh} onGoTo={onGoTo} />
      <p className="muted small">Diagnosis of the run completed {formatDate(run.finishedAt ?? run.createdAt)}. Pick another run under Runs and schedule.</p>
    </div>
  );
}

function LostQuestion({ prompt: p, client }: { prompt: DiagnosisPrompt; client: string }) {
  const lostOn = p.engines.filter((e) => e.lost);
  const [open, setOpen] = useState(false);
  const sources = p.cause?.sources ?? [];
  const visible = open ? sources : sources.slice(0, SOURCES_SHOWN);
  return (
    <li>
      <div className="cause-head">
        <h3>
          {p.priority && <span className="sr-only">Priority: </span>}
          {p.priority && <Icon name="target" />}
          {p.text}
        </h3>
        <span className="tags">
          {lostOn.map((e) => (
            <span key={e.key} className="pill bad">Lost on {e.label}</span>
          ))}
        </span>
      </div>
      <p className="cause-evidence muted small">
        {client} named in {p.clientAnswers} of {p.answers} answers
        {p.leader && `; ${p.leader.name} in ${p.leader.answers}`}.
      </p>
      {p.cause && (
        <>
          <p className="cause-sentence">{p.cause.sentence}</p>
          {p.cause.note && <p className="muted small cause-note">{p.cause.note}</p>}
          <ul className="cause-sources">
            {visible.map((s) => (
              <Source key={s.url} source={s} client={client} />
            ))}
          </ul>
          {sources.length > SOURCES_SHOWN && (
            <button className="link quiet small-link" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Fewer sources' : `${sources.length - SOURCES_SHOWN} more ${sources.length - SOURCES_SHOWN === 1 ? 'source' : 'sources'}`}
            </button>
          )}
        </>
      )}
    </li>
  );
}

function Source({ source: s, client }: { source: DiagnosisSource; client: string }) {
  const badge = s.check ? CHECK_BADGE[s.check] : null;
  return (
    <li>
      <span className={`type-tag t-${s.type}`}>{s.typeLabel}</span>
      <a href={s.url} target="_blank" rel="noopener noreferrer" className="source-link">
        <span className="source-title">{s.title ?? s.domain}</span>
        {s.title && <span className="muted"> · {s.domain}</span>}
      </a>
      {badge && <span className={`pill ${badge.tone}`}>{badge.label(client)}</span>}
      {s.answers > 0 && !s.elsewhere && <span className="muted small">{s.answers} {s.answers === 1 ? 'answer' : 'answers'}</span>}
    </li>
  );
}

function Gaps({ diagnosis: d, client }: { diagnosis: Diagnosis; client: string }) {
  return (
    <section className="card flush" aria-labelledby="gaps-head">
      <div className="card-head">
        <div>
          <h2 id="gaps-head">Citation gaps</h2>
          <p className="muted small">
            Sites cited at least twice in answers that named a competitor and not {client}. Getting {client} onto these pages is the most direct fix.
          </p>
        </div>
      </div>
      {d.gaps.length === 0 ? (
        <p className="empty">No site was cited twice for competitors without {client} in this run.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Answers</th>
                <th>Names instead</th>
                <th>Pages checked</th>
              </tr>
            </thead>
            <tbody>
              {d.gaps.map((g) => (
                <tr key={g.domain}>
                  <td>
                    <strong>{g.domain}</strong>
                    <span className={`type-tag t-${g.type}`}>{g.typeLabel}</span>
                    <div className="gap-urls">
                      {g.urls.map((u) => (
                        <a key={u.url} href={u.url} target="_blank" rel="noopener noreferrer">{u.title ?? new URL(u.url).pathname}</a>
                      ))}
                    </div>
                  </td>
                  <td>
                    {g.answers} <span className="muted small">in {g.questions} {g.questions === 1 ? 'question' : 'questions'}</span>
                  </td>
                  <td>{g.competitors.join(', ')}</td>
                  <td>
                    {g.pages.checked === 0 && g.pages.failed === 0 ? (
                      <span className="muted">Not yet</span>
                    ) : (
                      <>
                        {g.pages.checked > 0 && (
                          <span className={`pill ${g.pages.listsClient === 0 ? 'bad' : g.pages.listsClient === g.pages.checked ? 'ok' : 'warn'}`}>
                            {g.pages.listsClient === 0 ? `None list ${client}` : `${g.pages.listsClient} of ${g.pages.checked} list ${client}`}
                          </span>
                        )}
                        {g.pages.failed > 0 && <span className="muted small"> {g.pages.failed} couldn’t be opened</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SourceMap({ view, onChanged }: { view: DiagnosisView; onChanged: () => Promise<void> }) {
  const d = view.diagnosis!;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const total = d.sources.byType.reduce((sum, t) => sum + t.answers, 0);

  async function setType(domain: string, type: string | null) {
    setBusy(domain);
    setError('');
    try {
      if (type) await send('PUT', `/v1/source-types/${encodeURIComponent(domain)}`, { type });
      else await send('DELETE', `/v1/source-types/${encodeURIComponent(domain)}`);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  }

  return (
    <section className="card flush" aria-labelledby="map-head">
      <div className="card-head">
        <div>
          <h2 id="map-head">Where the answers come from</h2>
          <p className="muted small">Every site the engines cited, by type; the bar shows how many answers cited each type. If a site is in the wrong type, change it here: it changes for all your clients.</p>
        </div>
      </div>
      {total > 0 && (
        <div className="type-map">
          <div className="type-bar" role="img" aria-label={`Answers citing each type: ${d.sources.byType.filter((t) => t.answers).map((t) => `${t.label} ${t.answers}`).join(', ')}`}>
            {TYPE_ORDER.map((type) => {
              const t = d.sources.byType.find((x) => x.type === type)!;
              return t.answers ? <span key={type} className={`t-${type}`} style={{ flexGrow: t.answers }} /> : null;
            })}
          </div>
          <ul className="type-legend">
            {TYPE_ORDER.map((type) => {
              const t = d.sources.byType.find((x) => x.type === type)!;
              return (
                <li key={type} className={t.domains ? undefined : 'none'}>
                  <span className={`swatch t-${type}`} aria-hidden="true" />
                  <strong>{t.label}</strong>
                  <span className="muted small">
                    {t.domains} {t.domains === 1 ? 'site' : 'sites'} · {t.answers} {t.answers === 1 ? 'answer' : 'answers'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {error && <p className="error" role="alert" style={{ margin: '0 24px 12px' }}>{error}</p>}
      {d.sources.domains.length === 0 ? (
        <p className="empty">The engines cited no sources in this run.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Type</th>
                <th>Answers</th>
                <th>Named the client</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.domains.map((s) => (
                <tr key={s.domain}>
                  <td>
                    <a href={s.topUrl} target="_blank" rel="noopener noreferrer">{s.domain}</a>
                    {s.competitor && <span className="muted small"> · {s.competitor}</span>}
                  </td>
                  <td>
                    {s.type === 'own' || s.type === 'competitor' ? (
                      <span className={`type-tag t-${s.type}`}>{s.typeLabel}</span>
                    ) : (
                      <span className="type-pick">
                        <label className="sr-only" htmlFor={`type-${s.domain}`}>Type of {s.domain}</label>
                        <select id={`type-${s.domain}`} value={s.type} disabled={busy === s.domain} onChange={(e) => setType(s.domain, e.target.value)}>
                          {view.sourceTypes.map((t) => (
                            <option key={t.type} value={t.type}>{t.label}</option>
                          ))}
                        </select>
                        {s.corrected && (
                          <button className="link quiet" onClick={() => setType(s.domain, null)} disabled={busy === s.domain} title="Use the automatic type again">
                            Reset
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{s.answers}</td>
                  <td>{s.withClient} of {s.answers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Readiness({ diagnosis: d, clientId, hasDomain, onChanged, onGoTo }: { diagnosis: Diagnosis; clientId: string; hasDomain: boolean; onChanged: () => Promise<void>; onGoTo: (tab: 'brands') => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const site = d.site;
  const findings = site?.findings;

  async function checkAgain() {
    setBusy(true);
    setError('');
    try {
      await send('POST', `/v1/clients/${clientId}/site-check`);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <section className="card flush" aria-labelledby="ready-head">
      <div className="card-head">
        <div>
          <h2 id="ready-head">Website readiness for AI search</h2>
          <p className="muted small">
            {site?.status === 'pending'
              ? 'Checking the website now…'
              : findings
                ? `${site!.passed} of ${findings.checks.length} checks passed, across ${findings.pagesChecked} ${findings.pagesChecked === 1 ? 'page' : 'pages'}, on ${formatDate(site!.checkedAt)}. Checked again with the next run after a week.`
                : site?.status === 'failed'
                  ? `The last check failed: ${site.error ?? 'the site could not be read'}.`
                  : 'Checked automatically after a run, at most once a week.'}
          </p>
          {site?.mode === 'mock' && <p className="muted small">Demo check: made against a stand-in website, not the real one.</p>}
        </div>
        {hasDomain ? (
          <button className="secondary sm" onClick={checkAgain} disabled={busy || site?.status === 'pending'}>
            <Icon name="refresh" />
            {site?.status === 'pending' ? 'Checking…' : 'Check again'}
          </button>
        ) : (
          <button className="secondary sm" onClick={() => onGoTo('brands')}>Add the website</button>
        )}
      </div>
      {error && <p className="error" role="alert" style={{ margin: '0 24px 12px' }}>{error}</p>}
      {findings && (
        <ul className="checks">
          {findings.checks.map((c) => (
            <li key={c.key}>
              <span className={`pill ${CHECK[c.status].tone}`}>{CHECK[c.status].label}</span>
              <div>
                <strong>{c.label}</strong>
                <p className="muted">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
