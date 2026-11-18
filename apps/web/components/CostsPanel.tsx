'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { CostReport } from '@/lib/types';
import { PageHead } from './Shell';

const PROVIDERS: Record<string, string> = { openai: 'OpenAI', perplexity: 'Perplexity', gemini: 'Google Gemini', anthropic: 'Anthropic', crawl: 'Page crawling' };
const usd = (v: number | null, digits = 2) => (v === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v));
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const n = (v: number) => v.toLocaleString('en-IN');

export function CostsPanel({ report, months }: { report: CostReport; months: string[] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const t = report.totals;
  const margin = t.revenueUsd === null ? null : t.revenueUsd - t.costUsd;

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Every engine and writing provider gets a row, so an invoice can be entered before any usage shows.
  const providers = ['openai', 'perplexity', 'gemini', 'anthropic'].map(
    (p) => report.providers.find((x) => x.provider === p) ?? { provider: p, costUsd: 0, events: 0, unpriced: 0, invoiceUsd: null, note: null, difference: null, matches: null },
  );

  return (
    <>
      <PageHead crumbs="Platform / Costs" title="Costs and margin" sub="What the AI providers cost, set against each agency’s plan and the providers’ own invoices.">
        <select aria-label="Month" value={report.month} onChange={(e) => router.push(`/admin/costs?month=${e.target.value}`)} style={{ width: 170 }}>
          {months.map((m) => (
            <option key={m} value={m}>{new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</option>
          ))}
        </select>
      </PageHead>

      {error && <p className="error" role="alert">{error}</p>}
      {t.unpriced > 0 && (
        <p className="notice banner warn" role="status">
          {n(t.unpriced)} calls this month have no price, so the costs below are too low. Add the missing models under Prices.
        </p>
      )}

      <div className="grid-3">
        <div className="card stat">
          <span className="label">Provider cost</span>
          <strong>{usd(t.costUsd)}</strong>
          <p className="muted">{n(t.used)} credits used · {usd(report.platformCostUsd)} by the platform itself</p>
        </div>
        <div className="card stat">
          <span className="label">Plan revenue</span>
          <strong>{usd(t.revenueUsd)}</strong>
          <p className="muted">{t.revenueUsd === null ? 'Set plan prices to see revenue' : report.fx.usdInr ? `Rupee plans at ₹${report.fx.usdInr} to the dollar` : 'Dollar plans only'}</p>
        </div>
        <div className="card stat">
          <span className="label">Margin</span>
          <strong>{usd(margin)}</strong>
          <p className="muted">{margin === null || !t.revenueUsd ? 'Needs plan prices' : `${pct(margin / t.revenueUsd)} of revenue`}</p>
        </div>
      </div>

      <div className="card flush">
        <div className="card-head padded">
          <div>
            <h2>Against the invoices</h2>
            <p className="muted small">Type in what each provider billed for the month. Recorded costs should be within 5% of it.</p>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Provider</th><th>Calls</th><th>Recorded</th><th>Invoice (USD)</th><th>Recorded vs invoice</th><th>Check</th></tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <InvoiceRow key={p.provider} month={report.month} p={p} onSave={act} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="card flush">
        <div className="card-head padded"><h2>By agency</h2></div>
        {report.agencies.length === 0 ? (
          <p className="empty">No agencies yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Agency</th><th>Credits used</th><th>Engine calls</th><th>Cost</th><th>Per credit</th><th>Plan price</th><th>Margin</th></tr>
            </thead>
            <tbody>
              {report.agencies.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="who-cell"><div><strong>{a.name}</strong><span>{a.plan}{a.status !== 'active' ? ' · suspended' : ''}</span></div></div>
                  </td>
                  <td data-label="Credits used">
                    {n(a.used)} <span className="muted">of {n(a.allowance + a.granted)}</span>
                    {a.overage > 0 && <span className="pill warn" style={{ marginLeft: 8 }}>+{n(a.overage)} top-up</span>}
                  </td>
                  <td data-label="Engine calls">{n(a.engineCalls)}</td>
                  <td data-label="Cost">
                    {usd(a.costUsd)}
                    {a.unpriced > 0 && <span className="pill warn" style={{ marginLeft: 8 }}>{n(a.unpriced)} unpriced</span>}
                  </td>
                  <td data-label="Per credit">{a.costPerCredit === null ? '—' : usd(a.costPerCredit, 4)}</td>
                  <td data-label="Plan price">{a.price ? `${a.price.currency === 'INR' ? '₹' : '$'}${n(a.price.amount)}` : '—'}</td>
                  <td data-label="Margin">
                    {a.marginUsd === null ? (
                      <span className="muted">{a.price ? 'Set the rupee rate' : 'No price'}</span>
                    ) : (
                      <span className={a.marginUsd < 0 ? 'neg' : undefined}>{usd(a.marginUsd)} <span className="muted">({pct(a.marginPct)})</span></span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-main align-start">
        <PricesCard report={report} onSave={act} />
        <RateCard rate={report.fx.usdInr} onSave={act} />
      </div>
    </>
  );
}

function InvoiceRow({ month, p, onSave }: { month: string; p: CostReport['providers'][number]; onSave: (fn: () => Promise<unknown>) => void }) {
  const [amount, setAmount] = useState(p.invoiceUsd === null ? '' : String(p.invoiceUsd));
  const changed = amount !== (p.invoiceUsd === null ? '' : String(p.invoiceUsd));
  const status =
    p.matches === null ? <span className="pill">No invoice</span>
      : p.matches ? <span className="pill ok">Within 5%</span>
      : p.unpriced > 0 ? <span className="pill warn">Unpriced calls</span>
      : <span className="pill bad">Off by {pct(Math.abs(p.difference ?? 0))}</span>;
  return (
    <tr>
      <td><strong>{PROVIDERS[p.provider] ?? p.provider}</strong></td>
      <td data-label="Calls">{n(p.events)}</td>
      <td data-label="Recorded">{usd(p.costUsd)}{p.unpriced > 0 && <span className="muted small"> · {n(p.unpriced)} unpriced</span>}</td>
      <td data-label="Invoice">
        <div className="row tight">
          <input type="number" min={0} step="0.01" aria-label={`${PROVIDERS[p.provider]} invoice`} placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} />
          {changed && amount !== '' && (
            <button className="sm" onClick={() => onSave(() => send('PUT', `/v1/admin/invoices/${p.provider}/${month}`, { amountUsd: Number(amount), ...(p.note ? { note: p.note } : {}) }))}>Save</button>
          )}
          {p.invoiceUsd !== null && !changed && (
            <button className="link quiet" onClick={() => onSave(async () => { await send('DELETE', `/v1/admin/invoices/${p.provider}/${month}`); setAmount(''); })}>Clear</button>
          )}
        </div>
      </td>
      <td data-label="Recorded vs invoice">{p.difference === null ? '—' : `${p.difference > 0 ? '+' : ''}${pct(p.difference)}`}</td>
      <td>{status}</td>
    </tr>
  );
}

function PricesCard({ report, onSave }: { report: CostReport; onSave: (fn: () => Promise<unknown>) => void }) {
  const [form, setForm] = useState({ provider: 'openai', model: '', inputPerMTok: '', outputPerMTok: '', perRequest: '' });
  // Models seen this month that have no price come first, so the gap is easy to fill.
  const missing = report.models.filter((m) => m.unpriced);
  const prices = report.prices.filter((p) => p.provider !== 'mock');

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Prices</h2>
          <p className="muted small">From each provider’s price page, in US dollars. A model of * covers that provider’s other models.</p>
        </div>
      </div>
      {missing.length > 0 && (
        <p className="notice warn small">
          No price yet for {missing.map((m) => `${m.provider} ${m.model}`).join(', ')}.
        </p>
      )}
      <table className="compact">
        <thead><tr><th>Provider</th><th>Model</th><th>Input / 1M</th><th>Output / 1M</th><th>Per call</th><th /></tr></thead>
        <tbody>
          {prices.map((p) => (
            <tr key={`${p.provider}/${p.model}`}>
              <td>{PROVIDERS[p.provider] ?? p.provider}</td>
              <td><code>{p.model}</code></td>
              <td>{usd(Number(p.inputPerMTok), 2)}</td>
              <td>{usd(Number(p.outputPerMTok), 2)}</td>
              <td>{usd(Number(p.perRequest), 4)}</td>
              <td className="actions">
                <button className="link" onClick={() => setForm({ provider: p.provider, model: p.model, inputPerMTok: String(p.inputPerMTok), outputPerMTok: String(p.outputPerMTok), perRequest: String(p.perRequest) })}>Edit</button>
                {p.provider !== 'crawl' && (
                  <button className="link danger" onClick={() => onSave(() => send('DELETE', `/v1/admin/prices/${p.provider}/${encodeURIComponent(p.model)}`))}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr className="divider" />
      <div className="price-form">
        <select aria-label="Provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
          {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="text" aria-label="Model" placeholder="Model, or *" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        <input type="number" min={0} step="0.001" aria-label="Input price per million tokens" placeholder="Input / 1M" value={form.inputPerMTok} onChange={(e) => setForm({ ...form, inputPerMTok: e.target.value })} />
        <input type="number" min={0} step="0.001" aria-label="Output price per million tokens" placeholder="Output / 1M" value={form.outputPerMTok} onChange={(e) => setForm({ ...form, outputPerMTok: e.target.value })} />
        <input type="number" min={0} step="0.0001" aria-label="Price per call" placeholder="Per call" value={form.perRequest} onChange={(e) => setForm({ ...form, perRequest: e.target.value })} />
        <button
          className="sm"
          disabled={!form.model.trim()}
          onClick={() =>
            onSave(async () => {
              await send('PUT', '/v1/admin/prices', {
                provider: form.provider,
                model: form.model.trim(),
                inputPerMTok: Number(form.inputPerMTok) || 0,
                outputPerMTok: Number(form.outputPerMTok) || 0,
                perRequest: Number(form.perRequest) || 0,
              });
              setForm({ ...form, model: '', inputPerMTok: '', outputPerMTok: '', perRequest: '' });
            })
          }
        >
          Save price
        </button>
      </div>
      <p className="hint">A new price applies to this month’s calls too. Calls where the provider reported its own cost (Perplexity) use that instead.</p>
    </div>
  );
}

function RateCard({ rate, onSave }: { rate: number | null; onSave: (fn: () => Promise<unknown>) => void }) {
  const [value, setValue] = useState(rate === null ? '' : String(rate));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Rupee rate</h2>
          <p className="muted small">Rupees to one US dollar, for margin on plans priced in INR. Provider costs are always in dollars.</p>
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="usd-inr">₹ per $1</label>
          <input id="usd-inr" type="number" min={1} step="0.01" placeholder="e.g. 84.50" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <button disabled={!value || value === String(rate ?? '')} onClick={() => onSave(() => send('PUT', '/v1/admin/settings/USD_INR', { value }))}>Save rate</button>
      </div>
    </div>
  );
}
