import type { CSSProperties } from 'react';
import { formatMoney } from '@gb/shared';
import type { FinalView, SeatView } from '../lib/gameState';
import { SEAT_COLORS } from '../lib/gameState';
import { ChoiceBall } from './Ball';

interface Props {
  final: FinalView;
  seats: SeatView[];
  thinking: number[];
  /** Present when the human must choose now. */
  choosing?: { onChoose: (choice: 'split' | 'steal') => void; busy: boolean };
}

const OUTCOME_TEXT = {
  both_split: 'Both split: the jackpot is shared',
  one_steal: 'One stole',
  both_steal: 'Both stole: nobody wins',
} as const;

export function FinalStage({ final, seats, thinking, choosing }: Props) {
  const revealed = final.outcome !== undefined;
  return (
    <section className="final" aria-label="Split or Steal">
      <div className="final__jackpot">
        <span className="board__jackpot-label">Split or Steal</span>
        <span className="board__jackpot-value">{formatMoney(final.jackpot)}</span>
        {revealed && <span className={`final__outcome final__outcome--${final.outcome}`}>{OUTCOME_TEXT[final.outcome!]}</span>}
      </div>
      <div className="final__players">
        {final.seats.map((seatNo) => {
          const seat = seats[seatNo]!;
          const choice = seat.finalChoice;
          const payout = final.payouts?.find((p) => p.seat === seatNo)?.amount;
          return (
            <div
              key={seatNo}
              className={`final__player ${thinking.includes(seatNo) ? 'podium--thinking' : ''}`}
              style={{ '--seat': SEAT_COLORS[seatNo % SEAT_COLORS.length] } as CSSProperties}
            >
              <div className="podium__name">{seat.info.name}</div>
              <div className="podium__model">
                {seat.info.kind === 'human'
                  ? 'Human'
                  : seat.info.modelLabel && seat.info.modelLabel !== seat.info.name
                    ? seat.info.modelLabel
                    : seat.info.model}
              </div>
              <div className="final__balls">
                {revealed && choice ? (
                  <ChoiceBall choice={choice} revealed />
                ) : (
                  <>
                    <ChoiceBall choice="split" revealed={false} size="md" />
                    <ChoiceBall choice="steal" revealed={false} size="md" />
                  </>
                )}
              </div>
              <div className="final__status">
                {revealed ? (
                  <>
                    {payout !== undefined && <span className="badge badge--win">Takes home {formatMoney(payout)}</span>}
                    {choice === 'steal' && final.promised[seatNo] !== undefined && (
                      <span className="badge badge--lie" title={`Before the reveal: “${final.promised[seatNo]}”`}>
                        Promised to split
                      </span>
                    )}
                  </>
                ) : seat.choiceLocked ? (
                  <span className="badge">Has chosen</span>
                ) : (
                  thinking.includes(seatNo) && <span className="badge badge--thinking">Thinking…</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {choosing && (
        <div className="final__choose">
          <p>Make your choice. The other player won't see it until you both reveal.</p>
          <div className="final__choose-buttons">
            <button className="btn btn--split" disabled={choosing.busy} onClick={() => choosing.onChoose('split')}>
              Split
            </button>
            <button className="btn btn--steal" disabled={choosing.busy} onClick={() => choosing.onChoose('steal')}>
              Steal
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
