'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { load } from '@/lib/client';
import { ENGINE_LABEL, type AuditReport, type CheckStatus, type Fix } from '@/lib/types';
import { Measure } from '../workspace/VisibilityTab';

const CHECK: Record<CheckStatus, { label: string; tone: string }> = {
  pass: { label: 'Passed', tone: 'ok' },
  warn: { label: 'Needs work', tone: 'warn' },
  fail: { label: 'Failed', tone: 'bad' },
  unknown: { label: 'Not checked', tone: '' },
};
const EFFORT: Record<Fix['effort'], string> = { quick: 'Quick fix', some: 'Some work', project: 'Bigger project' };

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

interface Props {
  initial: AuditReport;
  /** Where to re-read the report while it is still running. */
  pollUrl: string;
  /** The agency's logo or name: shown on the public page, and on paper for the in-app view. */
  brand: ReactNode;
  isPublic: boolean;
  cta?: { label: string; url: string } | null;
  agencyName: string;
}

export function ReportView({ initial, pollUrl, brand, isPublic, cta, agencyName }: Props) {
  const [report, setReport] = useState(initial);
  const running = report.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const next = await load<{ report: AuditReport }>(pollUrl);
        setReport((current) => ({ ...current, ...next.report }));
      } catch {
        // The next poll catches up.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [running, pollUrl]);

  const v = report.visibility;
  const engineNames = list(report.run.engines.map((k) => ENGINE_LABEL[k] ?? k));
  const findings = report.site.findings;

  return (
    <article className="report">
      <header className={`report-head${isPublic ? '' : ' print-only'}`}>{brand}</header>

      <div className="report-title">
        <span className="label">AI visibility audit</span>
        <h1>{report.business}</h1>
        <p className="sub">
          {[report.domain, report.category, report.location].filter(Boolean).join(' · ')} · {formatDate(report.completedAt ?? report.createdAt)}
        </p>
      </div>

      {report.demo && (
        <p className="notice warn" role="note">
          <strong>Demo data.</strong> This audit used generated stand-in answers and a made-up website, not real results.
        </p>
      )}

      {running && (
        <section className="card progress-card" aria-live="polite">
          <h2>Preparing the report</h2>
          <p className="muted small">This usually takes a few minutes. The page updates on its own.</p>
          <div className="progress-steps">
            <div>
              <div className="measure-head">
                <span>Asking {engineNames} the questions buyers ask</span>
                <span className="measure-value"><strong>{report.run.done}</strong> of {report.run.totalCalls}</span>
              </div>
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={report.run.totalCalls} aria-valuenow={report.run.done}>
                <span style={{ width: `${Math.round((report.run.done / Math.max(report.run.totalCalls, 1)) * 100)}%` }} />
              </div>
            </div>
            <div>
              <div className="measure-head">
                <span>Checking {report.domain} for AI crawlers and structure</span>
                <span className="measure-value">{report.site.status === 'pending' ? 'In progress' : 'Done'}</span>
              </div>
              <div className="bar"><span style={{ width: report.site.status === 'pending' ? '35%' : '100%' }} /></div>
            </div>
          </div>
        </section>
      )}

      {report.status === 'failed' && (
        <p className="notice" role="note">
          The AI assistants could not be reached for this audit, so there are no answers to report. {isPublic ? `${agencyName} will be in touch.` : 'No credits were used for the failed calls. Try a new audit later.'}
        </p>
      )}

      {v && (
        <>
          <div className="grid-main">
            <section className="card" aria-label="Named in AI answers">
              <span className="label">{report.business} was named in</span>
              <div className="figure">
                <strong>{v.totals.mentioned}</strong>
                <span className="of">of {v.totals.answers} AI answers</span>
              </div>
              <p className="muted small" style={{ margin: '8px 0 0' }}>
                We asked {report.run.promptCount} questions a buyer might ask, {report.run.samples === 1 ? 'once' : `${report.run.samples} times`} on each assistant.
              </p>
              <div className="measures">
                {v.engines.map((e) => (
                  <Measure key={e.key} label={e.label} part={e.mentioned} whole={e.answers} />
                ))}
              </div>
            </section>
            <aside className="panel" aria-label="Who the answers name">
              <div className="panel-inner">
                <span className="label">Share of voice</span>
                <h2>Who the answers name</h2>
                <div className="measures tight">
                  {v.brands.map((b) => (
                    <Measure key={b.id ?? 'client'} label={b.name} part={b.mentions} whole={v.totals.answers} strong={b.isClient} />
                  ))}
                </div>
              </div>
            </aside>
          </div>

          {report.fixes.length > 0 && (
            <section className="card">
              <div className="card-head">
                <div>
                  <h2>The first {report.fixes.length === 1 ? 'fix' : `${report.fixes.length} fixes`}</h2>
                  <p className="muted small">Most important first.</p>
                </div>
              </div>
              <ol className="fixes">
                {report.fixes.map((fix) => (
                  <li key={fix.key}>
                    <div>
                      <strong>{fix.title}</strong>
                      <p className="muted">{fix.why}</p>
                    </div>
                    <span className="pill">{EFFORT[fix.effort]}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {report.missing.length > 0 && (
            <section className="card flush">
              <div className="card-head">
                <div>
                  <h2>Questions where competitors are named instead</h2>
                  <p className="muted small">{report.business} was not named in any answer to these.</p>
                </div>
              </div>
              <table>
                <tbody>
                  {report.missing.map((m) => (
                    <tr key={m.id}>
                      <td>“{m.text}”</td>
                      <td className="actions">
                        {m.competitors.map((c) => (
                          <span key={c} className="pill" style={{ marginLeft: 6 }}>{c}</span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.gaps.length > 0 && (
            <section className="card flush">
              <div className="card-head">
                <div>
                  <h2>Sites the assistants rely on</h2>
                  <p className="muted small">Cited in answers that did not name {report.business}. Being listed on them is a direct way in.</p>
                </div>
              </div>
              <table>
                <tbody>
                  {report.gaps.map((g) => (
                    <tr key={g.domain}>
                      <td><strong>{g.domain}</strong></td>
                      <td className="actions"><strong>{g.answers}</strong> {g.answers === 1 ? 'answer' : 'answers'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {!running && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>How ready {report.domain} is for AI search</h2>
              <p className="muted small">
                {findings
                  ? `${report.site.passed} of ${findings.checks.length} checks passed, across ${findings.pagesChecked} ${findings.pagesChecked === 1 ? 'page' : 'pages'}.`
                  : 'The website could not be checked this time.'}
              </p>
            </div>
          </div>
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
      )}

      {!running && (
        <p className="method muted small">
          {report.run.promptCount} questions were asked {report.run.samples === 1 ? 'once' : `${report.run.samples} times`} on {engineNames} on{' '}
          {formatDate(report.completedAt ?? report.createdAt)}. AI answers change from day to day, so treat this as a snapshot, not a ranking.
          {v && v.totals.failed > 0 && ` ${v.totals.failed} calls failed and are not counted.`}
        </p>
      )}

      {isPublic && (
        <section className="card cta-card">
          <div>
            <h2>Want help closing these gaps?</h2>
            <p className="muted">Prepared for {report.business} by {agencyName}.</p>
          </div>
          {cta && (
            <a className="button no-print" href={cta.url} target="_blank" rel="noopener noreferrer">
              {cta.label}
            </a>
          )}
        </section>
      )}
    </article>
  );
}
