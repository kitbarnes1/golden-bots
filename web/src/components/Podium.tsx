import { claimIsTruthful, formatMoney, type Ball as BallT, type ClaimValue } from '@gb/shared';
import type { SeatView } from '../lib/gameState';
import { SEAT_COLORS } from '../lib/gameState';
import { Ball } from './Ball';

interface PodiumProps {
  seat: SeatView;
  /** Show hidden balls that this viewer is allowed to know. */
  reveal: boolean;
  isYou: boolean;
  thinking: boolean;
  votingOpen: boolean;
}

export function Podium({ seat, reveal, isYou, thinking, votingOpen }: PodiumProps) {
  const { info } = seat;
  const out = seat.eliminatedStage !== null;
  const color = SEAT_COLORS[info.seat % SEAT_COLORS.length];
  const backBalls = out ? (seat.revealed?.back ?? []) : seat.back;
  const showBack = out || (backBalls !== null && (reveal || isYou || seat.backShown === true));
  const lying =
    !out && showBack && seat.claim && backBalls ? !claimIsTruthful(seat.claim, backBalls) : null;
  // Line claims up with the real balls they match, so the lies stand out.
  const claims = seat.claim && backBalls && showBack && !out ? alignClaims(seat.claim, backBalls) : seat.claim;

  return (
    <article
      className={`podium ${out ? 'podium--out' : ''} ${thinking ? 'podium--thinking' : ''}`}
      style={{ '--seat': color } as React.CSSProperties}
    >
      <header className="podium__head">
        <div className="podium__name">
          {info.name}
          {isYou && <span className="tag tag--you">You</span>}
        </div>
        <div className="podium__model">
          {info.kind === 'human' ? 'Human' : info.modelLabel && info.modelLabel !== info.name ? info.modelLabel : info.model}
          {info.kind === 'mock' && <span className="tag">mock</span>}
        </div>
      </header>

      <div className="podium__rows">
        <div className="podium__row">
          <span className="podium__rowlabel">Front</span>
          <div className="podium__balls">
            {seat.front.map((b) => (
              <Ball key={b.id} ball={b} size="sm" dim={out} />
            ))}
          </div>
        </div>
        <div className="podium__row">
          <span className="podium__rowlabel">Back</span>
          <div className="podium__balls">
            {showBack && backBalls
              ? backBalls.map((b, i) => (
                  <Ball
                    key={b.id}
                    ball={b}
                    size="sm"
                    peek={!out}
                    dim={out}
                    {...(!out && claims?.[i] !== undefined ? { claim: claims[i] } : {})}
                  />
                ))
              : Array.from({ length: seat.backCount }, (_, i) => (
                  <Ball
                    key={i}
                    ball={null}
                    size="sm"
                    label="?"
                    {...(seat.claim?.[i] !== undefined ? { claim: seat.claim[i] } : {})}
                  />
                ))}
          </div>
        </div>
      </div>

      <footer className="podium__foot">
        {out ? (
          <span className="badge badge--out">
            Out in {seat.eliminatedStage === 'r1' ? 'round 1' : 'round 2'}
            {seat.revealed && (seat.revealed.truthful ? ' · told the truth' : ' · was lying')}
          </span>
        ) : (
          <>
            {lying !== null && (
              <span className={`badge ${lying ? 'badge--lie' : 'badge--truth'}`}>{lying ? 'Bluffing' : 'Honest'}</span>
            )}
            {seat.votesReceived > 0 && (
              <span className="badge badge--votes">
                {seat.votesReceived} vote{seat.votesReceived === 1 ? '' : 's'}
              </span>
            )}
            {votingOpen && seat.voted && <span className="badge">Voted</span>}
            {seat.winnings !== undefined && <span className="badge badge--win">{formatMoney(seat.winnings)}</span>}
            {thinking && <span className="badge badge--thinking">{isYou ? 'Your turn' : 'Thinking…'}</span>}
          </>
        )}
      </footer>
    </article>
  );
}

function alignClaims(claim: ClaimValue[], back: BallT[]): ClaimValue[] {
  const remaining = [...claim];
  const out: (ClaimValue | undefined)[] = back.map((b) => {
    const want: ClaimValue = b.kind === 'killer' ? 'killer' : b.value;
    const i = remaining.indexOf(want);
    return i === -1 ? undefined : remaining.splice(i, 1)[0];
  });
  return out.map((c) => c ?? remaining.shift()!);
}
