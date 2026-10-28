import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, type PlayerInfo } from '@gb/shared';
import { MockAgent } from '../src/agents/mock.js';
import { Db } from '../src/db.js';
import { GameEngine } from '../src/engine/engine.js';

const players: PlayerInfo[] = ['mock/honest', 'mock/bluffer', 'mock/chaos', 'mock/chaos'].map((model, seat) => ({
  seat,
  name: ['Ava', 'Ben', 'Cleo', 'Dev'][seat]!,
  kind: 'mock',
  model,
}));

/** Plays an all-mock game into the database, as the game manager does. */
async function playInto(db: Db, id: string, seed: number): Promise<void> {
  const options = { ...DEFAULT_OPTIONS, seed };
  db.createGame({ id, createdAt: Date.now(), options, ranked: true, players: players.map((p) => ({ ...p, playerKey: p.model! })) });
  const engine = new GameEngine({
    players,
    agents: players.map((p) => new MockAgent(p.model!, seed + p.seat)),
    options,
    emit: (e) => db.appendEvent(id, e),
  });
  const result = await engine.run();
  db.finishGame(id, 'finished', { jackpot: result.jackpot, stats: result.stats });
}

/** What migration 5 added: the private ratings with each vote, checked against the truth. */
const VOTE_RATING_COLUMNS = [
  'beliefs',
  'beliefs_right',
  'lies_rated',
  'lies_believed',
  'own_lies_rated',
  'own_lies_believed',
  'vote_trust_given',
  'vote_trust_given_n',
  'vote_trust_received',
  'vote_trust_received_n',
];

const counts = (db: Db, gameId: string) =>
  db.sql.prepare(`SELECT seat, ${VOTE_RATING_COLUMNS.join(', ')} FROM game_players WHERE game_id = ? ORDER BY seat`).all(gameId);

describe('Db migrations', () => {
  let dir: string;
  let db: Db | undefined;
  afterEach(() => {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts the ratings with each vote for games played before the columns existed, from their events', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-db-test-'));
    const file = path.join(dir, 'games.db');
    db = new Db(file);
    await playInto(db, 'rated', 10);
    await playInto(db, 'older', 11);
    const counted = counts(db, 'rated');
    // Something to count: every call made, and some false claims among them.
    const sum = (col: string) => counted.reduce((n, r) => n + Number(r[col]), 0);
    expect(sum('beliefs')).toBe(18);
    expect(sum('lies_rated')).toBeGreaterThan(0);
    expect(sum('vote_trust_received')).toBe(sum('vote_trust_given'));

    // Wind the database back to version 4, from before the columns, with one game from before the ratings too.
    db.sql.exec(`DELETE FROM game_events WHERE game_id = 'older' AND type = 'trust'`);
    for (const col of VOTE_RATING_COLUMNS) db.sql.exec(`ALTER TABLE game_players DROP COLUMN ${col}`);
    db.sql.exec('PRAGMA user_version = 4');
    db.close();

    db = new Db(file);
    expect(db.sql.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    // The same numbers the engine counted as it went...
    expect(counts(db, 'rated')).toEqual(counted);
    // ...and nothing for a game without ratings.
    for (const row of counts(db, 'older')) for (const col of VOTE_RATING_COLUMNS) expect(row[col]).toBe(0);
    const board = db.leaderboard({ includeUnranked: true, includeHumans: true });
    expect(board.rows.reduce((n, r) => n + r.beliefs, 0)).toBe(18);
  });
});
