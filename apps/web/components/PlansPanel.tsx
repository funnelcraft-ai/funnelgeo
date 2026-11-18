'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/lib/client';
import type { PlanDetail } from '@/lib/types';
import { PageHead } from './Shell';

interface Draft {
  key: string;
  name: string;
  monthlyCredits: string;
  clientLimit: string;
  promptsPerClient: string;
  samplesPerPrompt: string;
  auditsPerMonth: string;
  priceAmount: string;
  currency: 'INR' | 'USD';
}

const blank: Draft = { key: '', name: '', monthlyCredits: '1000', clientLimit: '5', promptsPerClient: '25', samplesPerPrompt: '3', auditsPerMonth: '10', priceAmount: '', currency: 'INR' };

const toDraft = (p: PlanDetail): Draft => ({
  key: p.key,
  name: p.name,
  monthlyCredits: String(p.monthlyCredits),
  clientLimit: String(p.clientLimit),
  promptsPerClient: String(p.promptsPerClient),
  samplesPerPrompt: String(p.samplesPerPrompt),
  auditsPerMonth: String(p.auditsPerMonth),
  priceAmount: p.price ? String(p.price.amount) : '',
  currency: (p.price?.currency as 'INR' | 'USD') ?? 'INR',
});

const fromDraft = (d: Draft) => ({
  name: d.name.trim(),
  monthlyCredits: Number(d.monthlyCredits),
  clientLimit: Number(d.clientLimit),
  promptsPerClient: Number(d.promptsPerClient),
  samplesPerPrompt: Number(d.samplesPerPrompt),
  auditsPerMonth: Number(d.auditsPerMonth),
  price: d.priceAmount.trim() === '' ? null : { amount: Number(d.priceAmount), currency: d.currency },
});

const money = (p: PlanDetail['price']) =>
  p ? new Intl.NumberFormat(p.currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: p.currency, maximumFractionDigits: 0 }).format(p.amount) : 'Not set';

export function PlansPanel({ plans }: { plans: PlanDetail[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function open(key: string | 'new') {
    setError('');
    setEditing(key);
    setDraft(key === 'new' ? blank : toDraft(plans.find((p) => p.key === key)!));
  }

  async function save() {
    setError('');
    setBusy(true);
    try {
      if (editing === 'new') await send('POST', '/v1/admin/plans', { key: draft.key.trim(), ...fromDraft(draft), active: true });
      else await send('PATCH', `/v1/admin/plans/${editing}/details`, fromDraft(draft));
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(plan: PlanDetail, active: boolean) {
    setError('');
    try {
      await send('PATCH', `/v1/admin/plans/${plan.key}/details`, { active });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field = (k: keyof Draft, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={`plan-${k}`}>{label}</label>
      <input id={`plan-${k}`} type={k === 'name' || k === 'key' ? 'text' : 'number'} min={0} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );

  return (
    <>
      <PageHead crumbs="Platform / Plans" title="Plans" sub="What each plan allows. Changes apply at once to every agency on the plan, this month included.">
        <button onClick={() => open('new')}>New plan</button>
      </PageHead>

      {error && !editing && <p className="error" role="alert">{error}</p>}

      {editing && (
        <div className="card">
          <div className="card-head"><h2>{editing === 'new' ? 'New plan' : `Edit ${plans.find((p) => p.key === editing)?.name}`}</h2></div>
          <div className="plan-form">
            {editing === 'new' && field('key', 'Key', 'Lowercase letters, numbers and dashes. It can’t be changed later.')}
            {field('name', 'Name')}
            {field('monthlyCredits', 'Credits each month')}
            {field('clientLimit', 'Clients')}
            {field('promptsPerClient', 'Questions per client')}
            {field('samplesPerPrompt', 'Samples per question', 'How many times each engine is asked each question in a run.')}
            {field('auditsPerMonth', 'Audits each month')}
            <div className="field">
              <label htmlFor="plan-price">Price each month</label>
              <div className="row tight">
                <input id="plan-price" type="number" min={0} placeholder="Not set" value={draft.priceAmount} onChange={(e) => setDraft({ ...draft, priceAmount: e.target.value })} />
                <select aria-label="Currency" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value as 'INR' | 'USD' })} style={{ width: 96, flex: 'none' }}>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <p className="hint">Used for margin on the Costs page. Agencies aren’t charged through the platform yet.</p>
            </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="toolbar">
            <button disabled={busy} onClick={save}>{editing === 'new' ? 'Create plan' : 'Save changes'}</button>
            <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Credits</th>
              <th>Clients</th>
              <th>Questions</th>
              <th>Samples</th>
              <th>Audits</th>
              <th>Price</th>
              <th>Agencies</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.key} className={p.active ? undefined : 'retired'}>
                <td>
                  <div className="who-cell">
                    <div>
                      <strong>{p.name}</strong>
                      <span>{p.key}{p.active ? '' : ' · retired'}</span>
                    </div>
                  </div>
                </td>
                <td data-label="Credits">{p.monthlyCredits.toLocaleString('en-IN')}</td>
                <td data-label="Clients">{p.clientLimit}</td>
                <td data-label="Questions">{p.promptsPerClient}</td>
                <td data-label="Samples">{p.samplesPerPrompt}</td>
                <td data-label="Audits">{p.auditsPerMonth}</td>
                <td data-label="Price">{money(p.price)}</td>
                <td data-label="Agencies">{p.agencies}</td>
                <td className="actions">
                  <button className="link" onClick={() => open(p.key)}>Edit</button>
                  {p.active ? (
                    <button className="link quiet" disabled={p.agencies > 0} title={p.agencies > 0 ? 'Move its agencies to another plan first' : undefined} onClick={() => setActive(p, false)}>Retire</button>
                  ) : (
                    <button className="link" onClick={() => setActive(p, true)}>Restore</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Retired plans can’t be chosen for agencies. A plan in use can’t be retired.</p>
    </>
  );
}
