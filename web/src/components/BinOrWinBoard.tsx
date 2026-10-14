import { formatMoney } from '@gb/shared';
import type { BoardView, SeatView } from '../lib/gameState';
import { Ball } from './Ball';

interface Props {
  board: BoardView;
  seats: SeatView[];
  /** When it's the human's pick: which action, and the handler. */
  picking?: { action: 'bin' | 'win'; onPick: (index: number) => void; busy: boolean };
}

export function BinOrWinBoard({ board, seats, picking }: Props) {
  const name = (seat: number) => seats[seat]?.info.name ?? '';
  return (
    <section className="board" aria-label="Bin or Win">
      <div className="board__jackpot">
        <span className="board__jackpot-label">Jackpot</span>
        <span className="board__jackpot-value">{formatMoney(board.jackpot)}</span>
        <span className="board__carried">
          Brought to the final:{' '}
          {board.carried.map((c, i) => (
            <span key={c.seat}>
              {i > 0 && ' · '}
              {name(c.seat)} {formatMoney(c.amount)}
            </span>
          ))}
        </span>
      </div>

      {picking && (
        <p className="board__prompt">
          Your turn: click a ball to <strong>{picking.action.toUpperCase()}</strong>.
        </p>
      )}

      <div className="board__slots">
        {board.slots.map((ball, i) => {
          const action = board.actions[i];
          const canPick = picking && ball === null && !picking.busy;
          return (
            <div key={i} className={`board__slot ${action ? `board__slot--${action}` : ''}`}>
              <Ball
                ball={ball}
                size="md"
                label={String(i + 1)}
                dim={action === 'bin' || action === 'leftover'}
                {...(canPick ? { onClick: () => picking.onPick(i) } : {})}
                {...(canPick ? { title: `${picking.action === 'bin' ? 'Bin' : 'Win'} ball ${i + 1}` } : {})}
              />
              <span className="board__slot-label">{action === 'leftover' ? 'last' : (action ?? '')}</span>
            </div>
          );
        })}
      </div>

      <div className="board__five">
        <span className="board__five-label">The Golden Five</span>
        <div className="board__five-balls">
          {Array.from({ length: 5 }, (_, i) => {
            const ball = board.won[i];
            return ball ? <Ball key={ball.id} ball={ball} size="md" /> : <span key={i} className="ball-slot" />;
          })}
        </div>
      </div>
    </section>
  );
}
