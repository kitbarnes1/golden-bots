import { useMemo, type CSSProperties } from 'react';
import {
  claimIsTruthful,
  describeBall,
  describeClaimValue,
  formatMoney,
  type Ball as BallT,
  type BinOrWin,
  type ClaimValue,
  type FinalChoice,
  type FinalOutcome,
  type GameEvent,
  type Payout,
  type PlayerInfo,
} from '@gb/shared';
import { SEAT_COLORS } from '../lib/gameState';
import { Ball } from './Ball';

interface SeatRecap {
  seat: number;
  front: BallT[];
  backCount: number;
  /** The real back row, if this viewer has been sent it. */
  back: BallT[] | null;
  claim: ClaimValue[] | null;
  votedFor?: number;
  votes: number;
  eliminated: boolean;
}

interface RoundRecap {
  stage: 'r1' | 'r2';
  seats: SeatRecap[];
  tie?: string;
}

interface Recap {
  rounds: RoundRecap[];
  bow?: {
    carried: Payout[];
    picks: { seat: number; action: BinOrWin; index: number; ball: BallT; jackpot: number }[];
    leftover?: BallT;
    jackpot: number;
  };
  final?: { choices: { seat: number; choice: FinalChoice }[]; outcome: FinalOutcome; payouts: Payout[] };
}

/** Everything each round dealt and how it played out, folded from the event log. */
export function buildRecap(events: GameEvent[], name: (seat: number) => string): Recap {
  const recap: Recap = { rounds: [] };
  const round = (stage: 'r1' | 'r2') => recap.rounds.find((r) => r.stage === stage);
  const seatIn = (stage: 'r1' | 'r2', seat: number) => round(stage)?.seats.find((s) => s.seat === seat);
  for (const e of events) {
    switch (e.type) {
      case 'round_started':
        recap.rounds.push({
          stage: e.stage,
          seats: e.dealt.map((d) => ({ seat: d.seat, front: d.front, backCount: d.backCount, back: null, claim: null, votes: 0, eliminated: false })),
        });
        break;
      case 'back_row': {
        const s = seatIn(e.stage, e.seat);
        if (s) s.back = e.back;
        break;
      }
      case 'claim': {
        const s = seatIn(e.stage, e.seat);
        if (s) s.claim = e.claim;
        break;
      }
      case 'votes_revealed':
        for (const v of e.votes) {
          const voter = seatIn(e.stage, v.seat);
          const target = seatIn(e.stage, v.target);
          if (voter) voter.votedFor = v.target;
          if (target) target.votes++;
        }
        break;
      case 'tie_decision': {
        const r = round(e.stage);
        if (r) r.tie = e.consensus === null ? 'Tied vote, no agreement: decided by a Killer draw.' : `Tied vote: the others agreed ${name(e.consensus)} should go.`;
        break;
      }
      case 'eliminated': {
        const s = seatIn(e.stage, e.seat);
        if (s) {
          s.eliminated = true;
          s.back = e.back;
          s.claim = e.claim;
        }
        break;
      }
      case 'bin_or_win_started':
        recap.bow = { carried: e.carried, picks: [], jackpot: 0 };
        break;
      case 'ball_picked':
        recap.bow?.picks.push({ seat: e.seat, action: e.action, index: e.index, ball: e.ball, jackpot: e.jackpot });
        if (recap.bow) recap.bow.jackpot = e.jackpot;
        break;
      case 'bin_or_win_finished':
        if (recap.bow) {
          recap.bow.leftover = e.leftover;
          recap.bow.jackpot = e.jackpot;
        }
        break;
      case 'final_reveal':
        recap.final = { choices: e.choices, outcome: e.outcome, payouts: e.payouts };
        break;
      default:
        break;
    }
  }
  return recap;
}

/** A look back at every round: who held what, what they claimed, and how they voted. */
export function RoundsReview({
  events,
  players,
  showHidden,
  viewerSeat,
}: {
  events: GameEvent[];
  players: PlayerInfo[];
  /** Show back rows this viewer has been sent (finished game, or "Reveal hidden balls"). */
  showHidden: boolean;
  viewerSeat?: number;
}) {
  const name = (seat: number) => players[seat]?.name ?? `Player ${seat + 1}`;
  const recap = useMemo(() => buildRecap(events, (s) => players[s]?.name ?? `Player ${s + 1}`), [events, players]);
  const dot = (seat: number) => ({ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] }) as CSSProperties;

  if (!recap.rounds.length) return <p className="muted">Nothing to look back on yet: the balls haven't been dealt.</p>;

  return (
    <div className="review">
      {recap.rounds.map((r) => (
        <section key={r.stage} className="review__section">
          <h2>{r.stage === 'r1' ? 'Round 1' : 'Round 2'}</h2>
          <div className="review__seats">
            {r.seats.map((s) => {
              const known = s.back !== null && (showHidden || s.eliminated || s.seat === viewerSeat);
              const honest = known && s.claim ? claimIsTruthful(s.claim, s.back!) : null;
              return (
                <article key={s.seat} className={`review__seat${s.eliminated ? ' review__seat--out' : ''}`} style={dot(s.seat)}>
                  <header className="review__name">
                    {name(s.seat)}
                    {s.eliminated && <span className="tag">eliminated</span>}
                  </header>
                  <div className="review__row">
                    <span className="review__label">Front</span>
                    {s.front.map((b) => (
                      <Ball key={b.id} ball={b} size="sm" />
                    ))}
                  </div>
                  <div className="review__row">
                    <span className="review__label">Back</span>
                    {known
                      ? s.back!.map((b) => <Ball key={b.id} ball={b} size="sm" />)
                      : Array.from({ length: s.backCount }, (_, i) => <Ball key={i} ball={null} size="sm" label="?" />)}
                  </div>
                  <p className="review__line">
                    Claimed {s.claim ? s.claim.map(describeClaimValue).join(', ') : 'nothing'}
                    {honest !== null && <span className={`badge ${honest ? 'badge--truth' : 'badge--lie'}`}>{honest ? 'True' : 'Lie'}</span>}
                  </p>
                  {s.votedFor !== undefined && (
                    <p className="review__line">
                      Voted for {name(s.votedFor)}
                      {s.votes > 0 && ` · got ${s.votes} vote${s.votes === 1 ? '' : 's'}`}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          {r.tie && <p className="muted small">{r.tie}</p>}
        </section>
      ))}

      {recap.bow && (
        <section className="review__section">
          <h2>Bin or Win</h2>
          <p className="muted small">
            Cash brought into the final: {recap.bow.carried.map((c) => `${name(c.seat)} ${formatMoney(c.amount)}`).join(', ')}
          </p>
          <ol className="review__picks">
            {recap.bow.picks.map((p) => (
              <li key={p.index} style={dot(p.seat)}>
                <Ball ball={p.ball} size="xs" />
                <span>
                  {name(p.seat)} {p.action === 'bin' ? 'binned' : 'won'} ball {p.index + 1}: {describeBall(p.ball)}
                  {p.action === 'win' && ` (jackpot ${formatMoney(p.jackpot)})`}
                </span>
              </li>
            ))}
          </ol>
          {recap.bow.leftover && (
            <p className="muted small">
              Left in the machine: {describeBall(recap.bow.leftover)}. Final jackpot {formatMoney(recap.bow.jackpot)}.
            </p>
          )}
        </section>
      )}

      {recap.final && (
        <section className="review__section">
          <h2>Split or Steal</h2>
          <ul className="review__picks">
            {recap.final.choices.map((c) => (
              <li key={c.seat} style={dot(c.seat)}>
                <span>
                  {name(c.seat)} chose <strong>{c.choice.toUpperCase()}</strong> and left with{' '}
                  {formatMoney(recap.final!.payouts.find((p) => p.seat === c.seat)?.amount ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
