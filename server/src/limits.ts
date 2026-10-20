import type { FastifyRequest } from 'fastify';

export interface LimitOptions {
  /** API requests per visitor per minute. */
  perMinute: number;
  /** Live-game streams (SSE) one visitor may hold open, and the whole server. */
  streamsPerVisitor: number;
  streamsTotal: number;
}

export const DEFAULT_LIMITS: LimitOptions = { perMinute: 240, streamsPerVisitor: 12, streamsTotal: 500 };

/**
 * Keeps one busy or hostile client from swamping a small server: a cap on API
 * requests per visitor per minute, and on how many live-game streams they hold.
 */
export class RequestLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly streams = new Map<string, number>();
  private totalStreams = 0;

  constructor(
    private readonly opts: LimitOptions = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count a request; false when this visitor is over their limit for the minute. */
  allow(visitor: string): boolean {
    const now = this.now();
    let w = this.windows.get(visitor);
    if (!w || now - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.forgetOldWindows(now);
      w = { start: now, count: 0 };
      this.windows.set(visitor, w);
    }
    return ++w.count <= this.opts.perMinute;
  }

  /** Reserve a stream slot. Returns a release function, or null when there's no room. */
  openStream(visitor: string): (() => void) | null {
    const mine = this.streams.get(visitor) ?? 0;
    if (mine >= this.opts.streamsPerVisitor || this.totalStreams >= this.opts.streamsTotal) return null;
    this.streams.set(visitor, mine + 1);
    this.totalStreams++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.totalStreams--;
      const left = (this.streams.get(visitor) ?? 1) - 1;
      if (left > 0) this.streams.set(visitor, left);
      else this.streams.delete(visitor);
    };
  }

  private forgetOldWindows(now: number): void {
    for (const [visitor, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(visitor);
  }
}

/** Behind the Cloudflare tunnel the visitor's address arrives in CF-Connecting-IP. */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && cf ? cf : req.ip;
}
