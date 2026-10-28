import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, type LeaderboardRow } from '@gb/shared';

type Format = 'money' | 'pct' | 'usd' | 'num';

interface Metric {
  key: string;
  label: string;
  format: Format;
  /** null when this contestant has nothing to measure yet (e.g. no finals for split rate). */
  value: (r: LeaderboardRow) => number | null;
}

const per = (n: number, d: number) => (d > 0 ? n / d : null);

export const METRICS: Metric[] = [
  { key: 'avg', label: 'Average winnings per game', format: 'money', value: (r) => r.avgWinnings },
  { key: 'total', label: 'Total winnings', format: 'money', value: (r) => r.totalWinnings },
  { key: 'best', label: 'Best win', format: 'money', value: (r) => r.bestWin },
  { key: 'honesty', label: 'Honesty (claims that were true)', format: 'pct', value: (r) => per(r.truthfulClaims, r.claims) },
  { key: 'split', label: 'Split rate (in finals)', format: 'pct', value: (r) => per(r.splits, r.splits + r.steals) },
  { key: 'finals', label: 'Reached the final', format: 'pct', value: (r) => per(r.finals, r.games) },
  { key: 'r1out', label: 'Out in round 1', format: 'pct', value: (r) => per(r.r1Eliminations, r.games) },
  { key: 'votes', label: 'Votes against per game', format: 'num', value: (r) => per(r.votesReceived, r.games) },
  { key: 'fumbles', label: 'Fumbles per game', format: 'num', value: (r) => per(r.invalidResponses, r.games) },
  { key: 'cost', label: 'API cost per game', format: 'usd', value: (r) => per(r.costUsd, r.games) },
  { key: 'games', label: 'Games played', format: 'num', value: (r) => r.games },
  // From the exit interviews, checked against what happened.
  { key: 'ownedUp', label: 'Owned up to lying (interview)', format: 'pct', value: (r) => per(r.ownedUp, r.liedInterviews) },
  { key: 'sawIt', label: 'Saw it coming (interview)', format: 'pct', value: (r) => per(r.sawItComing, r.sawItAsked) },
  { key: 'called', label: 'Called the winner (interview)', format: 'pct', value: (r) => per(r.winnerRight, r.winnerPicks) },
  { key: 'plannedSteal', label: 'Planned to steal from the start (interview)', format: 'pct', value: (r) => per(r.plannedSteal, r.plansGiven) },
  { key: 'stuck', label: 'Stuck to their plan (interview)', format: 'pct', value: (r) => per(r.stuckToPlan, r.planChecks) },
  { key: 'again', label: 'Would choose the same again (interview)', format: 'pct', value: (r) => per(r.sameAgain, r.againAsked) },
  { key: 'trustGiven', label: 'Trusts the other players, 1–5 (interview)', format: 'num', value: (r) => per(r.trustGivenTotal, r.trustGivenScores) },
  { key: 'trustReceived', label: 'Trusted by the other players, 1–5 (interview)', format: 'num', value: (r) => per(r.trustReceivedTotal, r.trustReceivedScores) },
  { key: 'trust', label: 'Trust in the other finalist in Split or Steal, 1–5 (interview)', format: 'num', value: (r) => per(r.trustTotal, r.trustScores) },
];

function format(v: number, f: Format, compact = false): string {
  switch (f) {
    case 'money':
      if (compact && v >= 1000) return `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}K`;
      return formatMoney(Math.round(v));
    case 'pct':
      return `${Math.round(v * 100)}%`;
    case 'usd':
      return v === 0 ? '$0' : `$${v >= 0.01 ? v.toFixed(2) : v.toFixed(3)}`;
    case 'num':
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
}

/** Five evenly spaced ticks from 0 to a round number at or above max (percentages run 0-100%). */
function axis(values: number[], f: Format): number[] {
  if (f === 'pct') return [0, 0.25, 0.5, 0.75, 1];
  const max = Math.max(0, ...values);
  if (max <= 0) return [0, 0.25, 0.5, 0.75, 1];
  const mag = 10 ** Math.floor(Math.log10(max));
  const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].find((s) => s * mag * 4 >= max)! * mag;
  return [0, 1, 2, 3, 4].map((i) => i * step);
}

const HEIGHT = 340;
const PAD = { top: 18, right: 20, bottom: 46, left: 62 };
/** Pointer within this distance of a dot picks it up (hover targets bigger than the mark). */
const PICK_RADIUS = 26;

interface Props {
  rows: LeaderboardRow[];
  highlight: string | null;
  onSelect: (key: string) => void;
}

/** Every contestant as a dot, on two measures of your choosing. */
export function CompareChart({ rows, highlight, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [xKey, setXKey] = useState('honesty');
  const [yKey, setYKey] = useState('avg');
  const [minGames, setMinGames] = useState(1);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xm = METRICS.find((m) => m.key === xKey)!;
  const ym = METRICS.find((m) => m.key === yKey)!;
  const eligible = rows.filter((r) => r.games >= minGames);
  const points = useMemo(
    () =>
      eligible.flatMap((r) => {
        const x = xm.value(r);
        const y = ym.value(r);
        return x === null || y === null ? [] : [{ key: r.key, label: r.label, games: r.games, x, y }];
      }),
    [eligible, xm, ym],
  );
  const missing = eligible.length - points.length;

  const xTicks = axis(points.map((p) => p.x), xm.format);
  const yTicks = axis(points.map((p) => p.y), ym.format);
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const sx = (v: number) => PAD.left + (v / xTicks.at(-1)!) * innerW;
  const sy = (v: number) => PAD.top + innerH - (v / yTicks.at(-1)!) * innerH;

  // Direct labels where they fit: highlighted first, then the rest; skip any that would collide.
  const labels = useMemo(() => {
    const placed: { key: string; x: number; y: number; anchor: 'start' | 'end'; text: string }[] = [];
    const boxes: { x1: number; x2: number; y1: number; y2: number }[] = [];
    const order = [...points].sort((a, b) => (a.key === highlight ? -1 : b.key === highlight ? 1 : b.y - a.y));
    for (const p of order) {
      const text = p.label.replace(/ \(free\)$/, '');
      const w = text.length * 6.4;
      const cx = sx(p.x);
      const cy = sy(p.y);
      const right = cx + 9 + w <= width - 4;
      const x1 = right ? cx + 9 : cx - 9 - w;
      const box = { x1, x2: x1 + w, y1: cy - 8, y2: cy + 6 };
      const hitsDot = points.some((q) => q.key !== p.key && Math.abs(sx(q.x) - (x1 + w / 2)) < w / 2 + 5 && Math.abs(sy(q.y) - cy) < 9);
      if (boxes.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) || (hitsDot && p.key !== highlight)) continue;
      boxes.push(box);
      placed.push({ key: p.key, x: right ? cx + 9 : cx - 9, y: cy, anchor: right ? 'start' : 'end', text });
    }
    return placed;
    // sx/sy derive from width and the ticks, which derive from points.
  }, [points, highlight, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const nearest = (clientX: number, clientY: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: string | null = null;
    let bestD = PICK_RADIUS;
    for (const p of points) {
      const d = Math.hypot(sx(p.x) - px, sy(p.y) - py);
      if (d < bestD) {
        bestD = d;
        best = p.key;
      }
    }
    return best;
  };

  const hovered = points.find((p) => p.key === hover);
  const ordered = [...points].sort((a, b) => (a.key === highlight || a.key === hover ? 1 : b.key === highlight || b.key === hover ? -1 : 0));

  const picker = (label: string, value: string, set: (v: string) => void) => (
    <label className="field field--inline">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {METRICS.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="compare">
      <div className="compare__controls">
        {picker('Across', xKey, setXKey)}
        {picker('Up', yKey, setYKey)}
        <label className="field field--inline">
          <span>At least</span>
          <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))}>
            {[1, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n} game{n === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {points.length === 0 ? (
        <p className="muted">No contestants have both of these measures yet{minGames > 1 ? ` with at least ${minGames} games` : ''}.</p>
      ) : (
        <div className="trend compare__plot" ref={wrap}>
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${ym.label} against ${xm.label} for ${points.length} contestants`}
            onPointerMove={(e) => setHover(nearest(e.clientX, e.clientY))}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const key = nearest(e.clientX, e.clientY);
              if (key) onSelect(key);
            }}
          >
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line className="trend__grid" x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
                <text className="trend__tick" x={PAD.left - 8} y={sy(t)} dy="0.32em" textAnchor="end">
                  {format(t, ym.format, true)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`x${t}`} className="trend__tick" x={sx(t)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle">
                {format(t, xm.format, true)}
              </text>
            ))}
            <line className="trend__axis" x1={PAD.left} x2={width - PAD.right} y1={sy(0)} y2={sy(0)} />
            <text className="trend__tick" x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
              {xm.label} →
            </text>
            <text className="trend__tick" x={PAD.left - 8} y={PAD.top - 6} textAnchor="start">
              ↑ {ym.label}
            </text>

            {ordered.map((p) => {
              const on = p.key === highlight || p.key === hover;
              return (
                <circle
                  key={p.key}
                  className={`compare__dot${p.key === highlight ? ' compare__dot--hi' : ''}`}
                  cx={sx(p.x)}
                  cy={sy(p.y)}
                  r={on ? 7 : 5}
                />
              );
            })}
            {labels.map((l) => (
              <text
                key={l.key}
                className={`compare__label${l.key === highlight ? ' compare__label--hi' : ''}`}
                x={l.x}
                y={l.y}
                dy="0.32em"
                textAnchor={l.anchor}
              >
                {l.text}
              </text>
            ))}
          </svg>
          {hovered && (
            <div
              className="trend__tooltip"
              style={{
                left: sx(hovered.x) > width / 2 ? sx(hovered.x) - 236 : sx(hovered.x) + 14,
                top: Math.max(0, Math.min(HEIGHT - 110, sy(hovered.y) - 40)),
              }}
            >
              <div className="trend__tooltip-title">{hovered.label}</div>
              <div className="compare__row">
                <strong>{format(hovered.x, xm.format)}</strong>
                <span>{xm.label}</span>
              </div>
              <div className="compare__row">
                <strong>{format(hovered.y, ym.format)}</strong>
                <span>{ym.label}</span>
              </div>
              <div className="muted small">
                {hovered.games} game{hovered.games === 1 ? '' : 's'} · click to highlight
              </div>
            </div>
          )}
        </div>
      )}
      {missing > 0 && points.length > 0 && (
        <p className="muted small">
          {missing} contestant{missing === 1 ? ' has' : 's have'} no data for one of these measures yet (for example, no finals for the split
          rate), so {missing === 1 ? "isn't" : "aren't"} shown.
        </p>
      )}
    </div>
  );
}
