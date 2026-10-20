import { describe, expect, it } from 'vitest';
import { RequestLimiter } from '../src/limits.js';

describe('RequestLimiter', () => {
  it('caps requests per visitor per minute, separately for each visitor', () => {
    let now = 0;
    const limiter = new RequestLimiter({ perMinute: 3, streamsPerVisitor: 1, streamsTotal: 1 }, () => now);
    expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
    now += 60_000;
    expect(limiter.allow('a')).toBe(true);
  });

  it('caps open streams per visitor and in total, and frees them on release', () => {
    const limiter = new RequestLimiter({ perMinute: 100, streamsPerVisitor: 2, streamsTotal: 3 });
    const a1 = limiter.openStream('a');
    const a2 = limiter.openStream('a');
    expect(a1 && a2).toBeTruthy();
    expect(limiter.openStream('a')).toBeNull(); // per visitor
    const b1 = limiter.openStream('b');
    expect(b1).toBeTruthy();
    expect(limiter.openStream('c')).toBeNull(); // whole server
    a1!();
    a1!(); // releasing twice frees only one slot
    expect(limiter.openStream('c')).toBeTruthy();
    expect(limiter.openStream('c')).toBeNull();
  });
});
