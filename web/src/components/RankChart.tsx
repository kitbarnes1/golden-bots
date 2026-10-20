import { useState } from 'react';
import { formatMoney, type LeaderboardRow } from '@gb/shared';

const MEASURES = {
  avg: { label: 'Average per game', value: (r: LeaderboardRow) => r.avgWinnings },
  total: { label: 'Total winnings', value: (r: LeaderboardRow) => r.totalWinnings },
} as const;
type Measure = keyof typeof MEASURES;

const SHOWN = 12;

/** Contestants ranked by winnings, highest first, as horizontal bars. Click one to highlight it. */
export function RankChart({
  rows,
  highlight,
  onSelect,
}: {
  rows: LeaderboardRow[];
  highlight: string | null;
  onSelect: (key: string) => void;
}) {
  const [measure, setMeasure] = useState<Measure>('avg');
  const [all, setAll] = useState(false);
  const m = MEASURES[measure];
  const ranked = [...rows].sort((a, b) => m.value(b) - m.value(a) || a.label.localeCompare(b.label));
  const max = Math.max(1, ...ranked.map(m.value));
  const shown = all ? ranked : ranked.slice(0, SHOWN);

  return (
    <div className="rank">
      <div className="rank__controls" role="group" aria-label="Measure">
        {(Object.keys(MEASURES) as Measure[]).map((k) => (
          <button key={k} type="button" className="picker__tier" aria-pressed={measure === k} onClick={() => setMeasure(k)}>
            {MEASURES[k].label}
          </button>
        ))}
      </div>
      <ol className="rank__list">
        {shown.map((r, i) => {
          const v = m.value(r);
          return (
            <li key={r.key}>
              <button
                type="button"
                className={`rank__row${r.key === highlight ? ' rank__row--hi' : ''}`}
                aria-label={`${i + 1}. ${r.label}: ${formatMoney(Math.round(v))} (${m.label.toLowerCase()}), ${r.games} game${r.games === 1 ? '' : 's'}`}
                onClick={() => onSelect(r.key)}
              >
                <span className="rank__name">{r.label}</span>
                <span className="rank__track">
                  <span className="rank__bar" style={{ width: `${(v / max) * 100}%` }} />
                </span>
                <span className="rank__value">
                  {formatMoney(Math.round(v))}
                  <span className="rank__games">
                    {r.games} game{r.games === 1 ? '' : 's'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {ranked.length > SHOWN && (
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setAll((a) => !a)}>
          {all ? `Show the top ${SHOWN}` : `Show all ${ranked.length}`}
        </button>
      )}
    </div>
  );
}
