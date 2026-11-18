import type { ReactNode } from 'react';
import type { MonthlyReportData, ReportRate } from '@/lib/types';

/**
 * The monthly report as the client sees it: on the live link, in the PDF
 * (printed from the live link), and as the preview in the editor. The
 * summary and plan slots let the editor swap in text boxes.
 */

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);
const of = (r: ReportRate) => `${r.named} of ${r.answers}`;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const CHANGE: Record<string, { text: string; tone: string }> = {
  improved: { text: 'Improved', tone: 'ok' },
  no_change: { text: 'No clear change', tone: '' },
  declined: { text: 'Declined', tone: 'bad' },
  too_early: { text: 'Too early to tell', tone: '' },
};

/** Plan text: lines starting with "- " become a list; anything else is a paragraph. */
export function PlanText({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^[-*•]\s+/.test(l));
  if (items.length === lines.length) return <ul className="r-plan">{items.map((l, i) => <li key={i}>{l.replace(/^[-*•]\s+/, '')}</li>)}</ul>;
  return <>{lines.map((l, i) => <p key={i}>{l.replace(/^[-*•]\s+/, '• ')}</p>)}</>;
}

export function SummaryText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</>;
}

function Delta({ now, before }: { now: ReportRate; before: ReportRate | null }) {
  if (!before || now.rate === null || before.rate === null) return <span className="muted">no earlier figure</span>;
  const points = Math.round((now.rate - before.rate) * 100);
  return (
    <span className={points > 0 ? 'r-up' : points < 0 ? 'r-down' : 'muted'}>
      {points > 0 ? '+' : ''}
      {points} pts <span className="muted">(was {pct(before.rate)} of {before.answers})</span>
    </span>
  );
}

export function ClientReport({
  data,
  agencyName,
  logoUrl,
  summary,
  plan,
  footer,
}: {
  data: MonthlyReportData;
  agencyName: string;
  logoUrl: string | null;
  summary: ReactNode;
  plan: ReactNode;
  footer?: ReactNode;
}) {
  const d = data;
  const sovMax = Math.max(1, ...d.shareOfVoice.map((b) => b.answers));
  return (
    <article className="client-report">
      <header className="r-head">
        <div className="r-brand">
          {logoUrl ? <img src={logoUrl} alt={agencyName} /> : <strong>{agencyName}</strong>}
        </div>
        <div>
          <p className="r-kicker">AI visibility report · {d.period.label}</p>
          <h1>{d.client.name}</h1>
          <p className="muted">
            How often ChatGPT and other AI assistants name {d.client.name} when buyers ask them for recommendations.
          </p>
        </div>
      </header>

      {d.demo && <p className="r-demo">Demo data: these figures come from stand-in answers, not real AI assistants.</p>}

      <section className="r-section r-summary">
        <h2>Summary</h2>
        {summary}
      </section>

      <section className="r-section">
        <h2>Visibility</h2>
        <div className="r-kpis">
          <div>
            <span className="r-label">Named in AI answers</span>
            <strong>{pct(d.overall.rate)}</strong>
            <span className="muted">{of(d.overall)} answers · {d.runs} {d.runs === 1 ? 'run' : 'runs'}</span>
          </div>
          <div>
            <span className="r-label">Change from {d.previous.label}</span>
            <strong className="r-delta"><Delta now={d.overall} before={d.overallBefore} /></strong>
          </div>
          <div>
            <span className="r-label">AI visits to the website</span>
            <strong>{d.visits.installed ? d.visits.total.toLocaleString() : '–'}</strong>
            <span className="muted">{d.visits.installed ? `${d.visits.conversions} ${d.visits.conversions === 1 ? 'conversion' : 'conversions'}` : 'tracking not installed'}</span>
          </div>
        </div>
        {d.engines.length === 0 ? (
          <p className="muted">No completed runs in this period.</p>
        ) : (
          <table className="r-table">
            <thead>
              <tr><th>AI assistant</th><th>Named</th><th>Answers</th><th>Change</th></tr>
            </thead>
            <tbody>
              {d.engines.map((e) => (
                <tr key={e.key}>
                  <td>{e.label}</td>
                  <td><span className="r-bar"><span style={{ width: `${(e.now.rate ?? 0) * 100}%` }} /></span> {pct(e.now.rate)}</td>
                  <td>{of(e.now)}</td>
                  <td><Delta now={e.now} before={e.before} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.trend.length > 1 && (
          <div className="r-trend">
            <span className="r-label">By run</span>
            <div className="r-trend-bars">
              {d.trend.map((t) => (
                <div key={t.date}>
                  <span className="r-trend-bar" style={{ height: `${Math.max((t.rate ?? 0) * 100, 2)}%` }} />
                  <span className="r-trend-label">{day(t.date)}<br />{pct(t.rate)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="r-section">
        <h2>Share of voice</h2>
        <p className="muted">How many of the period’s answers named each brand, as a share of all mentions of the brands tracked.</p>
        <ul className="r-sov">
          {d.shareOfVoice.map((b) => (
            <li key={b.name} className={b.isClient ? 'is-client' : undefined}>
              <span className="r-sov-name">{b.name}</span>
              <span className="r-bar wide"><span style={{ width: `${(b.answers / sovMax) * 100}%` }} /></span>
              <span className="r-sov-value">{pct(b.share)} <span className="muted">· {b.answers} {b.answers === 1 ? 'answer' : 'answers'}</span></span>
            </li>
          ))}
        </ul>
      </section>

      <section className="r-section">
        <h2>What we did</h2>
        {d.actionsDone.length === 0 ? (
          <p className="muted">No actions were finished in this period.</p>
        ) : (
          <ul className="r-actions">
            {d.actionsDone.map((a, i) => (
              <li key={i}>
                <div className="r-action-head">
                  <strong>{a.title}</strong>
                  {a.change && <span className={`pill ${CHANGE[a.change]!.tone}`}>{CHANGE[a.change]!.text}</span>}
                </div>
                <p className="muted">
                  {a.type} · done {day(a.doneAt)}
                  {a.url && <> · <a href={a.url}>{a.url.replace(/^https?:\/\//, '')}</a></>}
                  {a.note && <> · {a.note}</>}
                </p>
                {a.changeSentence && <p>{a.changeSentence}</p>}
              </li>
            ))}
          </ul>
        )}
        {d.actionsDone.some((a) => a.change) && (
          <p className="muted small">Each change compares the four weeks before an action with the time since. AI answers move for many reasons, so this is what followed the action, not proof it caused it.</p>
        )}
      </section>

      <section className="r-section">
        <h2>Visits from AI assistants</h2>
        {!d.visits.installed ? (
          <p className="muted">The tracking snippet isn’t on the website yet, so visits from AI assistants aren’t counted.</p>
        ) : d.visits.total === 0 ? (
          <p className="muted">No visits from AI assistants were recorded in this period ({d.visits.totalBefore} in {d.previous.label}).</p>
        ) : (
          <div className="r-two">
            <div>
              <p>
                <strong>{d.visits.total}</strong> {d.visits.total === 1 ? 'visit' : 'visits'} in {d.period.label}, against {d.visits.totalBefore} in {d.previous.label}.
              </p>
              <ul className="r-list">
                {d.visits.byEngine.map((v) => (
                  <li key={v.label}>{v.label}: {v.visits}{v.conversions ? `, ${v.conversions} converted` : ''}</li>
                ))}
              </ul>
            </div>
            <div>
              <span className="r-label">Pages they landed on</span>
              <ul className="r-list">
                {d.visits.pages.map((p) => (
                  <li key={p.path}><code>{p.path}</code> · {p.visits}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      <section className="r-section">
        <h2>Next month</h2>
        {plan}
      </section>

      <section className="r-section r-method">
        <h2>How this is measured</h2>
        <p>
          Each run asks {d.method.engines.length ? d.method.engines.join(', ') : 'the AI assistants'} the {d.questions} {d.questions === 1 ? 'question' : 'questions'} buyers ask
          {d.method.samplesPerQuestion ? `, ${d.method.samplesPerQuestion} times each,` : ''} and records whether {d.client.name} is named. AI answers vary from one asking to the next, so every figure is a share of many
          answers, shown with how many it is out of. Visits are counted by a small script on the website when the visitor came from an AI assistant; visits from Google’s AI Overviews look like ordinary search and can’t be counted.
        </p>
        <p className="muted">Period: {day(d.period.start)} to {day(d.period.end)}. Compared with {d.previous.label}.</p>
      </section>

      <footer className="r-foot">{footer ?? <>Prepared by {agencyName}</>}</footer>
    </article>
  );
}
