import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, TRUST_HUMANS_KEY, type GameEvent, type GameEventBody, type PlayerKind, type TrustPair } from '@gb/shared';
import { Db } from '../src/db.js';
import type { PlayerStats } from '../src/engine/engine.js';
import { trustPairs } from '../src/trust.js';

const voteTrust = (stage: 'r1' | 'r2', seat: number, ratings: [number, number | null][]): GameEventBody => ({
  type: 'trust',
  stage,
  seat,
  ratings: ratings.map(([rated, trust]) => ({ seat: rated, believes: null, trust })),
});

const interview = (seat: number, trustEach: [number, number][] | null): GameEventBody => ({
  type: 'interview',
  seat,
  when: 'final',
  answers: { say: '', claimsTrue: true, trustEach: trustEach?.map(([rated, score]) => ({ seat: rated, score })) ?? null },
});

describe('trustPairs', () => {
  it('sums each rater and rated pair, keeping the votes and the interviews apart', () => {
    const pairs = trustPairs([
      { type: 'host', text: 'Welcome' },
      voteTrust('r1', 0, [[1, 4], [2, 2], [3, null]]),
      voteTrust('r2', 0, [[1, 5], [2, 1]]),
      interview(0, [[1, 3], [2, 1], [3, 2]]),
      interview(1, null),
    ]);
    const find = (source: string, rater: number, rated: number) =>
      pairs.find((p) => p.source === source && p.rater === rater && p.rated === rated);
    // Two votes rated seat 1: 4 then 5.
    expect(find('vote', 0, 1)).toEqual({ source: 'vote', rater: 0, rated: 1, total: 9, ratings: 2 });
    expect(find('vote', 0, 2)).toMatchObject({ total: 3, ratings: 2 });
    // No usable trust score, so nothing for seat 3 at the votes.
    expect(find('vote', 0, 3)).toBeUndefined();
    expect(find('interview', 0, 1)).toMatchObject({ total: 3, ratings: 1 });
    expect(find('interview', 0, 3)).toMatchObject({ total: 2, ratings: 1 });
    expect(pairs.filter((p) => p.rater === 1)).toEqual([]);
    expect(pairs).toHaveLength(5);
  });

  it('ignores ratings of yourself and scores that are not numbers', () => {
    const bad = { seat: 1, believes: true, trust: 'lots' } as unknown as { seat: number; believes: boolean; trust: number };
    expect(trustPairs([voteTrust('r1', 2, [[2, 5]]), { type: 'trust', stage: 'r1', seat: 0, ratings: [bad] }])).toEqual([]);
  });
});

const stats = (seat: number): PlayerStats => ({
  seat,
  eliminatedStage: null,
  reachedFinal: false,
  finalChoice: null,
  finalOutcome: null,
  promisedSplit: null,
  winnings: 0,
  claims: 0,
  truthfulClaims: 0,
  votesReceived: 0,
  invalidResponses: 0,
  llmCalls: 0,
  costUsd: 0,
  interview: null,
  trustGiven: 0,
  trustGivenCount: 0,
  trustReceived: 0,
  trustReceivedCount: 0,
});

type Seat = { kind: PlayerKind; key: string };
const ai = (model: string): Seat => ({ kind: 'ai', key: model });
const human = (name: string): Seat => ({ kind: 'human', key: `human:${name}` });

let gameNo = 0;
/** A game with these seats and these rating events, finished (or not). */
function playGame(db: Db, seats: Seat[], events: GameEventBody[], opts: { ranked?: boolean; finish?: boolean } = {}): string {
  const id = `g${++gameNo}`;
  db.createGame({
    id,
    createdAt: gameNo,
    options: { ...DEFAULT_OPTIONS, seed: 1 },
    ranked: opts.ranked ?? true,
    players: seats.map((s, seat) => ({
      seat,
      name: s.kind === 'human' ? s.key.slice(6) : s.key,
      kind: s.kind,
      ...(s.kind === 'human' ? {} : { model: s.key, modelLabel: s.key.toUpperCase() }),
      playerKey: s.key,
    })),
  });
  events.forEach((e, seq) => db.appendEvent(id, { ...e, seq, ts: seq, vis: 'public' } as GameEvent));
  if (opts.finish ?? true) db.finishGame(id, 'finished', { jackpot: 0, stats: seats.map((_, seat) => stats(seat)) });
  return id;
}

const pair = (trust: TrustPair[], source: string, from: string, to: string) =>
  trust.find((p) => p.source === source && p.from === from && p.to === to);

describe('trust grid in the leaderboard', () => {
  const dbs: Db[] = [];
  const open = (file = ':memory:') => {
    const db = new Db(file);
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('adds up ratings across games, between models rather than seats', () => {
    const db = open();
    const seats = [ai('a/one'), ai('b/two'), ai('c/three'), ai('a/one')];
    playGame(db, seats, [voteTrust('r1', 0, [[1, 4], [2, 2], [3, 5]]), interview(0, [[1, 2], [2, 2], [3, 4]])]);
    playGame(db, [ai('b/two'), ai('a/one'), ai('c/three'), ai('d/four')], [voteTrust('r1', 1, [[0, 2], [2, 3], [3, 1]])]);

    const { trust } = db.leaderboard({ includeUnranked: false, includeHumans: false });
    // a/one rated b/two at a vote in both games: 4, then 2.
    expect(pair(trust, 'vote', 'a/one', 'b/two')).toEqual({ from: 'a/one', to: 'b/two', source: 'vote', total: 6, ratings: 2 });
    expect(pair(trust, 'interview', 'a/one', 'b/two')).toMatchObject({ total: 2, ratings: 1 });
    expect(pair(trust, 'vote', 'a/one', 'c/three')).toMatchObject({ total: 5, ratings: 2 });
    // A model rating another copy of itself.
    expect(pair(trust, 'vote', 'a/one', 'a/one')).toMatchObject({ total: 5, ratings: 1 });
    expect(pair(trust, 'vote', 'b/two', 'a/one')).toBeUndefined();
    expect(trust.reduce((s, p) => s + p.ratings, 0)).toBe(9);
  });

  it('counts only finished games, and practice games only when asked', () => {
    const db = open();
    const seats = [ai('a/one'), ai('b/two'), ai('c/three'), ai('d/four')];
    playGame(db, seats, [voteTrust('r1', 0, [[1, 5]])]);
    playGame(db, seats, [voteTrust('r1', 0, [[1, 1]])], { ranked: false });
    playGame(db, seats, [voteTrust('r1', 0, [[1, 1]])], { finish: false });
    const errored = playGame(db, seats, [voteTrust('r1', 0, [[1, 1]])], { finish: false });
    db.finishGame(errored, 'error', { jackpot: null, stats: seats.map((_, seat) => stats(seat)), error: 'boom' });

    expect(pair(db.leaderboard({ includeUnranked: false, includeHumans: false }).trust, 'vote', 'a/one', 'b/two')).toMatchObject({ total: 5, ratings: 1 });
    expect(pair(db.leaderboard({ includeUnranked: true, includeHumans: false }).trust, 'vote', 'a/one', 'b/two')).toMatchObject({ total: 6, ratings: 2 });
  });

  it('shows every human as one contestant, and only when humans are included', () => {
    const db = open();
    playGame(db, [human('kit'), ai('a/one'), ai('b/two'), ai('c/three')], [voteTrust('r1', 1, [[0, 2], [2, 4]]), interview(2, [[0, 3]])]);
    playGame(db, [ai('a/one'), human('sam'), ai('b/two'), ai('c/three')], [voteTrust('r1', 0, [[1, 4]])]);

    const without = db.leaderboard({ includeUnranked: false, includeHumans: false }).trust;
    expect(without.some((p) => p.from === TRUST_HUMANS_KEY || p.to === TRUST_HUMANS_KEY || p.to.startsWith('human:'))).toBe(false);
    // The AIs' ratings of each other still count in games with a human.
    expect(pair(without, 'vote', 'a/one', 'b/two')).toMatchObject({ total: 4, ratings: 1 });

    const withHumans = db.leaderboard({ includeUnranked: false, includeHumans: true }).trust;
    expect(pair(withHumans, 'vote', 'a/one', TRUST_HUMANS_KEY)).toMatchObject({ total: 6, ratings: 2 });
    expect(pair(withHumans, 'interview', 'b/two', TRUST_HUMANS_KEY)).toMatchObject({ total: 3, ratings: 1 });
    expect(withHumans.some((p) => p.to.startsWith('human:'))).toBe(false);
  });

  it('forgets a deleted game', () => {
    const db = open();
    const id = playGame(db, [ai('a/one'), ai('b/two'), ai('c/three'), ai('d/four')], [voteTrust('r1', 0, [[1, 5]])]);
    expect(db.leaderboard({ includeUnranked: false, includeHumans: false }).trust).toHaveLength(1);
    db.deleteGame(id);
    expect(db.leaderboard({ includeUnranked: false, includeHumans: false }).trust).toEqual([]);
  });

  it('fills in games from before the table existed, from their stored events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-trust-'));
    const file = path.join(dir, 'games.db');
    try {
      const before = open(file);
      playGame(before, [ai('a/one'), ai('b/two'), ai('c/three'), ai('d/four')], [voteTrust('r1', 0, [[1, 4], [2, 3]]), voteTrust('r2', 0, [[1, 2]]), interview(3, [[0, 5]])]);
      const expected = before.leaderboard({ includeUnranked: false, includeHumans: false }).trust;
      expect(expected).toHaveLength(3);
      // Back to how a database from before this table looked (without the promise column added after it, too).
      before.sql.exec('DROP TABLE trust_pairs; ALTER TABLE game_players DROP COLUMN promised_split; PRAGMA user_version = 4;');
      before.close();
      dbs.splice(dbs.indexOf(before), 1);

      const after = open(file);
      expect((after.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6);
      expect(after.leaderboard({ includeUnranked: false, includeHumans: false }).trust).toEqual(expected);
      expect(pair(expected, 'vote', 'a/one', 'b/two')).toMatchObject({ total: 6, ratings: 2 });
    } finally {
      for (const db of dbs.splice(0)) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
