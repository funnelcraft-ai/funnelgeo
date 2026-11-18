'use client';

import { useMemo, useState } from 'react';
import type { Overview } from '@/lib/types';

/** Fixed categorical order (validated for colour-blind separation); colour follows the engine, never its rank. */
export const ENGINE_COLORS: Record<string, string> = { chatgpt: '#2a78d6', perplexity: '#eb6834', gemini: '#1baf7a' };
const FALLBACK = ['#6250d6', '#e87ba4', '#eda100'];
export const engineColor = (key: string, i: number) => ENGINE_COLORS[key] ?? FALLBACK[i % FALLBACK.length]!;

const W = 720;
const H = 250;
const PAD = { top: 16, right: 92, bottom: 30, left: 40 };

const weekLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Weekly visibility by engine: the share of answers that named a client, one
 * line per engine, with a crosshair tooltip giving the counts behind each rate.
 */
export function TrendChart({ trend }: { trend: Overview['trend'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { weeks, engines } = trend;
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / Math.max(1, weeks.length - 1);
  const y = (rate: number) => PAD.top + (1 - rate) * (H - PAD.top - PAD.bottom);

  const series = useMemo(
    () =>
      engines.map((e, ei) => {
        const points = weeks.map((w, i) => {
          const v = w.engines[e.key];
          return v && v.answers > 0 ? { i, rate: v.mentioned / v.answers, ...v } : null;
        });
        // Break the line where a week has no answers rather than drawing through it.
        let d = '';
        let pen = false;
        for (const p of points) {
          if (!p) { pen = false; continue; }
          d += `${pen ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.rate).toFixed(1)}`;
          pen = true;
        }
        const last = [...points].reverse().find(Boolean) ?? null;
        return { ...e, color: engineColor(e.key, ei), points, d, last };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trend],
  );

  // Keep end labels from colliding: nudge apart by at least 16px.
  const labels = series
    .filter((s) => s.last)
    .map((s) => ({ key: s.key, label: s.label, color: s.color, y: y(s.last!.rate), rate: s.last!.rate }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 16) labels[i]!.y = labels[i - 1]!.y + 16;

  const hasData = series.some((s) => s.d);
  const hovered = hover === null ? null : weeks[hover];

  return (
    <div className="trend-chart">
      <ul className="legend" aria-label="Engines">
        {series.map((s) => (
          <li key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label}</li>
        ))}
      </ul>
      {!hasData ? (
        <p className="empty"><strong>No completed runs in the last 8 weeks</strong>The trend appears after the first weekly run.</p>
      ) : (
        <div className="chart-box">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly AI visibility by engine, last 8 weeks" onMouseLeave={() => setHover(null)}>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{Math.round(t * 100)}%</text>
              </g>
            ))}
            {weeks.map((w, i) => (
              <text key={w.week} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{weekLabel(w.week)}</text>
            ))}
            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} />}
            {series.map((s) => (
              <g key={s.key}>
                <path d={s.d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {s.points.map((p) =>
                  p && (hover === p.i || s.points.filter(Boolean).length === 1) ? (
                    <circle key={p.i} cx={x(p.i)} cy={y(p.rate)} r={5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  ) : null,
                )}
              </g>
            ))}
            {labels.map((l) => (
              <text key={l.key} className="end-label" x={W - PAD.right + 10} y={l.y + 4}>
                {l.label} {Math.round(l.rate * 100)}%
              </text>
            ))}
            {/* Hit targets: one column per week, wider than the marks. */}
            {weeks.map((w, i) => (
              <rect
                key={w.week}
                x={x(i) - (W - PAD.left - PAD.right) / Math.max(1, weeks.length - 1) / 2}
                y={PAD.top}
                width={(W - PAD.left - PAD.right) / Math.max(1, weeks.length - 1)}
                height={H - PAD.top - PAD.bottom}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
          {hovered && hover !== null && (
            <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
              <strong>Week of {weekLabel(hovered.week)}</strong>
              {series.map((s) => {
                const v = hovered.engines[s.key];
                return (
                  <div key={s.key}>
                    <span className="swatch" style={{ background: s.color }} />
                    {s.label}
                    <b>{v && v.answers ? `${Math.round((v.mentioned / v.answers) * 100)}%` : '—'}</b>
                    <span className="muted">{v && v.answers ? `${v.mentioned} of ${v.answers}` : 'no answers'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <details className="table-view">
        <summary>Show as a table</summary>
        <table>
          <thead><tr><th>Week of</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week}>
                <td>{weekLabel(w.week)}</td>
                {series.map((s) => {
                  const v = w.engines[s.key];
                  return <td key={s.key} data-label={s.label}>{v && v.answers ? `${Math.round((v.mentioned / v.answers) * 100)}% (${v.mentioned} of ${v.answers})` : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
