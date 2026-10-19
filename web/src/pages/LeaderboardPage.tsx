import { useEffect, useMemo, useState } from 'react';
import { formatMoney, type LeaderboardResponse, type LeaderboardRow } from '@gb/shared';
import { TrendChart } from '../components/TrendChart';
import { api, prefs } from '../lib/api';

type SortKey =
  | 'label'
  | 'games'
  | 'avgWinnings'
  | 'totalWinnings'
  | 'finalRate'
  | 'splitRate'
  | 'honesty'
  | 'bestWin'
  | 'invalidResponses'
  | 'costUsd';

const pct = (n: number, d: number) => (d === 0 ? null : n / d);
const fmtPct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

function metric(r: LeaderboardRow, key: SortKey): number | string {
  switch (key) {
    case 'label':
      return r.label.toLowerCase();
    case 'finalRate':
      return pct(r.finals, r.games) ?? -1;
    case 'splitRate':
      return pct(r.splits, r.splits + r.steals) ?? -1;
    case 'honesty':
      return pct(r.truthfulClaims, r.claims) ?? -1;
    default:
      return r[key];
  }
}

const COLUMNS: { key: SortKey; label: string; title: string; numeric: boolean }[] = [
  { key: 'label', label: 'Contestant', title: 'Model or player', numeric: false },
  { key: 'games', label: 'Games', title: 'Finished games played', numeric: true },
  { key: 'avgWinnings', label: 'Avg £ / game', title: 'Average prize money per game played (the ranking)', numeric: true },
  { key: 'totalWinnings', label: 'Total £', title: 'Total prize money won', numeric: true },
  { key: 'bestWin', label: 'Best', title: 'Biggest single win', numeric: true },
  { key: 'finalRate', label: 'Made final', title: 'Share of games where they survived both votes', numeric: true },
  { key: 'splitRate', label: 'Split rate', title: 'Share of finals where they chose SPLIT', numeric: true },
  { key: 'honesty', label: 'Honesty', title: 'Share of back-row claims that were the truth', numeric: true },
  { key: 'invalidResponses', label: 'Fumbles', title: 'Unusable or failed responses (the host chose for them)', numeric: true },
  { key: 'costUsd', label: 'API cost', title: 'Total API spend for this contestant (local Ollama models are free)', numeric: true },
];

export function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeHumans, setIncludeHumans] = useState(() => prefs.get('lb.humans', true));
  const [includeUnranked, setIncludeUnranked] = useState(() => prefs.get('lb.practice', false));
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'avgWinnings', desc: true });
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    api.leaderboard({ includeHumans, includeUnranked }).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => setError(String(e)),
    );
  }, [includeHumans, includeUnranked]);

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.rows].sort((a, b) => {
      const x = metric(a, sort.key);
      const y = metric(b, sort.key);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [data, sort]);

  const labels = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.key, r.label])), [data]);
  const leader = data?.rows[0]?.key ?? null;
  const selected = highlight && labels.has(highlight) ? highlight : leader;

  return (
    <div className="page leaderboard">
      <h1>Leaderboard</h1>
      <p className="muted">
        Ranked by average prize money per game. {data ? `${data.totalGames} finished game${data.totalGames === 1 ? '' : 's'}.` : ''}
      </p>

      <div className="filters">
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeHumans}
            onChange={(e) => {
              setIncludeHumans(e.target.checked);
              prefs.set('lb.humans', e.target.checked);
            }}
          />
          Include human players
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeUnranked}
            onChange={(e) => {
              setIncludeUnranked(e.target.checked);
              prefs.set('lb.practice', e.target.checked);
            }}
          />
          Include practice games (with mock bots)
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      {data && data.rows.length === 0 && (
        <section className="card">
          <p>No finished games yet{includeUnranked ? '' : ' (practice games with mock bots are hidden)'}. Start one from the Play page.</p>
        </section>
      )}

      {data && data.rows.length > 0 && (
        <>
          <section className="card">
            <div className="card__head">
              <h2>Average winnings over time</h2>
              <label className="field field--inline">
                <span>Highlight</span>
                <select value={selected ?? ''} onChange={(e) => setHighlight(e.target.value)}>
                  {data.rows.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">
              Each line is a contestant's running average per game. {selected ? labels.get(selected) : ''} is highlighted; click a
              row below to compare someone else.
            </p>
            <TrendChart history={data.history} labels={labels} highlight={selected} />
          </section>

          <section className="card table-card">
            <div className="table-scroll">
              <table className="lb">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className={c.numeric ? 'num' : ''} title={c.title} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                        <button
                          type="button"
                          onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.numeric }))}
                        >
                          {c.label}
                          {sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                        </button>
                      </th>
                    ))}
                    <th title="Final outcomes: shared / stole the lot / had it stolen / both stole">Final outcomes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.key}
                      className={r.key === selected ? 'lb__row--hi' : ''}
                      onClick={() => setHighlight(r.key)}
                    >
                      <td className="num">{i + 1}</td>
                      <td>
                        <div className="lb__name">{r.label}</div>
                        <div className="lb__key">{r.kind === 'human' ? 'human' : r.key}</div>
                      </td>
                      <td className="num">{r.games}</td>
                      <td className="num strong">{formatMoney(Math.round(r.avgWinnings))}</td>
                      <td className="num">{formatMoney(Math.round(r.totalWinnings))}</td>
                      <td className="num">{formatMoney(Math.round(r.bestWin))}</td>
                      <td className="num" title={`${r.finals} of ${r.games}`}>
                        {fmtPct(pct(r.finals, r.games))}
                      </td>
                      <td className="num" title={`${r.splits} split, ${r.steals} steal`}>
                        {fmtPct(pct(r.splits, r.splits + r.steals))}
                      </td>
                      <td className="num" title={`${r.truthfulClaims} of ${r.claims} claims truthful`}>
                        {fmtPct(pct(r.truthfulClaims, r.claims))}
                      </td>
                      <td className="num">{r.invalidResponses}</td>
                      <td className="num">{r.kind === 'ai' ? `$${r.costUsd.toFixed(2)}` : '–'}</td>
                      <td>
                        <div className="lb__outcomes">
                          <span title="Both split">🤝 {r.sharedPots}</span>
                          <span title="Stole the jackpot">💰 {r.stoleWins}</span>
                          <span title="Had it stolen">😱 {r.gotStolenFrom}</span>
                          <span title="Both stole">💥 {r.mutualSteals}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
