import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  splitPromises,
  type GameEvent,
  type GameOptions,
  type GamePlayerSummary,
  type GameStatus,
  type GameSummary,
  type LeaderboardHistoryPoint,
  type LeaderboardResponse,
  type LeaderboardRow,
  type PlayerInfo,
  type PlayerKind,
  type Stage,
  type FinalChoice,
} from '@gb/shared';
import type { PlayerStats } from './engine/engine.js';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    options TEXT NOT NULL,
    has_human INTEGER NOT NULL DEFAULT 0,
    ranked INTEGER NOT NULL DEFAULT 1,
    jackpot REAL,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX games_status_finished ON games(status, finished_at);
  CREATE INDEX games_created ON games(created_at);

  CREATE TABLE game_players (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seat INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT,
    model_label TEXT,
    player_key TEXT NOT NULL,
    player_token TEXT,
    eliminated_stage TEXT,
    reached_final INTEGER NOT NULL DEFAULT 0,
    final_choice TEXT,
    final_outcome TEXT,
    winnings REAL NOT NULL DEFAULT 0,
    claims INTEGER NOT NULL DEFAULT 0,
    truthful_claims INTEGER NOT NULL DEFAULT 0,
    votes_received INTEGER NOT NULL DEFAULT 0,
    invalid_responses INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, seat)
  );
  CREATE INDEX game_players_key ON game_players(player_key);

  CREATE TABLE game_events (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    vis TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (game_id, seq)
  );
  `,
  `
  CREATE TABLE settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // Exit interviews, checked against what happened (null = not asked, or no usable answer).
  `
  ALTER TABLE game_players ADD COLUMN iv_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE game_players ADD COLUMN iv_claims_true INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_lied INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_saw_coming INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_called_winner INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_planned TEXT;
  ALTER TABLE game_players ADD COLUMN iv_stuck INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_same_again INTEGER;
  ALTER TABLE game_players ADD COLUMN iv_trust INTEGER;
  `,
  // Trust scores from the exit interviews: what each player gave the others, and what they got.
  `
  ALTER TABLE game_players ADD COLUMN trust_given INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE game_players ADD COLUMN trust_given_n INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE game_players ADD COLUMN trust_received INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE game_players ADD COLUMN trust_received_n INTEGER NOT NULL DEFAULT 0;
  `,
  // Finalists: did they tell the other they'd split? Games played before this are read from their chat (fillInPromises).
  `
  ALTER TABLE game_players ADD COLUMN promised_split INTEGER;
  `,
];

const bit = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 1 : 0);

export interface NewGame {
  id: string;
  createdAt: number;
  options: GameOptions;
  ranked: boolean;
  players: (PlayerInfo & { playerKey: string; playerToken?: string })[];
}

type Row = Record<string, unknown>;

/** Leaderboard key shared by every human who played without giving a name (it's what "You" used to get). */
export const UNNAMED_HUMAN_KEY = 'human:you';

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.fillInPromises();
  }

  private migrate(): void {
    const { user_version: version } = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
        this.sql.exec('COMMIT');
      } catch (err) {
        this.sql.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /**
   * A finalist's promise to split is worked out as their game ends. Games that ended before
   * that was counted have none stored, so read them from the saved final chat, once.
   */
  private fillInPromises(): void {
    const finalists = this.sql
      .prepare('SELECT game_id, seat FROM game_players WHERE final_choice IS NOT NULL AND promised_split IS NULL')
      .all() as { game_id: string; seat: number }[];
    if (finalists.length === 0) return;
    const update = this.sql.prepare('UPDATE game_players SET promised_split = ? WHERE game_id = ? AND seat = ?');
    const promised = new Map<string, Map<number, string>>();
    this.sql.exec('BEGIN');
    try {
      for (const { game_id: id, seat } of finalists) {
        if (!promised.has(id)) promised.set(id, splitPromises(this.events(id, ['speech', 'final_reveal'])));
        update.run(promised.get(id)!.has(seat) ? 1 : 0, id, seat);
      }
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  createGame(game: NewGame): void {
    this.sql.exec('BEGIN');
    try {
      this.sql
        .prepare(
          `INSERT INTO games (id, created_at, status, options, has_human, ranked) VALUES (?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          game.id,
          game.createdAt,
          JSON.stringify(game.options),
          game.players.some((p) => p.kind === 'human') ? 1 : 0,
          game.ranked ? 1 : 0,
        );
      const insert = this.sql.prepare(
        `INSERT INTO game_players (game_id, seat, name, kind, model, model_label, player_key, player_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of game.players) {
        insert.run(game.id, p.seat, p.name, p.kind, p.model ?? null, p.modelLabel ?? null, p.playerKey, p.playerToken ?? null);
      }
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  appendEvent(gameId: string, event: GameEvent): void {
    const { seq, ts, vis, type, ...body } = event;
    this.sql
      .prepare('INSERT INTO game_events (game_id, seq, ts, type, vis, body) VALUES (?, ?, ?, ?, ?, ?)')
      .run(gameId, seq, ts, type, JSON.stringify(vis), JSON.stringify(body));
  }

  /** A game's events in order: all of them, or only those of the given types. */
  events(gameId: string, types?: GameEvent['type'][]): GameEvent[] {
    const only = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    const rows = this.sql
      .prepare(`SELECT seq, ts, type, vis, body FROM game_events WHERE game_id = ?${only} ORDER BY seq`)
      .all(gameId, ...(types ?? [])) as { seq: number; ts: number; type: string; vis: string; body: string }[];
    return rows.map(
      (r) => ({ ...JSON.parse(r.body), type: r.type, seq: r.seq, ts: r.ts, vis: JSON.parse(r.vis) }) as GameEvent,
    );
  }

  finishGame(
    gameId: string,
    status: GameStatus,
    result: { jackpot: number | null; stats: PlayerStats[]; error?: string },
  ): void {
    const cost = result.stats.reduce((s, p) => s + p.costUsd, 0);
    this.sql.exec('BEGIN');
    try {
      this.sql
        .prepare('UPDATE games SET status = ?, finished_at = ?, jackpot = ?, cost_usd = ?, error = ? WHERE id = ?')
        .run(status, Date.now(), result.jackpot, cost, result.error ?? null, gameId);
      const update = this.sql.prepare(
        `UPDATE game_players SET eliminated_stage = ?, reached_final = ?, final_choice = ?, final_outcome = ?, promised_split = ?,
           winnings = ?, claims = ?, truthful_claims = ?, votes_received = ?, invalid_responses = ?,
           llm_calls = ?, cost_usd = ?,
           iv_done = ?, iv_claims_true = ?, iv_lied = ?, iv_saw_coming = ?, iv_called_winner = ?,
           iv_planned = ?, iv_stuck = ?, iv_same_again = ?, iv_trust = ?,
           trust_given = ?, trust_given_n = ?, trust_received = ?, trust_received_n = ?
         WHERE game_id = ? AND seat = ?`,
      );
      for (const s of result.stats) {
        const iv = s.interview;
        update.run(
          s.eliminatedStage,
          s.reachedFinal ? 1 : 0,
          s.finalChoice,
          s.finalOutcome,
          bit(s.promisedSplit),
          s.winnings,
          s.claims,
          s.truthfulClaims,
          s.votesReceived,
          s.invalidResponses,
          s.llmCalls,
          s.costUsd,
          iv ? 1 : 0,
          bit(iv?.claimsTrue),
          iv ? bit(iv.lied) : null,
          bit(iv?.sawItComing),
          bit(iv?.calledWinner),
          iv?.planned ?? null,
          bit(iv?.stuckToPlan),
          bit(iv?.sameAgain),
          iv?.trust ?? null,
          s.trustGiven,
          s.trustGivenCount,
          s.trustReceived,
          s.trustReceivedCount,
          gameId,
          s.seat,
        );
      }
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  /** Games left 'running' by a previous process can never finish. */
  abandonRunningGames(): number {
    const res = this.sql
      .prepare(`UPDATE games SET status = 'abandoned', finished_at = ? WHERE status = 'running'`)
      .run(Date.now());
    return Number(res.changes);
  }

  deleteGame(id: string): boolean {
    return Number(this.sql.prepare('DELETE FROM games WHERE id = ?').run(id).changes) > 0;
  }

  seatForToken(gameId: string, token: string): number | undefined {
    if (!token) return undefined;
    const row = this.sql
      .prepare('SELECT seat FROM game_players WHERE game_id = ? AND player_token = ?')
      .get(gameId, token) as { seat: number } | undefined;
    return row?.seat;
  }

  listGames(limit: number, offset: number): GameSummary[] {
    const games = this.sql
      .prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Row[];
    return this.withPlayers(games);
  }

  getGame(id: string): (GameSummary & { options: GameOptions }) | undefined {
    const row = this.sql.prepare('SELECT * FROM games WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const [summary] = this.withPlayers([row]);
    return { ...summary!, options: JSON.parse(row.options as string) as GameOptions };
  }

  private withPlayers(games: Row[]): GameSummary[] {
    if (games.length === 0) return [];
    const ids = games.map((g) => g.id as string);
    const players = this.sql
      .prepare(`SELECT * FROM game_players WHERE game_id IN (${ids.map(() => '?').join(',')}) ORDER BY seat`)
      .all(...ids) as Row[];
    return games.map((g) => ({
      id: g.id as string,
      createdAt: g.created_at as number,
      finishedAt: (g.finished_at as number | null) ?? null,
      status: g.status as GameStatus,
      hasHuman: g.has_human === 1,
      ranked: g.ranked === 1,
      jackpot: (g.jackpot as number | null) ?? null,
      costUsd: g.cost_usd as number,
      players: players.filter((p) => p.game_id === g.id).map(toPlayerSummary),
    }));
  }

  leaderboard(opts: { includeUnranked: boolean; includeHumans: boolean }): LeaderboardResponse {
    const where = [`g.status = 'finished'`];
    if (!opts.includeUnranked) where.push('g.ranked = 1');
    if (!opts.includeHumans) where.push(`gp.kind != 'human'`);
    const filter = where.join(' AND ');

    const rows = this.sql
      .prepare(
        `SELECT gp.player_key AS key, gp.kind AS kind,
           MAX(COALESCE(gp.model_label, gp.name)) AS label,
           COUNT(*) AS games,
           SUM(gp.reached_final) AS finals,
           SUM(gp.winnings) AS total_winnings,
           AVG(gp.winnings) AS avg_winnings,
           MAX(gp.winnings) AS best_win,
           SUM(gp.eliminated_stage = 'r1') AS r1,
           SUM(gp.eliminated_stage = 'r2') AS r2,
           SUM(gp.final_choice = 'split') AS splits,
           SUM(gp.final_choice = 'steal') AS steals,
           SUM(gp.final_outcome = 'shared') AS shared,
           SUM(gp.final_outcome = 'stole') AS stole,
           SUM(gp.final_outcome = 'stolen_from') AS stolen_from,
           SUM(gp.final_outcome = 'mutual_steal') AS mutual,
           SUM(gp.promised_split) AS promises,
           SUM(gp.promised_split = 1 AND gp.final_choice = 'split') AS promises_kept,
           SUM(gp.claims) AS claims,
           SUM(gp.truthful_claims) AS truthful,
           SUM(gp.votes_received) AS votes,
           SUM(gp.invalid_responses) AS invalid,
           SUM(gp.cost_usd) AS cost,
           MAX(g.finished_at) AS last_played,
           SUM(gp.iv_done) AS iv_done,
           SUM(gp.iv_lied = 1 AND gp.iv_claims_true IS NOT NULL) AS iv_lied,
           SUM(gp.iv_lied = 1 AND gp.iv_claims_true = 0) AS iv_owned_up,
           COUNT(gp.iv_saw_coming) AS iv_saw_asked,
           SUM(gp.iv_saw_coming) AS iv_saw_yes,
           COUNT(gp.iv_called_winner) AS iv_picks,
           SUM(gp.iv_called_winner) AS iv_picks_right,
           COUNT(gp.iv_planned) AS iv_plans,
           SUM(gp.iv_planned = 'steal') AS iv_planned_steal,
           COUNT(gp.iv_stuck) AS iv_stuck_asked,
           SUM(gp.iv_stuck) AS iv_stuck_yes,
           COUNT(gp.iv_same_again) AS iv_again_asked,
           SUM(gp.iv_same_again) AS iv_again_yes,
           COUNT(gp.iv_trust) AS iv_trust_n,
           SUM(gp.iv_trust) AS iv_trust_sum,
           SUM(gp.trust_given) AS trust_given,
           SUM(gp.trust_given_n) AS trust_given_n,
           SUM(gp.trust_received) AS trust_received,
           SUM(gp.trust_received_n) AS trust_received_n
         FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE ${filter}
         GROUP BY gp.player_key, gp.kind
         ORDER BY avg_winnings DESC`,
      )
      .all() as Row[];

    const history = this.sql
      .prepare(
        `SELECT g.id AS game_id, g.finished_at, gp.player_key AS key, gp.winnings
         FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE ${filter}
         ORDER BY g.finished_at, g.id, gp.seat
         LIMIT 20000`,
      )
      .all() as Row[];

    const totalGames = this.sql
      .prepare(
        `SELECT COUNT(DISTINCT g.id) AS n FROM games g JOIN game_players gp ON gp.game_id = g.id WHERE ${filter}`,
      )
      .get() as { n: number };

    return {
      rows: rows.map(
        (r): LeaderboardRow => ({
          key: r.key as string,
          label: r.key === UNNAMED_HUMAN_KEY ? 'Unnamed players' : (r.label as string),
          kind: r.kind as PlayerKind,
          games: num(r.games),
          finals: num(r.finals),
          totalWinnings: num(r.total_winnings),
          avgWinnings: num(r.avg_winnings),
          bestWin: num(r.best_win),
          r1Eliminations: num(r.r1),
          r2Eliminations: num(r.r2),
          splits: num(r.splits),
          steals: num(r.steals),
          sharedPots: num(r.shared),
          stoleWins: num(r.stole),
          gotStolenFrom: num(r.stolen_from),
          mutualSteals: num(r.mutual),
          splitPromises: num(r.promises),
          promisesKept: num(r.promises_kept),
          claims: num(r.claims),
          truthfulClaims: num(r.truthful),
          votesReceived: num(r.votes),
          invalidResponses: num(r.invalid),
          costUsd: num(r.cost),
          lastPlayed: num(r.last_played),
          interviews: num(r.iv_done),
          liedInterviews: num(r.iv_lied),
          ownedUp: num(r.iv_owned_up),
          sawItAsked: num(r.iv_saw_asked),
          sawItComing: num(r.iv_saw_yes),
          winnerPicks: num(r.iv_picks),
          winnerRight: num(r.iv_picks_right),
          plansGiven: num(r.iv_plans),
          plannedSteal: num(r.iv_planned_steal),
          planChecks: num(r.iv_stuck_asked),
          stuckToPlan: num(r.iv_stuck_yes),
          againAsked: num(r.iv_again_asked),
          sameAgain: num(r.iv_again_yes),
          trustScores: num(r.iv_trust_n),
          trustTotal: num(r.iv_trust_sum),
          trustGivenScores: num(r.trust_given_n),
          trustGivenTotal: num(r.trust_given),
          trustReceivedScores: num(r.trust_received_n),
          trustReceivedTotal: num(r.trust_received),
        }),
      ),
      history: history.map(
        (h): LeaderboardHistoryPoint => ({
          gameId: h.game_id as string,
          finishedAt: num(h.finished_at),
          key: h.key as string,
          winnings: num(h.winnings),
        }),
      ),
      totalGames: totalGames.n,
    };
  }

  getSetting(name: string): string | undefined {
    const row = this.sql.prepare('SELECT value FROM settings WHERE name = ?').get(name) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(name: string, value: string): void {
    this.sql
      .prepare(
        `INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, Date.now());
  }

  deleteSetting(name: string): void {
    this.sql.prepare('DELETE FROM settings WHERE name = ?').run(name);
  }

  /** Consistent online backup (used by the backup script). */
  backupTo(file: string): void {
    fs.rmSync(file, { force: true });
    this.sql.prepare('VACUUM INTO ?').run(file);
  }

  close(): void {
    this.sql.close();
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

function toPlayerSummary(p: Row): GamePlayerSummary {
  return {
    seat: p.seat as number,
    name: p.name as string,
    kind: p.kind as PlayerKind,
    ...(p.model ? { model: p.model as string } : {}),
    ...(p.model_label ? { modelLabel: p.model_label as string } : {}),
    eliminatedStage: (p.eliminated_stage as Stage | null) ?? null,
    reachedFinal: p.reached_final === 1,
    finalChoice: (p.final_choice as FinalChoice | null) ?? null,
    winnings: p.winnings as number,
    costUsd: p.cost_usd as number,
  };
}
