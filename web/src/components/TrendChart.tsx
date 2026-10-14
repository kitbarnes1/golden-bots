import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, type LeaderboardHistoryPoint } from '@gb/shared';

interface Props {
  history: LeaderboardHistoryPoint[];
  labels: Map<string, string>;
  highlight: string | null;
}

interface Series {
  key: string;
  points: { x: number; y: number }[];
}

const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 34, left: 56 };

function compact(v: number): string {
  if (v >= 1_000_000) return `£${(v / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}M`;
  if (v >= 1000) return `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}K`;
  return `£${Math.round(v)}`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v / 4)! * mag;
  return Math.ceil(v / step) * step;
}

/**
 * Running average winnings per game for every contestant, as games accumulate.
 * Emphasis form: the selected contestant in the accent, everyone else as grey context.
 */
export function TrendChart({ history, labels, highlight }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { series, gameCount, yMax } = useMemo(() => {
    const gameIndex = new Map<string, number>();
    for (const p of history) if (!gameIndex.has(p.gameId)) gameIndex.set(p.gameId, gameIndex.size + 1);
    const acc = new Map<string, { sum: number; n: number; points: { x: number; y: number }[] }>();
    for (const p of history) {
      const s = acc.get(p.key) ?? { sum: 0, n: 0, points: [] };
      s.sum += p.winnings;
      s.n += 1;
      s.points.push({ x: gameIndex.get(p.gameId)!, y: s.sum / s.n });
      acc.set(p.key, s);
    }
    const series: Series[] = [...acc.entries()].map(([key, s]) => ({ key, points: s.points }));
    const yMax = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y))));
    return { series, gameCount: gameIndex.size, yMax };
  }, [history]);

  if (gameCount < 2) {
    return <p className="muted">The trend chart appears once a couple of games have finished.</p>;
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (v: number) => PAD.left + ((v - 1) / Math.max(1, gameCount - 1)) * innerW;
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const path = (s: Series) => s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xStep = Math.max(1, Math.ceil(gameCount / Math.max(2, Math.floor(innerW / 70))));
  const xTicks = Array.from({ length: Math.floor((gameCount - 1) / xStep) + 1 }, (_, i) => 1 + i * xStep);

  const ordered = [...series].sort((a, b) => (a.key === highlight ? 1 : b.key === highlight ? -1 : 0));
  const hi = series.find((s) => s.key === highlight);
  const last = hi?.points.at(-1);

  // Value of each series at the hovered game: its latest running average up to that point.
  const readout =
    hoverX === null
      ? []
      : series
          .map((s) => {
            const p = [...s.points].reverse().find((pt) => pt.x <= hoverX);
            return p ? { key: s.key, y: p.y } : null;
          })
          .filter((r): r is { key: string; y: number } => r !== null)
          .sort((a, b) => b.y - a.y);

  const onMove = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const rel = (clientX - rect.left - PAD.left) / innerW;
    setHoverX(Math.min(gameCount, Math.max(1, Math.round(1 + rel * (gameCount - 1)))));
  };

  return (
    <div className="trend" ref={wrap}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Running average winnings per game across ${gameCount} games${hi ? `, ${labels.get(hi.key)} highlighted` : ''}`}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHoverX(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line className="trend__grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="trend__tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {compact(t)}
            </text>
          </g>
        ))}
        <line className="trend__axis" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {xTicks.map((t) => (
          <text key={t} className="trend__tick" x={x(t)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle">
            {t}
          </text>
        ))}
        <text className="trend__tick" x={width - PAD.right} y={HEIGHT - 4} textAnchor="end">
          games played
        </text>

        {ordered.map((s) => (
          <path key={s.key} d={path(s)} className={s.key === highlight ? 'trend__line trend__line--hi' : 'trend__line'} />
        ))}
        {last && (
          <circle className="trend__dot" cx={x(last.x)} cy={y(last.y)} r={4.5} />
        )}

        {hoverX !== null && (
          <line className="trend__crosshair" x1={x(hoverX)} x2={x(hoverX)} y1={PAD.top} y2={y(0)} />
        )}
      </svg>
      {last && hi && (
        <div className="trend__endlabel" style={{ left: Math.min(x(last.x), width - 120), top: Math.max(0, y(last.y) - 30) }}>
          {formatMoney(Math.round(last.y))}
        </div>
      )}
      {hoverX !== null && readout.length > 0 && (
        <div
          className="trend__tooltip"
          style={{ left: x(hoverX) > width / 2 ? x(hoverX) - 236 : x(hoverX) + 12, top: PAD.top }}
        >
          <div className="trend__tooltip-title">After game {hoverX}</div>
          {readout.slice(0, 10).map((r) => (
            <div key={r.key} className={`trend__row ${r.key === highlight ? 'trend__row--hi' : ''}`}>
              <span className="trend__key" aria-hidden />
              <strong>{formatMoney(Math.round(r.y))}</strong>
              <span>{labels.get(r.key) ?? r.key}</span>
            </div>
          ))}
          {readout.length > 10 && <div className="muted">+{readout.length - 10} more</div>}
        </div>
      )}
    </div>
  );
}
