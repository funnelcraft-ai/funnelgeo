'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { load, send } from '@/lib/client';
import type { Run, Tracker, Visibility } from '@/lib/types';
import { Icon } from '../Icon';
import { PageHead } from '../Shell';
import { BrandsTab } from './BrandsTab';
import { DiagnosisTab } from './DiagnosisTab';
import { PromptsTab } from './PromptsTab';
import { RunsTab } from './RunsTab';
import { VisibilityTab } from './VisibilityTab';

type Tab = 'visibility' | 'diagnosis' | 'prompts' | 'brands' | 'runs';

interface Props {
  initial: Tracker;
  initialRun: Run | null;
  initialVisibility: Visibility | null;
  canEdit: boolean;
}

const inFlight = (run: Run | undefined) => run !== undefined && (run.status === 'queued' || run.status === 'running');
export const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function ClientWorkspace({ initial, initialRun, initialVisibility, canEdit }: Props) {
  const [tracker, setTracker] = useState(initial);
  const [shown, setShown] = useState<{ run: Run | null; visibility: Visibility | null }>({ run: initialRun, visibility: initialVisibility });
  const [tab, setTab] = useState<Tab>('visibility');
  // Links from emails open a tab directly: /clients/<id>?tab=diagnosis
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (canEdit && (wanted === 'diagnosis' || wanted === 'prompts' || wanted === 'brands' || wanted === 'runs')) setTab(wanted);
  }, [canEdit]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const clientId = tracker.client.id;
  const current = tracker.runs.find(inFlight);

  const refresh = useCallback(async () => {
    const [nextTracker, latest] = await Promise.all([
      load<Tracker>(`/v1/clients/${clientId}/tracker`),
      load<{ run: Run | null; visibility: Visibility | null }>(`/v1/clients/${clientId}/visibility`),
    ]);
    setTracker(nextTracker);
    setShown(latest);
  }, [clientId]);

  // While a run is in flight, follow its progress, then load the new results.
  const currentId = current?.id;
  useEffect(() => {
    if (!currentId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const { run } = await load<{ run: Run }>(`/v1/runs/${currentId}`);
        if (stopped) return;
        setTracker((t) => ({ ...t, runs: t.runs.map((r) => (r.id === run.id ? run : r)) }));
        if (!inFlight(run)) await refresh();
      } catch {
        // A missed poll is harmless; the next one catches up.
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [currentId, refresh]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setError('');
      try {
        await action();
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh],
  );

  const estimate = tracker.estimate;
  const usable = tracker.engines?.filter((e) => e.available) ?? [];
  const activePrompts = tracker.prompts.filter((p) => p.active).length;

  async function runNow() {
    if (!estimate || !tracker.credits) return;
    const question =
      `Run ${activePrompts} ${activePrompts === 1 ? 'prompt' : 'prompts'} on ${usable.map((e) => e.label).join(', ')}, ` +
      `${tracker.limits?.samples} times each?\n\nThis uses ${estimate.creditsPerRun.toLocaleString()} of your ` +
      `${tracker.credits.remaining.toLocaleString()} remaining credits. Calls that fail are refunded.`;
    if (!window.confirm(question)) return;
    setStarting(true);
    await act(() => send('POST', `/v1/clients/${clientId}/runs`));
    setStarting(false);
    setTab('visibility');
  }

  const showRun = useCallback(
    async (runId: string) => {
      setError('');
      try {
        setShown(await load(`/v1/clients/${clientId}/visibility?run=${runId}`));
        setTab('visibility');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [clientId],
  );

  const blocker = !canEdit
    ? null
    : usable.length === 0
      ? 'No answer engines are set up yet, so runs cannot start. Your platform administrator needs to add engine API keys.'
      : activePrompts === 0
        ? 'Add prompts to start tracking. These are the questions your client’s buyers ask AI assistants.'
        : null;
  const mockShown = shown.run?.engineMode === 'mock' || (tracker.engineMode === 'mock' && !shown.run);

  const tabs: { key: Tab; label: string }[] = canEdit
    ? [
        { key: 'visibility', label: 'Visibility' },
        { key: 'diagnosis', label: 'Diagnosis' },
        { key: 'prompts', label: `Prompts · ${tracker.prompts.length}` },
        { key: 'brands', label: `Brands · ${tracker.competitors.length + 1}` },
        { key: 'runs', label: 'Runs and schedule' },
      ]
    : [
        { key: 'visibility', label: 'Visibility' },
        { key: 'runs', label: 'Runs' },
      ];

  const tablist = useRef<HTMLDivElement>(null);
  const onKey = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const next = tabs[(tabs.findIndex((t) => t.key === tab) + step + tabs.length) % tabs.length]!;
    setTab(next.key);
    tablist.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.key}"]`)?.focus();
  };

  return (
    <>
      <PageHead
        crumbs={`Overview / Clients / ${tracker.client.name}`}
        title={tracker.client.name}
        sub={[tracker.client.domain, shown.run ? `Last completed run ${formatDate(shown.run.finishedAt ?? shown.run.createdAt)}` : 'Not run yet'].filter(Boolean).join(' · ')}
      >
        {canEdit && (
          <button onClick={runNow} disabled={starting || Boolean(current) || Boolean(blocker)}>
            <Icon name="play" />
            {current ? 'Run in progress' : 'Run now'}
          </button>
        )}
      </PageHead>

      {mockShown && (
        <p className="notice warn" role="note">
          <strong>Demo data.</strong> The engines are in mock mode, so these answers are generated stand-ins, not real results from ChatGPT, Perplexity or Gemini.
        </p>
      )}
      {blocker && <p className="notice">{blocker}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {current && (
        <section className="card progress-card" aria-live="polite">
          <div className="card-head">
            <div>
              <h2>Run in progress</h2>
              <p className="muted small">
                {current.okCalls + current.failedCalls} of {current.totalCalls} answers collected
                {current.failedCalls > 0 ? `, ${current.failedCalls} failed` : ''}. You can leave this page; it keeps going.
              </p>
            </div>
          </div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={current.totalCalls} aria-valuenow={current.okCalls + current.failedCalls}>
            <span style={{ width: `${Math.round(((current.okCalls + current.failedCalls) / Math.max(current.totalCalls, 1)) * 100)}%` }} />
          </div>
        </section>
      )}

      <div className="tabs" role="tablist" aria-label="Client sections" ref={tablist} onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.key} role="tab" data-tab={t.key} aria-selected={tab === t.key} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'visibility' && (
          <VisibilityTab
            tracker={tracker}
            run={shown.run}
            visibility={shown.visibility}
            canEdit={canEdit}
            onReparse={(runId) => act(() => send('POST', `/v1/runs/${runId}/reparse`))}
            onGoTo={setTab}
          />
        )}
        {tab === 'diagnosis' && canEdit && <DiagnosisTab tracker={tracker} run={shown.run} onGoTo={setTab} />}
        {tab === 'prompts' && canEdit && <PromptsTab tracker={tracker} act={act} />}
        {tab === 'brands' && canEdit && <BrandsTab tracker={tracker} act={act} />}
        {tab === 'runs' && <RunsTab tracker={tracker} canEdit={canEdit} shownRunId={shown.run?.id ?? null} act={act} onShow={showRun} />}
      </div>
    </>
  );
}

export type Act = (action: () => Promise<unknown>) => Promise<void>;
