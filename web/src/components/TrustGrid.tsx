import { useMemo, useRef, useState } from 'react';
import { groupKey, TRUST_HUMANS_KEY, type GroupBy, type LeaderboardRow, type TrustPair, type TrustSource } from '@gb/shared';
import { prefs } from '../lib/api';

type View = TrustSource | 'both';

/** `of` finishes "average trust ...". */
const VIEWS: { id: View; label: string; of: string }[] = [
  { id: 'vote', label: 'At the votes', of: 'at the votes' },
  { id: 'interview', label: 'In the exit interviews', of: 'in the exit interviews' },
  { id: 'both', label: 'Both together', of: 'overall' },
];
const VIEW_IDS = VIEWS.map((v) => v.id);

/** Fewer ratings than this and a square is faded: too few to read much into. */
const FEW_RATINGS = 3;

/** Trust from 1 to 5 as one gold hue, dim to bright (OKLCH lightness 0.34 to 0.88, evenly stepped). */
const RAMP = ['#473418', '#735726', '#a17d35', '#cfa643', '#fed252'];
const RGB = RAMP.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
const position = (avg: number) => Math.min(1, Math.max(0, (avg - 1) / 4));

function fill(avg: number, alpha = 1): string {
  const t = position(avg) * (RGB.length - 1);
  const i = Math.min(RGB.length - 2, Math.floor(t));
  const [r, g, b] = RGB[i]!.map((c, k) => Math.round(c + (RGB[i + 1]![k]! - c) * (t - i)));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Dark text on the bright end of the scale, light on the dim end (whichever reads better, by APCA). */
const ink = (avg: number) => (position(avg) >= 0.62 ? '#1a1300' : 'var(--text)');

interface Tally {
  total: number;
  ratings: number;
}
type Cell = Record<TrustSource, Tally>;

const none = (): Tally => ({ total: 0, ratings: 0 });
const tallyOf = (c: Cell, view: View): Tally =>
  view === 'both' ? { total: c.vote.total + c.interview.total, ratings: c.vote.ratings + c.interview.ratings } : c[view];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Props {
  pairs: TrustPair[];
  /** Every contestant, ungrouped (to find each one's group). */
  rows: LeaderboardRow[];
  /** What the page shows: the contestants, or their groups. */
  shown: LeaderboardRow[];
  groupBy: GroupBy;
  highlight: string | null;
  onSelect: (key: string) => void;
}

/** A heatmap of how much each contestant trusted each other one: rows rate columns. */
export function TrustGrid({ pairs, rows, shown, groupBy, highlight, onSelect }: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => prefs.choice('lb.trustView', VIEW_IDS, 'both'));
  const [minGames, setMinGames] = useState(1);
  const [hover, setHover] = useState<{ from: string; to: string; x: number; y: number } | null>(null);
  const [focus, setFocus] = useState<typeof hover>(null);
  const active = hover ?? focus;
  const grouped = groupBy !== 'model';

  const grid = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // Every human player is one contestant here, so in a group or on their own they're "Human players".
    const bucket = (key: string) =>
      groupKey(key === TRUST_HUMANS_KEY ? { key, kind: 'human' } : (byKey.get(key) ?? { key, kind: 'ai' }), groupBy);
    const labels = new Map(shown.map((r) => [r.key, r.label]));
    const games = new Map(shown.map((r) => [r.key, r.games]));
    if (!grouped) {
      labels.set(TRUST_HUMANS_KEY, 'Human players');
      games.set(TRUST_HUMANS_KEY, rows.filter((r) => r.kind === 'human').reduce((s, r) => s + r.games, 0));
    }

    const cells = new Map<string, Cell>();
    const received = new Map<string, Tally>();
    const givers = new Set<string>();
    for (const p of pairs) {
      const from = bucket(p.from);
      const to = bucket(p.to);
      const id = `${from}\n${to}`;
      let cell = cells.get(id);
      if (!cell) cells.set(id, (cell = { vote: none(), interview: none() }));
      cell[p.source].total += p.total;
      cell[p.source].ratings += p.ratings;
      const got = received.get(to) ?? none();
      received.set(to, { total: got.total + p.total, ratings: got.ratings + p.ratings });
      givers.add(from);
    }
    // Most trusted first, the same order down as across, so the diagonal lines up. The order is
    // taken from both kinds of rating, so switching between them only changes the colours.
    const avg = (k: string) => {
      const t = received.get(k);
      return t ? t.total / t.ratings : -1;
    };
    const order = [...new Set([...givers, ...received.keys()])]
      .filter((k) => (games.get(k) ?? 0) >= minGames)
      .sort((a, b) => avg(b) - avg(a) || (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b));
    return {
      cells,
      labels,
      selectable: new Set(shown.map((r) => r.key)),
      raters: order.filter((k) => givers.has(k)),
      rated: order.filter((k) => received.has(k)),
    };
  }, [pairs, rows, shown, groupBy, grouped, minGames]);

  if (pairs.length === 0) return null;
  const { cells, labels, selectable, raters, rated } = grid;
  const label = (k: string) => labels.get(k) ?? k;
  const viewOf = VIEWS.find((v) => v.id === view)!;

  const place = (from: string, to: string, el: HTMLElement) => {
    const box = plot.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const right = r.right - box.left + 6;
    const x = right + 236 <= box.width ? right : Math.max(0, r.left - box.left - 236 - 6);
    return { from, to, x, y: Math.max(0, r.top - box.top) };
  };

  /** A row or column name: lit up when highlighted, or when the square being looked at is in its row or column. */
  const head = (k: string, axis: 'row' | 'col') => {
    const on = k === highlight || k === (axis === 'row' ? active?.from : active?.to);
    const text = <span className={`tg__${axis}-text`}>{label(k)}</span>;
    return selectable.has(k) ? (
      <button type="button" className={`tg__head-btn${on ? ' tg__head--on' : ''}`} title={`${label(k)}: click to highlight`} onClick={() => onSelect(k)}>
        {text}
      </button>
    ) : (
      <span className={on ? 'tg__head--on' : ''} title={label(k)}>
        {text}
      </span>
    );
  };

  const shownCell = active && cells.get(`${active.from}\n${active.to}`);
  const tooltip = active && shownCell && tallyOf(shownCell, view).ratings > 0 && (
    <div className="trend__tooltip tg__tooltip" style={{ left: active.x, top: active.y }}>
      <div className="trend__tooltip-title">
        {label(active.from)} → {label(active.to)}
      </div>
      {(() => {
        const t = tallyOf(shownCell, view);
        return (
          <>
            <div className="compare__row">
              <strong>{(t.total / t.ratings).toFixed(1)} / 5</strong>
              <span>average trust {viewOf.of}</span>
            </div>
            <div className="compare__row">
              <strong>{t.ratings}</strong>
              <span>
                rating{t.ratings === 1 ? '' : 's'}
                {t.ratings < FEW_RATINGS ? ': too few to read much into' : ''}
              </span>
            </div>
          </>
        );
      })()}
      {view === 'both' && (
        <div className="muted small tg__split">
          {(['vote', 'interview'] as const).map((s) => {
            const t = shownCell[s];
            return (
              <div key={s}>
                {s === 'vote' ? 'At the votes' : 'In the interviews'}:{' '}
                {t.ratings ? `${(t.total / t.ratings).toFixed(1)} from ${plural(t.ratings, 'rating')}` : 'none'}
              </div>
            );
          })}
        </div>
      )}
      {active.from === active.to && (
        <div className="muted small">{grouped ? 'Models in this group rating each other.' : 'A model rating another copy of itself.'}</div>
      )}
    </div>
  );

  return (
    <div className="tg">
      <div className="tg__controls">
        <div className="lb__group-options" role="group" aria-label="Which ratings">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="picker__tier"
              aria-pressed={view === v.id}
              onClick={() => {
                setView(v.id);
                prefs.setChoice('lb.trustView', v.id);
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
        <label className="field field--inline">
          <span>At least</span>
          <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))}>
            {[1, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {plural(n, 'game')}
              </option>
            ))}
          </select>
        </label>
      </div>

      {raters.length === 0 || rated.length === 0 ? (
        <p className="muted">No {grouped ? 'groups' : 'contestants'} with at least {plural(minGames, 'game')} have rated each other yet.</p>
      ) : (
        <div className="tg__plot" ref={plot}>
          <div
            className="tg__scroll"
            onScroll={() => {
              setHover(null);
              setFocus(null);
            }}
          >
            <table className="tg__table">
              <thead>
                <tr>
                  <th className="tg__corner" scope="col">
                    <span className="muted small">Row trusts column →</span>
                  </th>
                  {rated.map((to) => (
                    <th key={to} scope="col" className="tg__col">
                      {head(to, 'col')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {raters.map((from) => (
                  <tr key={from}>
                    <th scope="row" className="tg__row">
                      {head(from, 'row')}
                    </th>
                    {rated.map((to) => {
                      const cell = cells.get(`${from}\n${to}`);
                      const t = cell ? tallyOf(cell, view) : none();
                      if (t.ratings === 0) {
                        return (
                          <td key={to} className="tg__cell tg__cell--none" aria-label={`${label(from)} has not rated ${label(to)}`}>
                            ·
                          </td>
                        );
                      }
                      const avg = t.total / t.ratings;
                      const few = t.ratings < FEW_RATINGS;
                      return (
                        <td key={to} className="tg__cell">
                          <button
                            type="button"
                            className={`tg__btn${few ? ' tg__btn--few' : ''}`}
                            style={few ? { background: fill(avg, 0.28) } : { background: fill(avg), color: ink(avg) }}
                            aria-label={`${label(from)} trusts ${label(to)} ${avg.toFixed(1)} out of 5, from ${plural(t.ratings, 'rating')}`}
                            onPointerEnter={(e) => setHover(place(from, to, e.currentTarget))}
                            onPointerLeave={() => setHover(null)}
                            onFocus={(e) => setFocus(place(from, to, e.currentTarget))}
                            onBlur={() => setFocus(null)}
                          >
                            <span className="tg__avg">{avg.toFixed(1)}</span>
                            <span className="tg__n">{t.ratings}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tooltip}
        </div>
      )}

      <div className="tg__legend" aria-hidden="true">
        <span className="tg__legend-item">
          <span>1 not at all</span>
          <span className="tg__scale" style={{ background: `linear-gradient(to right, ${RAMP.join(', ')})` }} />
          <span>5 completely</span>
        </span>
        <span className="tg__legend-item">
          <span className="tg__swatch" style={{ background: fill(3, 0.28) }} />
          Fewer than {FEW_RATINGS} ratings
        </span>
        <span className="tg__legend-item">
          <span className="tg__swatch tg__swatch--none">·</span>
          Not rated
        </span>
      </div>
    </div>
  );
}
