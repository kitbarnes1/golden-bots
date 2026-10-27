import { useEffect, useMemo, useState } from 'react';
import { formatMoney, groupRows, type GroupBy, type LeaderboardResponse, type LeaderboardRow } from '@gb/shared';
import { CompareChart } from '../components/CompareChart';
import { RankChart } from '../components/RankChart';
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
  { key: 'costUsd', label: 'API cost', title: 'Total OpenRouter spend for this contestant', numeric: true },
];

/** Ways to add contestants up, so whole labs, countries and kinds of model can be compared. */
const GROUPINGS: { by: GroupBy; label: string; of: string; column: string; note?: string }[] = [
  { by: 'model', label: 'Model', of: 'model', column: 'Contestant' },
  { by: 'lab', label: 'Creator', of: 'creator', column: 'Creator', note: 'Models are grouped by the lab that made them.' },
  {
    by: 'country',
    label: "Creator's country",
    of: "creator's country",
    column: 'Country',
    note: 'Models are grouped by where the lab that made them is based.',
  },
  {
    by: 'openness',
    label: 'Open or closed',
    of: 'open or closed weights',
    column: 'Weights',
    note: 'Open weights means the model itself is published (OpenRouter links to it on Hugging Face). Closed models are only available through their maker.',
  },
  {
    by: 'generation',
    label: 'How new',
    of: 'how new the model is',
    column: 'Released',
    note: 'Models are grouped by when OpenRouter added them: in the last six months, or before.',
  },
];
const GROUP_IDS = GROUPINGS.map((g) => g.by);
/** Fewer games than this and a group is faded: too few to read much into. */
const FEW_GAMES = 5;

export function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => prefs.choice('lb.groupBy', GROUP_IDS, 'model'));
  const grouping = GROUPINGS.find((g) => g.by === groupBy)!;
  const grouped = groupBy !== 'model';
  const [error, setError] = useState<string | null>(null);
  // Off by default (a new key, so an old "on" from before doesn't stick).
  const [includeHumans, setIncludeHumans] = useState(() => prefs.get('lb.includeHumans', false));
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

  const shown = useMemo(() => (data ? groupRows(data.rows, groupBy) : []), [data, groupBy]);
  const rows = useMemo(
    () =>
      [...shown].sort((a, b) => {
        const x = metric(a, sort.key);
        const y = metric(b, sort.key);
        const c = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
        return sort.desc ? -c : c;
      }),
    [shown, sort],
  );

  const labels = useMemo(() => new Map(shown.map((r) => [r.key, r.label])), [shown]);
  const leader = shown[0]?.key ?? null;
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
              prefs.set('lb.includeHumans', e.target.checked);
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

      <div className="lb__group">
        <span className="lb__group-label" id="lb-group">
          Group by
        </span>
        <div className="lb__group-options" role="group" aria-labelledby="lb-group">
          {GROUPINGS.map((g) => (
            <button
              key={g.by}
              type="button"
              className="picker__tier"
              aria-pressed={groupBy === g.by}
              onClick={() => {
                setGroupBy(g.by);
                prefs.setChoice('lb.groupBy', g.by);
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
        {grouped && (
          <p className="muted small lb__group-note">
            {grouping.note} Each group adds up every seat its models played, so a game with two of its models counts twice.
            Groups with fewer than {FEW_GAMES} games are faded: too few to read much into.
          </p>
        )}
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
              <h2>Winnings by {grouping.of}</h2>
            </div>
            <p className="muted small">
              Highest first. Click a bar (or a row in the table) to highlight that {grouped ? 'group' : 'contestant'} everywhere on this page.
            </p>
            <RankChart rows={shown} highlight={selected} onSelect={setHighlight} />
          </section>

          <section className="card">
            <div className="card__head">
              <h2>Compare {grouped ? 'groups' : 'models'}</h2>
            </div>
            <p className="muted small">
              Each dot is a {grouped ? 'group' : 'contestant'}. Pick what goes across and up, for example honesty against winnings: does lying pay?
            </p>
            <CompareChart rows={shown} highlight={selected} onSelect={setHighlight} />
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
                          {c.key === 'label' ? grouping.column : c.label}
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
                      className={`${r.key === selected ? 'lb__row--hi' : ''} ${grouped && r.games < FEW_GAMES ? 'lb__row--few' : ''}`}
                      {...(grouped && r.games < FEW_GAMES ? { title: `Only ${r.games} game${r.games === 1 ? '' : 's'}: too few to read much into` } : {})}
                      onClick={() => setHighlight(r.key)}
                    >
                      <td className="num">{i + 1}</td>
                      <td>
                        <div className="lb__name">{r.label}</div>
                        <div className="lb__key" title={r.members?.join(', ')}>
                          {r.members
                            ? `${r.members.length} ${r.kind === 'ai' ? 'model' : r.kind === 'mock' ? 'bot' : 'player'}${r.members.length === 1 ? '' : 's'}: ${r.members.slice(0, 3).join(', ')}${r.members.length > 3 ? ', …' : ''}`
                            : r.kind === 'human'
                              ? 'human'
                              : r.key}
                        </div>
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
