import type { GameEvent } from './events.js';

export type ThoughtEvent = Extract<GameEvent, { type: 'thoughts' }>;

/** Moves whose thinking would give away a result that hasn't been revealed yet. */
const SECRET_UNTIL_REVEALED = new Set<ThoughtEvent['action']>(['vote', 'tie_decide', 'final_choice']);

export interface PairedThoughts {
  /**
   * The thinking behind each move, keyed by the move's event: `"<seq>"`, or
   * `"<seq>:<seat>"` for events that report several players' moves at once
   * (all the votes, a tie-break, the final reveal).
   */
  byMove: Map<string, ThoughtEvent>;
  /** Thoughts with no move to sit with (a fumble, or a chat cut off by the clock): shown where they happened. */
  loose: Set<number>;
}

/**
 * Match each private thought to the move it explains, so the feed can show who
 * thought what next to what they then said or did. A thought for a vote, tie
 * decision or final choice that hasn't been revealed yet matches nothing and
 * isn't loose either: it stays hidden until the reveal.
 */
export function pairThoughts(events: GameEvent[]): PairedThoughts {
  const byMove = new Map<string, ThoughtEvent>();
  const loose = new Set<number>();
  const waiting = new Map<number, ThoughtEvent>();

  const match = (seat: number, actions: ThoughtEvent['action'][], key: string) => {
    const t = waiting.get(seat);
    if (t && actions.includes(t.action)) {
      byMove.set(key, t);
      waiting.delete(seat);
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'thoughts': {
        const earlier = waiting.get(e.seat);
        if (earlier) loose.add(earlier.seq);
        waiting.set(e.seat, e);
        break;
      }
      case 'claim':
        match(e.seat, ['claim'], `${e.seq}`);
        break;
      case 'speech':
        match(e.seat, ['speak', 'chat'], `${e.seq}`);
        break;
      case 'chat_pass':
        match(e.seat, ['chat'], `${e.seq}`);
        break;
      case 'vote_revealed':
        match(e.seat, ['vote'], `${e.seq}`);
        break;
      case 'votes_revealed':
        // Games from before votes were read out one at a time.
        for (const v of e.votes) match(v.seat, ['vote'], `${e.seq}:${v.seat}`);
        break;
      case 'tie_decision':
        for (const d of e.decisions) match(d.seat, ['tie_decide'], `${e.seq}:${d.seat}`);
        break;
      case 'ball_picked':
        match(e.seat, ['pick'], `${e.seq}`);
        break;
      case 'final_reveal':
        for (const c of e.choices) match(c.seat, ['final_choice'], `${e.seq}:${c.seat}`);
        break;
      case 'interview':
        match(e.seat, ['interview'], `${e.seq}`);
        break;
      default:
        break;
    }
  }
  for (const t of waiting.values()) if (!SECRET_UNTIL_REVEALED.has(t.action)) loose.add(t.seq);
  return { byMove, loose };
}
