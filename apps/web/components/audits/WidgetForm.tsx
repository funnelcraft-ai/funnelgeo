'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { send } from '@/lib/client';

/** Tells the page around the frame how tall the form is, so it never scrolls inside. */
function useReportHeight(deps: unknown) {
  useEffect(() => {
    if (window.parent === window) return;
    // Measure the form itself: the page around it always fills the frame.
    const content = document.querySelector('.embed');
    if (!content) return;
    const post = () => window.parent.postMessage({ type: 'ai-visibility-audit:height', height: Math.ceil(content.getBoundingClientRect().height) + 2 }, '*');
    post();
    const observer = new ResizeObserver(post);
    observer.observe(content);
    return () => observer.disconnect();
  }, [deps]);
}

export function WidgetForm({ agencyName }: { agencyName: string }) {
  const [sent, setSent] = useState<{ email: string; business: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useReportHeight(sent ?? error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setError('');
    setBusy(true);
    try {
      const res = await send<{ email: string }>('POST', '/v1/widget/audits', {
        businessName: data.businessName,
        website: data.website,
        category: data.category,
        location: data.location || undefined,
        name: data.name || undefined,
        email: data.email,
        company: data.company || undefined,
      });
      setSent({ email: res.email, business: data.businessName ?? '' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="widget-card" role="status">
        <h1>Your report is on its way</h1>
        <p>
          We are asking ChatGPT, Perplexity and Gemini about {sent.business} and checking its website. The report will arrive at <strong>{sent.email}</strong> in a few minutes.
        </p>
      </div>
    );
  }

  return (
    <form className="widget-card" onSubmit={submit}>
      <h1>Free AI visibility report</h1>
      <p className="muted">See whether ChatGPT, Perplexity and Gemini recommend your business, and what to fix first.</p>
      <div className="field">
        <label htmlFor="businessName">Business name</label>
        <input id="businessName" name="businessName" type="text" required maxLength={160} autoComplete="organization" />
      </div>
      <div className="field">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" required placeholder="yourbusiness.com" autoComplete="url" />
      </div>
      <div className="row top">
        <div className="field">
          <label htmlFor="category">What you do</label>
          <input id="category" name="category" type="text" required maxLength={120} placeholder="dental clinic" />
        </div>
        <div className="field">
          <label htmlFor="location">City or country</label>
          <input id="location" name="location" type="text" maxLength={120} />
        </div>
      </div>
      <div className="row top">
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" type="text" maxLength={120} autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </div>
      </div>
      {/* Left empty by people; bots that fill every field are quietly ignored. */}
      <div className="trap" aria-hidden="true">
        <label htmlFor="company">Company website</label>
        <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="block" disabled={busy}>{busy ? 'Sending…' : 'Email me the report'}</button>
      <p className="fineprint">{agencyName} uses these details to send your report and to follow up about it.</p>
    </form>
  );
}
