'use client';

import { send } from '@/lib/client';
import type { Run, Tracker } from '@/lib/types';
import { formatDateTime, type Act } from './ClientWorkspace';

const STATUS: Record<Run['status'], { label: string; tone: string }> = {
  queued: { label: 'Starting', tone: 'warn' },
  running: { label: 'Running', tone: 'warn' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: '' },
};

interface Props {
  tracker: Tracker;
  canEdit: boolean;
  shownRunId: string | null;
  act: Act;
  onShow: (runId: string) => void;
}

export function RunsTab({ tracker, canEdit, shownRunId, act, onShow }: Props) {
  const { client, estimate, credits } = tracker;
  const weekly = client.schedule === 'weekly';

  return (
    <>
      {canEdit && estimate && credits && (
        <div className="grid-3">
          <div className="card stat">
            <span className="label">Weekly schedule</span>
            <strong>{weekly ? 'On' : 'Off'}</strong>
            <p className="muted">
              {weekly && client.nextRunAt ? `Next run ${formatDateTime(client.nextRunAt)}` : 'Runs only when you press Run now'}
            </p>
            <button
              className="secondary sm"
              style={{ marginTop: 12 }}
              onClick={() => {
                const next = weekly ? 'off' : 'weekly';
                const question = weekly
                  ? 'Turn off the weekly run for this client?'
                  : `Run this client every week? That uses about ${estimate.creditsPerMonth.toLocaleString()} credits a month. ` +
                    (tracker.runs.some((r) => r.status === 'completed') ? '' : 'The first run starts within a minute.');
                if (window.confirm(question)) act(() => send('PUT', `/v1/clients/${client.id}/schedule`, { schedule: next }));
              }}
            >
              {weekly ? 'Turn off' : 'Run every week'}
            </button>
          </div>
          <div className="card stat">
            <span className="label">Cost of one run</span>
            <strong>{estimate.creditsPerRun.toLocaleString()}</strong>
            <p className="muted">
              credits for {estimate.callsPerRun.toLocaleString()} answers; about {estimate.creditsPerMonth.toLocaleString()} a month if weekly
            </p>
          </div>
          <div className="card stat">
            <span className="label">Credits left this month</span>
            <strong>{credits.remaining.toLocaleString()}</strong>
            <p className="muted">of {credits.allowance.toLocaleString()} on your plan, shared by all clients</p>
          </div>
        </div>
      )}

      <div className="card flush">
        <div className="card-head">
          <div>
            <h2>Runs</h2>
            <p className="muted small">The latest {tracker.runs.length === 1 ? 'run' : `${tracker.runs.length} runs`} for this client.</p>
          </div>
        </div>
        {tracker.runs.length === 0 ? (
          <p className="empty">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Answers</th>
                {canEdit && <th>Credits</th>}
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {tracker.runs.map((run) => {
                const status = STATUS[run.status];
                return (
                  <tr key={run.id}>
                    <td>
                      <strong>{formatDateTime(run.createdAt)}</strong>
                      <div className="muted small">
                        {run.trigger === 'scheduled' ? 'Weekly schedule' : 'Started by hand'}
                        {run.engineMode === 'mock' && ' · demo data'}
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${status.tone}`}>{status.label}</span>
                      {run.note && <div className="muted small" style={{ marginTop: 4 }}>{run.note}</div>}
                    </td>
                    <td>{run.status === 'skipped' ? '–' : `${run.okCalls} of ${run.totalCalls}`}</td>
                    {canEdit && <td>{run.credits.toLocaleString()}</td>}
                    <td className="actions">
                      {run.status === 'completed' &&
                        (run.id === shownRunId ? <span className="muted small">Shown on Visibility</span> : <button className="link" onClick={() => onShow(run.id)}>View results</button>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
