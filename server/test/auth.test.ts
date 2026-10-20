import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { AdminAuth } from '../src/auth.js';

const req = (ip: string, cookie?: string) =>
  ({ ip, protocol: 'https', headers: cookie ? { cookie } : {} }) as unknown as FastifyRequest;
const cookieOf = (setCookie: string) => setCookie.split(';')[0]!;

describe('AdminAuth', () => {
  it('turns a correct password into a session cookie, and rejects forged or expired ones', () => {
    let now = 1_000_000;
    const auth = new AdminAuth('hunter2', () => now);
    const res = auth.login(req('1.1.1.1'), 'hunter2');
    if (!res.ok) throw new Error('login failed');
    expect(res.cookie).toMatch(/^gb_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);

    const cookie = cookieOf(res.cookie);
    expect(auth.isLoggedIn(req('9.9.9.9', cookie))).toBe(true);
    expect(auth.isLoggedIn(req('1.1.1.1'))).toBe(false);
    expect(auth.isLoggedIn(req('1.1.1.1', cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))))).toBe(false);
    // A cookie for a different password (changed since) doesn't work.
    expect(new AdminAuth('new password', () => now).isLoggedIn(req('1.1.1.1', cookie))).toBe(false);
    // Sessions last 30 days.
    now += 31 * 24 * 60 * 60_000;
    expect(auth.isLoggedIn(req('1.1.1.1', cookie))).toBe(false);
  });

  it('locks out an address after 5 wrong guesses, for 15 minutes', () => {
    let now = 0;
    const auth = new AdminAuth('hunter2', () => now);
    for (let i = 0; i < 4; i++) expect(auth.login(req('6.6.6.6'), `guess${i}`)).toMatchObject({ ok: false, status: 401 });
    expect(auth.login(req('6.6.6.6'), 'guess4')).toMatchObject({ ok: false, status: 429 });
    // Even the right password is refused while locked out; other people are unaffected.
    expect(auth.login(req('6.6.6.6'), 'hunter2')).toMatchObject({ ok: false, status: 429, retryAfterSec: 900 });
    expect(auth.login(req('7.7.7.7'), 'hunter2').ok).toBe(true);
    now += 15 * 60_000 + 1;
    expect(auth.login(req('6.6.6.6'), 'hunter2').ok).toBe(true);
  });

  it('pauses all logins after a flood of wrong guesses, but keeps existing sessions', () => {
    let now = 0;
    const auth = new AdminAuth('hunter2', () => now);
    const mine = auth.login(req('1.1.1.1'), 'hunter2');
    if (!mine.ok) throw new Error('login failed');
    for (let i = 0; i < 30; i++) auth.login(req(`10.0.0.${i}`), 'wrong');
    expect(auth.login(req('8.8.8.8'), 'hunter2')).toMatchObject({ ok: false, status: 429 });
    expect(auth.isLoggedIn(req('1.1.1.1', cookieOf(mine.cookie)))).toBe(true);
    now += 30 * 60_000 + 1;
    expect(auth.login(req('8.8.8.8'), 'hunter2').ok).toBe(true);
  });

  it('uses the visitor address Cloudflare passes on, not the tunnel', () => {
    const auth = new AdminAuth('hunter2', () => 0);
    const viaTunnel = (visitor: string) =>
      ({ ip: '127.0.0.1', protocol: 'http', headers: { 'cf-connecting-ip': visitor } }) as unknown as FastifyRequest;
    for (let i = 0; i < 5; i++) auth.login(viaTunnel('6.6.6.6'), 'wrong');
    expect(auth.login(viaTunnel('6.6.6.6'), 'hunter2')).toMatchObject({ status: 429 });
    expect(auth.login(viaTunnel('7.7.7.7'), 'hunter2').ok).toBe(true);
  });

  it('is open when no password is set (local development)', () => {
    const auth = new AdminAuth('');
    expect(auth.required).toBe(false);
    expect(auth.isLoggedIn(req('1.1.1.1'))).toBe(true);
  });
});
