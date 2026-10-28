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
  | 'keptWord'
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
    case 'keptWord':
      return pct(r.promisesKept, r.splitPromises) ?? -1;
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
  {
    key: 'keptWord',
    label: 'Kept their word',
    title: 'Of the finals where they told the other finalist they would split, the share where they did',
    numeric: true,
  },
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
                      <td
                        className="num"
                        title={r.splitPromises ? `Split in ${r.promisesKept} of the ${r.splitPromises} finals where they said they would` : 'No promises to split yet'}
                      >
                        {fmtPct(pct(r.promisesKept, r.splitPromises))}
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

          {/* Humans aren't interviewed, but the AIs rate how much they trusted them. */}
          <InterviewTable
            rows={rows.filter((r) => r.interviews > 0 || r.trustReceivedScores > 0)}
            selected={selected}
            onSelect={setHighlight}
            column={grouping.column}
          />
        </>
      )}
    </div>
  );
}

/** What contestants said in their exit interviews, checked against what happened. */
function InterviewTable({
  rows,
  selected,
  onSelect,
  column,
}: {
  rows: LeaderboardRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  column: string;
}) {
  if (rows.length === 0) return null;
  const cell = (n: number, d: number, title: string) => (
    <td className="num" title={d ? `${n} of ${d} ${title}` : 'Not asked yet'}>
      {fmtPct(pct(n, d))}
    </td>
  );
  const trust = (total: number, n: number, title: string) => (
    <td className="num" title={n ? `Average of ${n} ${title}${n === 1 ? '' : 's'}` : 'Not asked yet'}>
      {n ? `${(total / n).toFixed(1)} / 5` : '–'}
    </td>
  );
  return (
    <section className="card table-card">
      <div className="card__head lb__iv-head">
        <h2>From the exit interviews</h2>
      </div>
      <p className="muted small lb__iv-note">
        Each AI is interviewed as it's knocked out, and both finalists after the final. Answers are checked against what
        really happened: <strong>owned up</strong> is how often a contestant who lied about their back row admitted it.
        Everyone also scores how much they trusted each of the others, from 1 (not at all) to 5 (completely), and the
        finalists say how much they trusted each other in Split or Steal.
      </p>
      <div className="table-scroll">
        <table className="lb lb--interviews">
          <thead>
            <tr>
              <th>{column}</th>
              <th className="num" title="Exit interviews given">Interviews</th>
              <th className="num" title="Of the interviews after lying about their back row, how often they admitted it">Owned up</th>
              <th className="num" title="Knocked out: expected to be voted out">Saw it coming</th>
              <th className="num" title="Knocked out: picked the player who won the most (games where anyone won money)">Called the winner</th>
              <th className="num" title="Finalists: meant to steal from the start">Planned to steal</th>
              <th className="num" title="Finalists who had a plan: did what they planned">Stuck to the plan</th>
              <th className="num" title="Finalists: would choose the same again, knowing the other's choice">Same again</th>
              <th className="num" title="Average trust they gave the other players over the game, 1 (none) to 5 (complete)">Trusts others</th>
              <th className="num" title="Average trust the other players gave them over the game, 1 (none) to 5 (complete)">Trusted by others</th>
              <th className="num" title="Finalists: trust in the other finalist in Split or Steal, 1 (none) to 5 (complete)">Trust in the final</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.key === selected ? 'lb__row--hi' : ''} onClick={() => onSelect(r.key)}>
                <td>
                  <div className="lb__name">{r.label}</div>
                </td>
                <td className="num">{r.interviews}</td>
                {cell(r.ownedUp, r.liedInterviews, 'times after lying')}
                {cell(r.sawItComing, r.sawItAsked, 'times knocked out')}
                {cell(r.winnerRight, r.winnerPicks, 'picks')}
                {cell(r.plannedSteal, r.plansGiven, 'finals')}
                {cell(r.stuckToPlan, r.planChecks, 'finals with a plan')}
                {cell(r.sameAgain, r.againAsked, 'finals')}
                {trust(r.trustGivenTotal, r.trustGivenScores, 'score')}
                {trust(r.trustReceivedTotal, r.trustReceivedScores, 'score')}
                {trust(r.trustTotal, r.trustScores, 'final')}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
