import type { Ball, ClaimValue } from './types.js';

/**
 * The bank: 100 cash balls from £10 to £75,000, weighted towards smaller
 * amounts as on the TV show. [value, how many balls]
 */
export const GOLDEN_BANK: ReadonlyArray<readonly [number, number]> = [
  [10, 4],
  [20, 3],
  [50, 5],
  [75, 3],
  [100, 6],
  [150, 3],
  [200, 4],
  [250, 5],
  [300, 3],
  [400, 3],
  [500, 6],
  [600, 2],
  [750, 4],
  [800, 2],
  [1_000, 6],
  [1_250, 2],
  [1_500, 3],
  [2_000, 4],
  [2_500, 3],
  [3_000, 2],
  [3_500, 2],
  [4_000, 2],
  [5_000, 4],
  [6_000, 2],
  [7_500, 2],
  [10_000, 3],
  [12_500, 1],
  [15_000, 2],
  [20_000, 2],
  [25_000, 2],
  [30_000, 1],
  [40_000, 1],
  [50_000, 1],
  [60_000, 1],
  [75_000, 1],
];

export const RULES = {
  r1: { cash: 12, killers: 4, front: 2, back: 2 },
  r2: { extraCash: 2, extraKillers: 1, front: 2, back: 3 },
  bow: { extraKillers: 1, toWin: 5 },
  killerDivisor: 10,
} as const;

export function cashTotal(balls: readonly Ball[]): number {
  return balls.reduce((sum, b) => sum + (b.kind === 'cash' ? b.value : 0), 0);
}

export function formatMoney(amount: number): string {
  const hasPence = Math.round(amount * 100) % 100 !== 0;
  return (
    '£' +
    amount.toLocaleString('en-GB', {
      minimumFractionDigits: hasPence ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

export function describeBall(ball: Ball): string {
  return ball.kind === 'killer' ? 'KILLER' : formatMoney(ball.value);
}

export function describeClaimValue(value: ClaimValue): string {
  return value === 'killer' ? 'KILLER' : formatMoney(value);
}

export function describeList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** True if the claimed values match the real balls (order doesn't matter). */
export function claimIsTruthful(claim: readonly ClaimValue[], actual: readonly Ball[]): boolean {
  if (claim.length !== actual.length) return false;
  const key = (v: ClaimValue) => (v === 'killer' ? 'k' : `c${v}`);
  const a = claim.map(key).sort();
  const b = actual.map((ball) => key(ball.kind === 'killer' ? 'killer' : ball.value)).sort();
  return a.every((v, i) => v === b[i]);
}

/** Sum a claim the way the other players will read it. */
export function claimTotal(claim: readonly ClaimValue[]): number {
  return claim.reduce<number>((sum, v) => sum + (v === 'killer' ? 0 : v), 0);
}
