import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const COOKIE = 'gb_session';
const SESSION_MS = 30 * 24 * 60 * 60_000;
/** Wrong guesses from one address before it is locked out, and for how long. */
const IP_MAX_FAILS = 5;
const IP_LOCK_MS = 15 * 60_000;
/** Wrong guesses from everyone in an hour before all logins pause (spread-out attacks). */
const SITE_MAX_FAILS = 30;
const SITE_WINDOW_MS = 60 * 60_000;
const SITE_LOCK_MS = 30 * 60_000;

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; status: 401 | 429; error: string; retryAfterSec?: number };

/**
 * Admin login. A correct password earns a signed, expiring session cookie, so the
 * password is never stored in the browser or sent again. Wrong guesses lock out
 * the guesser, and a flood of them from anywhere pauses logins for everyone
 * (existing sessions keep working).
 */
export class AdminAuth {
  private readonly key: Buffer;
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>();
  private siteFails: number[] = [];
  private siteLockedUntil = 0;

  constructor(
    private readonly password: string,
    private readonly now: () => number = Date.now,
  ) {
    // Derived from the password, so changing it signs everyone out.
    this.key = createHash('sha256').update(`golden-balls session:${password}`).digest();
  }

  /** No password configured (local development): everything is open. */
  get required(): boolean {
    return this.password !== '';
  }

  isLoggedIn(req: FastifyRequest): boolean {
    if (!this.required) return true;
    const [expires, sig] = (readCookie(req, COOKIE) ?? '').split('.');
    if (!expires || !sig || !(Number(expires) > this.now())) return false;
    const want = this.sign(expires);
    const got = Buffer.from(sig, 'base64url');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  login(req: FastifyRequest, password: unknown): LoginResult {
    const now = this.now();
    if (this.siteLockedUntil > now) return locked(this.siteLockedUntil - now);
    const ip = clientIp(req);
    const entry = this.fails.get(ip) ?? { count: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now) return locked(entry.lockedUntil - now);

    if (typeof password === 'string' && sameSecret(password, this.password)) {
      this.fails.delete(ip);
      return { ok: true, cookie: this.cookie(String(now + SESSION_MS), SESSION_MS / 1000, isHttps(req)) };
    }

    entry.count++;
    if (entry.count >= IP_MAX_FAILS) {
      entry.count = 0;
      entry.lockedUntil = now + IP_LOCK_MS;
    }
    if (this.fails.size > 5000) this.forgetOldFailures(now);
    this.fails.set(ip, entry);
    this.siteFails = this.siteFails.filter((t) => t > now - SITE_WINDOW_MS);
    this.siteFails.push(now);
    if (this.siteFails.length >= SITE_MAX_FAILS) {
      this.siteFails = [];
      this.siteLockedUntil = now + SITE_LOCK_MS;
    }
    return entry.lockedUntil > now ? locked(entry.lockedUntil - now) : { ok: false, status: 401, error: 'Wrong password.' };
  }

  logoutCookie(req: FastifyRequest): string {
    return this.cookie('', 0, isHttps(req));
  }

  private sign(expires: string): Buffer {
    return createHmac('sha256', this.key).update(`admin.${expires}`).digest();
  }

  private cookie(expires: string, maxAgeSec: number, secure: boolean): string {
    const value = expires ? `${expires}.${this.sign(expires).toString('base64url')}` : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeSec)}${secure ? '; Secure' : ''}`;
  }

  private forgetOldFailures(now: number): void {
    for (const [ip, e] of this.fails) if (e.lockedUntil <= now) this.fails.delete(ip);
  }
}

function locked(ms: number): LoginResult {
  const minutes = Math.ceil(ms / 60_000);
  return {
    ok: false,
    status: 429,
    error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    retryAfterSec: Math.ceil(ms / 1000),
  };
}

/** Compare without leaking timing (hashing first makes the lengths equal). */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Behind the Cloudflare tunnel the visitor's address arrives in CF-Connecting-IP. */
function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && cf ? cf : req.ip;
}

function isHttps(req: FastifyRequest): boolean {
  return req.protocol === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] ?? ''));
}
