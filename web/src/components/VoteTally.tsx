import type { CSSProperties } from 'react';
import { SEAT_COLORS, type SeatView, type VoteReading } from '../lib/gameState';

/** The votes as they're read out: a bar per player, growing one vote at a time. */
export function VoteTally({ reading, seats }: { reading: VoteReading; seats: SeatView[] }) {
  const candidates = seats.filter((s) => s.eliminatedStage === null || s.eliminatedStage === reading.stage);
  const count = (seat: number) => reading.read.filter((v) => v.target === seat).length;
  const most = Math.max(0, ...candidates.map((s) => count(s.info.seat)));
  const leaders = candidates.filter((s) => most > 0 && count(s.info.seat) === most);
  const latest = reading.done ? undefined : reading.read.at(-1);
  const out = seats.find((s) => s.eliminatedStage === reading.stage);
  const name = (seat: number) => seats[seat]?.info.name ?? `Player ${seat + 1}`;
  const color = (seat: number) => ({ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] }) as CSSProperties;

  let headline: string;
  if (out) headline = `${out.info.name} is out.`;
  else if (reading.done) headline = leaders.length > 1 ? `It's a tie between ${leaders.map((s) => s.info.name).join(' and ')}.` : 'All the votes are in.';
  else if (latest) headline = `${name(latest.seat)} votes for ${name(latest.target)}.`;
  else headline = 'The votes are in…';

  return (
    <section className="tally" aria-label="The votes" aria-live="polite">
      <header className="tally__head">
        <span className="tally__title">The votes</span>
        <span className="tally__count">
          {reading.read.length} of {reading.total} read
        </span>
      </header>
      <p className={`tally__headline ${out ? 'tally__headline--out' : ''}`} key={reading.read.length + (reading.done ? 'done' : '')}>
        {headline}
      </p>
      <ul className="tally__bars">
        {candidates.map((s) => {
          const n = count(s.info.seat);
          const justGot = latest?.target === s.info.seat;
          return (
            <li
              key={s.info.seat}
              className={`tally__row ${leaders.includes(s) ? 'tally__row--leading' : ''} ${out === s ? 'tally__row--out' : ''}`}
              style={color(s.info.seat)}
            >
              <span className="tally__name">{s.info.name}</span>
              <span className="tally__track">
                <span className={`tally__bar ${justGot ? 'tally__bar--new' : ''}`} style={{ width: `${(n / Math.max(1, reading.total)) * 100}%` }} />
              </span>
              <span className="tally__n">{n}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
