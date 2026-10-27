import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { claimIsTruthful, describeClaimValue, formatMoney, type GameEvent, type PlayerInfo } from '@gb/shared';
import { SEAT_COLORS } from '../lib/gameState';
import { Ball } from './Ball';
import { InterviewAnswers } from './Interview';
import { buildRecap } from './RoundsReview';

interface Props {
  seat: number;
  events: GameEvent[];
  players: PlayerInfo[];
  /** Show hidden balls this viewer is allowed to know ("Reveal hidden balls"). */
  showHidden: boolean;
  viewerSeat?: number;
  /** Their lines are highlighted in the feed. */
  highlighted: boolean;
  onHighlight: () => void;
  onClose: () => void;
  who: (seat: number) => ReactNode;
}

/** Everything known about one contestant so far: their balls and claims round by round, votes, the final and their exit interview. */
export function PlayerCard({ seat, events, players, showHidden, viewerSeat, highlighted, onHighlight, onClose, who }: Props) {
  const name = (s: number) => players[s]?.name ?? `Player ${s + 1}`;
  // Esc closes it, like any other pop-up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const recap = useMemo(() => buildRecap(events, (s) => players[s]?.name ?? `Player ${s + 1}`), [events, players]);
  const info = players[seat];
  const interview = events.findLast((e): e is Extract<GameEvent, { type: 'interview' }> => e.type === 'interview' && e.seat === seat);
  const rounds = recap.rounds.flatMap((r) => {
    const s = r.seats.find((x) => x.seat === seat);
    return s ? [{ stage: r.stage, s }] : [];
  });
  const outIn = rounds.find((r) => r.s.eliminated)?.stage;
  const choice = recap.final?.choices.find((c) => c.seat === seat)?.choice;
  const won = recap.final?.payouts.find((p) => p.seat === seat)?.amount;
  const carried = recap.bow?.carried.find((c) => c.seat === seat)?.amount;

  let status: string;
  if (outIn) status = `Out in round ${outIn === 'r1' ? 1 : 2}`;
  else if (choice) status = `Chose ${choice.toUpperCase()} and won ${formatMoney(won ?? 0)}`;
  else if (carried !== undefined) status = 'In the final';
  else status = 'Still in';

  return (
    <section className="pcard" style={{ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] } as CSSProperties} aria-label={`About ${name(seat)}`}>
      <header className="pcard__head">
        <div>
          <div className="pcard__name">
            {name(seat)}
            {seat === viewerSeat && ' (you)'}
          </div>
          <div className="pcard__model">
            {info?.kind === 'human' ? 'Human player' : (info?.modelLabel ?? info?.model ?? '')}
            {info?.kind === 'mock' && ' · mock bot'}
          </div>
        </div>
        <div className="pcard__actions">
          <button type="button" className="linklike" onClick={onHighlight} aria-pressed={highlighted}>
            {highlighted ? 'Show everyone' : 'Highlight their lines'}
          </button>
          <button type="button" className="pcard__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </header>
      <p className="pcard__status">{status}</p>

      {rounds.map(({ stage, s }) => {
        const backKnown = s.back !== null && (s.shown || showHidden || seat === viewerSeat);
        const verdict = backKnown && s.claim ? claimIsTruthful(s.claim, s.back!) : null;
        return (
          <div key={stage} className="pcard__round">
            <div className="pcard__label">Round {stage === 'r1' ? 1 : 2}</div>
            <div className="pcard__balls">
              {s.front.map((b) => (
                <Ball key={b.id} ball={b} size="xs" />
              ))}
              <span className="pcard__divider" aria-hidden />
              {backKnown
                ? s.back!.map((b) => <Ball key={b.id} ball={b} size="xs" peek={!s.shown} />)
                : Array.from({ length: s.backCount }, (_, i) => <Ball key={i} ball={null} size="xs" label="?" />)}
            </div>
            <div className="pcard__facts">
              {s.claim && (
                <span>
                  Claimed {s.claim.map(describeClaimValue).join(', ')}
                  {verdict !== null && <span className={`badge ${verdict ? 'badge--truth' : 'badge--lie'}`}>{verdict ? 'True' : 'Lie'}</span>}
                </span>
              )}
              {s.votedFor !== undefined && <span>Voted for {who(s.votedFor)}</span>}
              {s.votes > 0 && (
                <span>
                  Got {s.votes} vote{s.votes === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {carried !== undefined && (
        <div className="pcard__round">
          <div className="pcard__label">The final</div>
          <div className="pcard__facts">
            <span>Brought {formatMoney(carried)} into Bin or Win</span>
            {choice && (
              <span>
                Chose <strong className={`choice choice--${choice}`}>{choice.toUpperCase()}</strong>, won {formatMoney(won ?? 0)}
              </span>
            )}
          </div>
        </div>
      )}

      {interview && (
        <div className="pcard__round">
          <div className="pcard__label">Exit interview</div>
          <InterviewAnswers event={interview} events={events} who={who} />
        </div>
      )}
    </section>
  );
}
