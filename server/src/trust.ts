import type { GameEventBody, TrustSource } from '@gb/shared';

/** The trust one player gave another in one game, from one source: the sum of the scores (1 to 5) and how many. */
export interface GameTrustPair {
  source: TrustSource;
  rater: number;
  rated: number;
  total: number;
  ratings: number;
}

/**
 * Who rated whom in one game, summed per pair: the private ratings with each
 * vote (`trust` events, up to one per vote) and the trust in each other player
 * from the exit interviews. Ratings without a usable score are left out.
 */
export function trustPairs(events: Iterable<GameEventBody>): GameTrustPair[] {
  const pairs = new Map<string, GameTrustPair>();
  const add = (source: TrustSource, rater: number, rated: number, score: number | null | undefined) => {
    if (typeof score !== 'number' || !Number.isFinite(score) || rater === rated) return;
    const key = `${source}:${rater}:${rated}`;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { source, rater, rated, total: 0, ratings: 0 }));
    pair.total += score;
    pair.ratings++;
  };
  for (const e of events) {
    if (e.type === 'trust') for (const r of e.ratings) add('vote', e.seat, r.seat, r.trust);
    else if (e.type === 'interview') for (const t of e.answers.trustEach ?? []) add('interview', e.seat, t.seat, t.score);
  }
  return [...pairs.values()];
}
