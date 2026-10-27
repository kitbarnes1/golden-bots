import type { CSSProperties } from 'react';
import { claimIsTruthful, formatMoney } from '@gb/shared';
import { SEAT_COLORS, type GameView, type SeatView } from '../lib/gameState';
import { Ball, ChoiceBall } from './Ball';

interface Props {
  view: GameView;
  /** Show hidden balls this viewer is allowed to know. */
  reveal: boolean;
  mySeat?: number;
  thinking: number[];
}

/**
 * The table at a glance, for narrow screens: pinned above the feed so the balls
 * stay in view while you read. (Wide screens show the full stage beside the feed.)
 */
export function TableStrip({ view, reveal, mySeat, thinking }: Props) {
  const color = (seat: number) => ({ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] }) as CSSProperties;

  if (view.stage === 'bow' && view.board) {
    const b = view.board;
    return (
      <section className="strip strip--line" aria-label="Bin or Win">
        <span className="strip__title">Bin or Win</span>
        <span className="strip__money">{formatMoney(b.jackpot)}</span>
        <span className="strip__balls" aria-label="Balls won">
          {b.won.map((ball) => (
            <Ball key={ball.id} ball={ball} size="xs" />
          ))}
          {Array.from({ length: Math.max(0, 5 - b.won.length) }, (_, i) => (
            <span key={i} className="strip__slot" />
          ))}
        </span>
      </section>
    );
  }

  if ((view.stage === 'final' || view.stage === 'over') && view.final) {
    const f = view.final;
    return (
      <section className="strip strip--line" aria-label="Split or Steal">
        <span className="strip__title">Split or Steal</span>
        <span className="strip__money">{formatMoney(f.jackpot)}</span>
        {f.seats.map((seat) => {
          const s = view.seats[seat]!;
          return (
            <span key={seat} className="strip__finalist" style={color(seat)}>
              <span className="strip__name">{s.info.name}</span>
              {s.finalChoice ? (
                <ChoiceBall choice={s.finalChoice} revealed size="xs" />
              ) : (
                <span className="strip__badge">{s.choiceLocked ? 'Chosen' : thinking.includes(seat) ? 'Thinking…' : 'Deciding'}</span>
              )}
            </span>
          );
        })}
      </section>
    );
  }

  if (view.seats.length === 0) return null;
  return (
    <section className="strip" aria-label="The table">
      {view.seats.map((s) => (
        <Seat key={s.info.seat} seat={s} reveal={reveal} isYou={s.info.seat === mySeat} thinking={thinking.includes(s.info.seat)} style={color(s.info.seat)} />
      ))}
    </section>
  );
}

function Seat({ seat, reveal, isYou, thinking, style }: { seat: SeatView; reveal: boolean; isYou: boolean; thinking: boolean; style: CSSProperties }) {
  const out = seat.eliminatedStage !== null;
  const back = out ? (seat.revealed?.back ?? []) : seat.back;
  const showBack = out || (back !== null && (reveal || isYou || seat.backShown === true));
  const lying = !out && showBack && seat.claim && back ? !claimIsTruthful(seat.claim, back) : null;

  return (
    <div className={`strip__seat ${out ? 'strip__seat--out' : ''} ${thinking ? 'strip__seat--thinking' : ''}`} style={style}>
      <div className="strip__head">
        <span className="strip__name">
          {seat.info.name}
          {isYou && ' (you)'}
        </span>
        {out ? (
          <span className="strip__badge">Out</span>
        ) : (
          <>
            {seat.votesReceived > 0 && (
              <span className="strip__badge strip__badge--votes">
                {seat.votesReceived} vote{seat.votesReceived === 1 ? '' : 's'}
              </span>
            )}
            {lying !== null && <span className={`strip__badge ${lying ? 'strip__badge--lie' : ''}`}>{lying ? 'Bluffing' : 'Honest'}</span>}
          </>
        )}
      </div>
      <div className="strip__balls">
        {seat.front.map((b) => (
          <Ball key={b.id} ball={b} size="xs" dim={out} />
        ))}
        {(seat.front.length > 0 || seat.backCount > 0) && <span className="strip__divider" aria-hidden />}
        {showBack && back
          ? back.map((b) => <Ball key={b.id} ball={b} size="xs" peek={!out} dim={out} />)
          : Array.from({ length: seat.backCount }, (_, i) => <Ball key={i} ball={null} size="xs" label="?" />)}
      </div>
      {!out && !showBack && seat.claim && (
        <div className="strip__claim">
          claims {seat.claim.map((c) => (c === 'killer' ? 'Killer' : formatMoney(c))).join(', ')}
        </div>
      )}
    </div>
  );
}
