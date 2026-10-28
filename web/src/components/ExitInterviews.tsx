import { useMemo, type CSSProperties } from 'react';
import { formatMoney, pairThoughts, type GameEvent } from '@gb/shared';
import { SEAT_COLORS, type GameView, type SeatView } from '../lib/gameState';
import { MoveThought } from './Feed';
import { InterviewAnswers } from './Interview';

const OUT_ORDER = { r2: 1, r1: 2 } as const;

/** Winners first (most money first), then whoever went out in round 2, then round 1. */
export function finishingOrder(seats: SeatView[]): SeatView[] {
  const rank = (s: SeatView) => (s.eliminatedStage ? OUT_ORDER[s.eliminatedStage] : 0);
  return [...seats].sort((a, b) => rank(a) - rank(b) || (b.winnings ?? -1) - (a.winnings ?? -1));
}

export function outcome(s: SeatView): string {
  if (s.eliminatedStage) return `eliminated in round ${s.eliminatedStage === 'r1' ? 1 : 2}`;
  if (!s.finalChoice) return 'still in the game';
  return `chose ${s.finalChoice.toUpperCase()} and won ${formatMoney(s.winnings ?? 0)}`;
}

/**
 * Every AI's exit interview in one place, checked against what happened. During a
 * game it fills up as each one leaves; once it's over, anyone who didn't answer says so.
 */
export function ExitInterviews({ view, events, showThoughts }: { view: GameView; events: GameEvent[]; showThoughts: boolean }) {
  const interviews = new Map(events.flatMap((e) => (e.type === 'interview' ? [[e.seat, e] as const] : [])));
  const { byMove } = useMemo(() => pairThoughts(events), [events]);
  const over = view.stage === 'over';
  const seats = finishingOrder(view.seats).filter((s) => s.info.kind !== 'human' && (over || interviews.has(s.info.seat)));
  const humans = view.seats.some((s) => s.info.kind === 'human');
  const who = (seat: number) => <strong>{view.players[seat]?.name ?? `Player ${seat + 1}`}</strong>;
  return (
    <section className="summary">
      <h2>Exit interviews</h2>
      <p className="muted small">
        Each AI answers a few questions on the way out, and the finalists after the final. Their answers are checked against what really happened.
        {!over && ' More arrive as players leave.'}
        {humans && " Humans aren't interviewed."}
      </p>
      <div className="exits">
        {seats.map((s) => {
          const e = interviews.get(s.info.seat);
          const thought = e && showThoughts ? byMove.get(String(e.seq)) : undefined;
          return (
            <article key={s.info.seat} className="exits__one" style={{ '--seat': SEAT_COLORS[s.info.seat % SEAT_COLORS.length] } as CSSProperties}>
              <h3>
                {s.info.name} <span className="muted small">{outcome(s)}</span>
              </h3>
              {e ? <InterviewAnswers event={e} events={events} who={who} /> : <p className="muted small">No interview: they didn't answer.</p>}
              {thought && <MoveThought event={thought} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
