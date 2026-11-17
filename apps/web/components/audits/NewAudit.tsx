'use client';

import { useState, type FormEvent } from 'react';
import { send } from '@/lib/client';
import type { AuditEstimate } from '@/lib/types';
import { Icon } from '../Icon';
import { PageHead } from '../Shell';

interface Business {
  business: string;
  domain: string;
  category: string;
  location: string;
}

type Competitor = { name: string; domain: string };

export function NewAudit({ estimate }: { estimate: AuditEstimate }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [details, setDetails] = useState<Business>({ business: '', domain: '', category: '', location: '' });
  const [prompts, setPrompts] = useState('');
  const [competitors, setCompetitors] = useState<Competitor[]>(Array.from({ length: estimate.limits.competitors }, () => ({ name: '', domain: '' })));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState('');

  const lines = prompts.split('\n').map((l) => l.trim()).filter(Boolean);
  const credits = lines.length * estimate.creditsPerPrompt;
  const auditsLeft = Math.max(estimate.quota.max - estimate.quota.used, 0);
  const blocker =
    estimate.engines.length === 0
      ? 'No answer engines are set up yet, so audits cannot run. Your platform administrator needs to add engine API keys.'
      : auditsLeft === 0
        ? 'All of this month’s audits have been used.'
        : null;
  const payload = () => ({ ...details, location: details.location || undefined });

  async function next(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await send<{ prompts: { text: string }[] }>('POST', '/v1/audits/suggest-prompts', { category: details.category, location: details.location || undefined });
      if (!prompts) setPrompts(res.prompts.map((p) => p.text).join('\n'));
      setStep(2);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function suggest() {
    setSuggesting(true);
    setSuggestNote('');
    try {
      const res = await send<{ competitors: string[] }>('POST', '/v1/audits/suggest-competitors', payload());
      const taken = new Set(competitors.map((c) => c.name.trim().toLowerCase()).filter(Boolean));
      const fresh = res.competitors.filter((n) => !taken.has(n.toLowerCase()));
      setCompetitors((rows) => rows.map((row) => (row.name.trim() ? row : { name: fresh.shift() ?? '', domain: '' })));
      setSuggestNote(res.competitors.length ? 'Suggested by an AI assistant. Check them before running.' : 'No suggestions came back. Add competitors you know, or leave this empty.');
    } catch (err) {
      setSuggestNote((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Run this audit? It uses ${credits.toLocaleString()} credits and 1 of your ${auditsLeft} audits left this month.`)) return;
    setError('');
    setBusy(true);
    try {
      const res = await send<{ audit: { id: string } }>('POST', '/v1/audits', {
        ...payload(),
        prompts: lines.map((text) => ({ text })),
        competitors: competitors.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), ...(c.domain.trim() ? { domain: c.domain.trim() } : {}) })),
      });
      window.location.assign(`/audits/${res.audit.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field = (key: keyof Business) => ({
    value: details[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDetails((d) => ({ ...d, [key]: e.target.value })),
  });

  return (
    <>
      <PageHead crumbs="Overview / Audits / New audit" title="New prospect audit" sub="Asks AI assistants what a buyer would ask, checks the website, and gives you a branded report to share." />
      {blocker && <p className="notice warn">{blocker}</p>}
      <ol className="steps" aria-label="Steps">
        <li aria-current={step === 1 ? 'step' : undefined}>1. The business</li>
        <li aria-current={step === 2 ? 'step' : undefined}>2. Questions and competitors</li>
      </ol>

      {step === 1 ? (
        <form className="card narrow" onSubmit={next}>
          <div className="row top" style={{ marginBottom: 16 }}>
            <div className="field">
              <label htmlFor="business">Business name</label>
              <input id="business" type="text" required maxLength={160} autoFocus {...field('business')} />
            </div>
            <div className="field">
              <label htmlFor="domain">Website</label>
              <input id="domain" type="text" required placeholder="example.com" {...field('domain')} />
            </div>
          </div>
          <div className="row top" style={{ marginBottom: 20 }}>
            <div className="field">
              <label htmlFor="category">What the business is</label>
              <input id="category" type="text" required maxLength={120} placeholder="dental clinic" {...field('category')} />
              <p className="hint">In a buyer’s words, as they would type it.</p>
            </div>
            <div className="field">
              <label htmlFor="location">City or country</label>
              <input id="location" type="text" maxLength={120} placeholder="Pune" {...field('location')} />
              <p className="hint">Leave empty if location does not matter.</p>
            </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <button disabled={busy || Boolean(blocker)}>
            {busy ? 'Preparing…' : 'Continue'}
            <Icon name="arrow" />
          </button>
        </form>
      ) : (
        <form onSubmit={run}>
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Questions to ask</h2>
                <p className="muted small">
                  One per line, {lines.length} of {estimate.limits.prompts}. Suggested from “{details.category}”{details.location ? ` in ${details.location}` : ''}; edit freely. Leave out the business’s own name, or it will be named back.
                </p>
              </div>
            </div>
            <label className="sr-only" htmlFor="prompts">Questions, one per line</label>
            <textarea id="prompts" rows={11} value={prompts} onChange={(e) => setPrompts(e.target.value)} />
            {lines.length > estimate.limits.prompts && <p className="error">Use at most {estimate.limits.prompts} questions.</p>}
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Competitors</h2>
                <p className="muted small">Up to {estimate.limits.competitors}, to compare how often each is named.</p>
              </div>
              <button type="button" className="secondary sm" onClick={suggest} disabled={suggesting}>
                {suggesting ? 'Asking…' : 'Suggest competitors'}
              </button>
            </div>
            <div className="competitor-rows">
              {competitors.map((c, i) => (
                <div className="row" key={i}>
                  <div className="field">
                    <label htmlFor={`c-name-${i}`}>Competitor {i + 1}</label>
                    <input
                      id={`c-name-${i}`}
                      type="text"
                      maxLength={160}
                      value={c.name}
                      onChange={(e) => setCompetitors((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`c-domain-${i}`}>Website (optional)</label>
                    <input
                      id={`c-domain-${i}`}
                      type="text"
                      placeholder="example.com"
                      value={c.domain}
                      onChange={(e) => setCompetitors((rows) => rows.map((r, j) => (j === i ? { ...r, domain: e.target.value } : r)))}
                    />
                  </div>
                </div>
              ))}
            </div>
            {suggestNote && <p className="hint" role="status">{suggestNote}</p>}
          </section>

          <section className="card run-summary">
            <div>
              <strong>
                {lines.length} questions, asked {estimate.samples === 1 ? 'once' : `${estimate.samples} times`} on {estimate.engines.join(', ')}
              </strong>
              <p className="muted small">
                {credits.toLocaleString()} credits of {estimate.creditsRemaining.toLocaleString()} left, and 1 of {auditsLeft} audits left this month. Calls that fail are refunded.
              </p>
            </div>
            <div className="toolbar">
              <button type="button" className="secondary" onClick={() => setStep(1)} disabled={busy}>Back</button>
              <button disabled={busy || Boolean(blocker) || lines.length === 0 || lines.length > estimate.limits.prompts}>
                <Icon name="play" />
                {busy ? 'Starting…' : 'Run audit'}
              </button>
            </div>
          </section>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}
    </>
  );
}
