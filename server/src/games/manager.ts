import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_OPTIONS,
  canSee,
  type CreateGameRequest,
  type CreateGameResponse,
  type GameEvent,
  type GameOptions,
  type GameStatus,
  type LiveStatus,
  type PlayerInfo,
  type SeatSpec,
  type Viewer,
} from '@gb/shared';
import { HumanAgent, type SubmitResult } from '../agents/human.js';
import { LlmAgent } from '../agents/llm.js';
import { MOCK_STRATEGIES, MockAgent } from '../agents/mock.js';
import type { Agent } from '../agents/types.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { GameAbortedError, GameEngine } from '../engine/engine.js';
import { mulberry32, randomSeed, shuffle } from '../engine/rng.js';
import type { OpenRouterClient } from '../llm/openrouter.js';
import type { ModelCatalog } from '../models.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type StreamMessage =
  | { kind: 'event'; event: GameEvent }
  | { kind: 'status'; status: LiveStatus }
  | { kind: 'end'; status: GameStatus };

export interface Subscriber {
  viewer: Viewer;
  send: (msg: StreamMessage) => void;
}

interface RunningGame {
  id: string;
  engine: GameEngine;
  humans: Map<number, HumanAgent>;
  subscribers: Set<Subscriber>;
  abort: AbortController;
  hasHuman: boolean;
  autoplay: boolean;
  lastStatus?: LiveStatus;
  done: Promise<void>;
}

const ANON_NAMES = ['Ava', 'Ben', 'Cleo', 'Dev', 'Ezra', 'Fran', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kofi', 'Lena'];
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export class GameManager {
  private readonly running = new Map<string, RunningGame>();

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly client: OpenRouterClient | null,
    private readonly catalog: ModelCatalog,
    private readonly log: Logger,
  ) {}

  get runningCount(): number {
    return this.running.size;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  hasRunningAutoplay(): boolean {
    return [...this.running.values()].some((g) => g.autoplay);
  }

  createGame(req: CreateGameRequest, opts: { autoplay?: boolean } = {}): CreateGameResponse {
    if (this.running.size >= this.cfg.maxConcurrentGames) {
      throw new HttpError(429, `There are already ${this.running.size} games in progress. Try again shortly.`);
    }
    const seats = this.validateSeats(req.seats);
    const options = this.validateOptions(req.options);
    const rng = mulberry32(options.seed ^ 0x5eed);

    // Random seating, so nobody always speaks first.
    const order = shuffle(seats.map((_, i) => i), rng);
    const seated = order.map((i) => seats[i]!);
    const players = this.namePlayers(seated, options, rng);

    const id = randomUUID();
    const abort = new AbortController();
    const humans = new Map<number, HumanAgent>();
    let playerToken: string | undefined;
    let humanSeat: number | undefined;

    const agents: Agent[] = seated.map((spec, seat) => {
      const agentSeed = (options.seed + seat * 7919) >>> 0;
      if (spec.kind === 'human') {
        const human = new HumanAgent(new MockAgent('mock/honest', agentSeed), this.cfg.humanTimeoutMs);
        humans.set(seat, human);
        playerToken = randomBytes(24).toString('hex');
        humanSeat = seat;
        return human;
      }
      if (spec.kind === 'mock') return new MockAgent(spec.model!, agentSeed, this.cfg.mockDelayMs);
      return new LlmAgent(this.client!, spec.model!, {
        reasoningEffort: options.reasoningEffort,
        maxTokens: this.cfg.llmMaxTokens,
        repairAttempts: 1,
      });
    });

    this.db.createGame({
      id,
      createdAt: Date.now(),
      options,
      ranked: !seated.some((s) => s.kind === 'mock'),
      players: players.map((p) => ({
        ...p,
        playerKey: p.kind === 'human' ? `human:${p.name.toLowerCase()}` : p.model!,
        ...(p.seat === humanSeat ? { playerToken } : {}),
      })),
    });

    const game: RunningGame = {
      id,
      humans,
      subscribers: new Set(),
      abort,
      hasHuman: humans.size > 0,
      autoplay: opts.autoplay ?? false,
      engine: null as unknown as GameEngine,
      done: Promise.resolve(),
    };
    game.engine = new GameEngine({
      players,
      agents,
      options,
      signal: abort.signal,
      emit: (event) => this.onEvent(game, event),
      onStatus: (status) => {
        game.lastStatus = status;
        this.broadcast(game, { kind: 'status', status });
      },
    });
    this.running.set(id, game);
    game.done = this.run(game);
    this.log.info({ gameId: id, players: players.map((p) => p.model ?? p.name) }, 'Game started');

    return { id, ...(playerToken ? { playerToken, seat: humanSeat } : {}) };
  }

  private async run(game: RunningGame): Promise<void> {
    let status: GameStatus = 'finished';
    try {
      const result = await game.engine.run();
      this.db.finishGame(game.id, 'finished', { jackpot: result.jackpot, stats: result.stats });
    } catch (err) {
      const aborted = err instanceof GameAbortedError || game.abort.signal.aborted;
      status = aborted ? 'abandoned' : 'error';
      const message = aborted ? 'The game was stopped.' : err instanceof Error ? err.message : String(err);
      if (!aborted) this.log.error({ err, gameId: game.id }, 'Game crashed');
      try {
        game.engine.fail(message);
      } catch (persistErr) {
        this.log.error({ err: persistErr }, 'Could not record game error');
      }
      this.db.finishGame(game.id, status, { jackpot: null, stats: game.engine.stats, error: message });
    } finally {
      this.broadcast(game, { kind: 'end', status });
      this.running.delete(game.id);
    }
  }

  private onEvent(game: RunningGame, event: GameEvent): void {
    this.db.appendEvent(game.id, event);
    this.broadcast(game, { kind: 'event', event });
  }

  private broadcast(game: RunningGame, msg: StreamMessage): void {
    for (const sub of game.subscribers) {
      if (msg.kind === 'event' && !canSee(msg.event, sub.viewer)) continue;
      try {
        sub.send(msg);
      } catch (err) {
        this.log.warn({ err }, 'Dropping stream subscriber');
        game.subscribers.delete(sub);
      }
    }
  }

  /**
   * Who is looking? While a game with a human is live, nobody gets to see
   * hidden balls or private thoughts (the human could just open another tab).
   * Otherwise, everyone sees everything.
   */
  viewerFor(gameId: string, token: string | undefined): Viewer {
    const seat = token ? this.db.seatForToken(gameId, token) : undefined;
    const live = this.running.get(gameId);
    if (live?.hasHuman) return seat !== undefined ? { seat, omniscient: false } : { omniscient: false };
    return seat !== undefined ? { seat, omniscient: true } : { omniscient: true };
  }

  /** Stream a running game: backlog after `afterSeq`, then live messages. Returns an unsubscribe fn, or null if not running. */
  subscribe(gameId: string, afterSeq: number, sub: Subscriber): (() => void) | null {
    const game = this.running.get(gameId);
    if (!game) return null;
    for (const event of game.engine.events) {
      if (event.seq > afterSeq && canSee(event, sub.viewer)) sub.send({ kind: 'event', event });
    }
    if (game.lastStatus) sub.send({ kind: 'status', status: game.lastStatus });
    game.subscribers.add(sub);
    return () => game.subscribers.delete(sub);
  }

  submitHumanAction(gameId: string, token: string, requestId: string, response: unknown): SubmitResult {
    const game = this.running.get(gameId);
    if (!game) return { ok: false, status: 409, error: 'This game is not running.' };
    const seat = this.db.seatForToken(gameId, token);
    const human = seat !== undefined ? game.humans.get(seat) : undefined;
    if (!human) return { ok: false, status: 400, error: 'You are not playing in this game.' };
    return human.submit(requestId, response);
  }

  abort(gameId: string): boolean {
    const game = this.running.get(gameId);
    if (!game) return false;
    game.abort.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    const games = [...this.running.values()];
    for (const g of games) g.abort.abort();
    await Promise.allSettled(games.map((g) => g.done));
  }

  // ------------------------------------------------------------ validation

  private validateSeats(seats: unknown): SeatSpec[] {
    if (!Array.isArray(seats) || seats.length !== 4) throw new HttpError(400, 'Choose exactly four contestants.');
    const specs = seats.map((raw): SeatSpec => {
      const s = (raw ?? {}) as Partial<SeatSpec>;
      if (s.kind === 'human') return { kind: 'human', name: cleanName(s.name) };
      if (s.kind === 'mock') {
        if (!MOCK_STRATEGIES.some((m) => m.id === s.model)) throw new HttpError(400, `Unknown mock player ${String(s.model)}.`);
        return { kind: 'mock', model: s.model! };
      }
      if (s.kind === 'ai') {
        if (typeof s.model !== 'string' || !MODEL_ID.test(s.model)) {
          throw new HttpError(400, `"${String(s.model)}" is not a valid OpenRouter model id.`);
        }
        if (!this.client) throw new HttpError(400, 'OPENROUTER_API_KEY is not configured on the server.');
        return { kind: 'ai', model: s.model };
      }
      throw new HttpError(400, 'Each seat must be ai, human or mock.');
    });
    if (specs.filter((s) => s.kind === 'human').length > 1) {
      throw new HttpError(400, 'Only one human player per game.');
    }
    return specs;
  }

  private validateOptions(raw: Partial<GameOptions> | undefined): GameOptions {
    const o = raw ?? {};
    const clamp = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === 'number' && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;
    const effort = ['none', 'low', 'medium', 'high'].includes(o.reasoningEffort as string)
      ? (o.reasoningEffort as GameOptions['reasoningEffort'])
      : DEFAULT_OPTIONS.reasoningEffort;
    return {
      discussionPasses: clamp(o.discussionPasses, 0, 3, DEFAULT_OPTIONS.discussionPasses),
      finalDiscussionPasses: clamp(o.finalDiscussionPasses, 1, 4, DEFAULT_OPTIONS.finalDiscussionPasses),
      revealModelNames: typeof o.revealModelNames === 'boolean' ? o.revealModelNames : DEFAULT_OPTIONS.revealModelNames,
      reasoningEffort: effort,
      seed: clamp(o.seed, 0, 2 ** 31 - 1, randomSeed()),
    };
  }

  private namePlayers(seats: SeatSpec[], options: GameOptions, rng: () => number): PlayerInfo[] {
    const taken = new Set<string>();
    const unique = (base: string) => {
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      taken.add(name.toLowerCase());
      return name;
    };
    // Humans pick first so they keep the name they asked for.
    const names: string[] = [];
    seats.forEach((s, i) => {
      if (s.kind === 'human') names[i] = unique(s.name ?? 'You');
    });
    const anon = shuffle(
      ANON_NAMES.filter((n) => !taken.has(n.toLowerCase())),
      rng,
    );
    return seats.map((s, seat): PlayerInfo => {
      if (s.kind === 'human') return { seat, name: names[seat]!, kind: 'human' };
      const label =
        s.kind === 'mock'
          ? MOCK_STRATEGIES.find((m) => m.id === s.model)!.name
          : this.catalog.label(s.model!);
      const shown = options.revealModelNames ? label.replace(/ \(mock\)$/, '') : anon.shift()!;
      return { seat, name: unique(shown), kind: s.kind, model: s.model!, modelLabel: label };
    });
  }
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} '\-]/gu, '').replace(/\s+/g, ' ').trim() : '';
  return name.slice(0, 20) || 'You';
}
