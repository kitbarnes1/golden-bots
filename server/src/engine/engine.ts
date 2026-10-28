import { randomUUID } from 'node:crypto';
import {
  RULES,
  GOLDEN_BANK,
  canSee,
  cashTotal,
  claimIsTruthful,
  formatMoney,
  type ActionRequest,
  type ActionResponse,
  type Ball,
  type ChatEndReason,
  type ClaimValue,
  type FinalChoice,
  type FinalOutcome,
  type GameEvent,
  type GameEventBody,
  type GameOptions,
  type InterviewAnswers,
  type LiveStatus,
  type Payout,
  type PauseReason,
  type PlayerInfo,
  type Stage,
  type Usage,
  type Visibility,
} from '@gb/shared';
import { AgentError, type Agent, type AgentContext, type AgentResult } from '../agents/types.js';
import { Host } from './host.js';
import { mulberry32, pickOne, shuffle, type Rng } from './rng.js';
import { cleanSay, validateResponse } from './validate.js';

export type PlayerOutcome = 'shared' | 'stole' | 'stolen_from' | 'mutual_steal';

export interface PlayerStats {
  seat: number;
  eliminatedStage: Stage | null;
  reachedFinal: boolean;
  finalChoice: FinalChoice | null;
  finalOutcome: PlayerOutcome | null;
  winnings: number;
  claims: number;
  truthfulClaims: number;
  votesReceived: number;
  invalidResponses: number;
  llmCalls: number;
  costUsd: number;
  /** Their exit interview, checked against what happened; null if they weren't interviewed. */
  interview: InterviewStats | null;
}

export interface InterviewStats {
  claimsTrue: boolean | null;
  /** They made at least one false back-row claim (so claimsTrue = false is owning up). */
  lied: boolean;
  sawItComing: boolean | null;
  /** Their pick for the biggest winner was right; null with no pick, or if nobody won anything. */
  calledWinner: boolean | null;
  planned: FinalChoice | 'undecided' | null;
  /** Did what they say they planned at the start; null if undecided or no answer. */
  stuckToPlan: boolean | null;
  sameAgain: boolean | null;
  trust: number | null;
}

export interface GameResult {
  jackpot: number;
  payouts: Payout[];
  stats: PlayerStats[];
}

export interface EngineDeps {
  players: PlayerInfo[];
  agents: Agent[];
  options: GameOptions;
  /** Called synchronously for every event, in order. */
  emit: (event: GameEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  signal?: AbortSignal;
  /** Pause before each vote is read out, for suspense (0 = straight through, as in tests). */
  voteRevealMs?: number;
  /** Something worth a line in the server log that isn't part of the game, such as a skipped interview. */
  warn?: (message: string, detail: Record<string, unknown>) => void;
}

interface SeatState {
  info: PlayerInfo;
  agent: Agent;
  active: boolean;
  front: Ball[];
  back: Ball[];
  claim: ClaimValue[] | null;
  stats: PlayerStats;
}

export class GameAbortedError extends Error {
  constructor() {
    super('Game aborted');
    this.name = 'GameAbortedError';
  }
}

/** A contestant can't play at all (e.g. bad API key), so the game can't continue. */
export class GameFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameFatalError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** How long the floor waits for a human who has just been asked something. */
const HUMAN_REPLY_WAIT_MS = 20_000;
/** Minimum gap between a human's chat messages. */
const HUMAN_MIN_GAP_MS = 1000;
/**
 * An AI message this close to one of its own earlier lines in the same chat
 * counts as a pass. Measured on real chats: repeats scored 0.61 and up, new
 * points 0.44 and below.
 */
const REPEAT_THRESHOLD = 0.55;

/** Does this line say again what the speaker already said in this chat? */
export function isRepeat(before: readonly string[], say: string): boolean {
  return before.some((b) => overlap(b, say) >= REPEAT_THRESHOLD);
}

/** How much two messages share their words (Dice coefficient, 0 to 1). */
export function overlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9£]+/g, ' ').split(' ').filter((w) => w.length > 1));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

interface Floor {
  stage: Stage;
  participants: number[];
  endsAt: number;
  max: number;
  /** The chat after a vote. */
  reflect: boolean;
  messages: number;
  lastSpeaker: number | null;
  /** Who owes a reply to whom: addressee -> asker, oldest first. */
  owed: Map<number, number>;
  /** Speaker of every message so far, in order. */
  history: number[];
  /** seat -> the message number they last spoke at. */
  lastAt: Map<number, number>;
  counts: Map<number, number>;
  /** AIs who said they've nothing to add (cleared whenever someone speaks). */
  passed: Set<number>;
  humansDone: Set<number>;
  lastHumanPost: Map<number, number>;
  /** Everything each player has said in this chat. */
  said: Map<number, string[]>;
  /** Wakes the floor loop when it's waiting on a human. */
  wake: (() => void) | null;
}

export class GameEngine {
  readonly events: GameEvent[] = [];
  private readonly rng: Rng;
  private readonly host: Host;
  private readonly seats: SeatState[];
  private readonly bank: Ball[];
  private readonly signal: AbortSignal;
  private stage: Stage = 'r1';
  private ballSeq = 0;
  private board?: { slots: Ball[]; opened: (Ball | null)[]; won: Ball[]; binned: Ball[]; jackpot: number };
  private jackpot?: number;
  /** Who started Bin or Win; they also speak first in the final. */
  private firstSeat?: number;
  private readonly waiting = new Map<number, ActionRequest['kind']>();
  /** The conversation in progress, if any. */
  private floor?: Floor;
  /** Exit interviews still being answered: someone knocked out is asked while the game goes on. */
  private readonly interviews: Promise<void>[] = [];
  private readonly answers = new Map<number, InterviewAnswers>();
  /** Set once the game has ended (or failed): late interview answers are dropped. */
  private over = false;
  /** Set while a human player is away; moves wait until they're back. */
  private paused: { since: number; seat: number; reason: PauseReason; waiters: (() => void)[] } | null = null;

  constructor(private readonly deps: EngineDeps) {
    if (deps.players.length !== 4 || deps.agents.length !== 4) {
      throw new Error('The game needs exactly four players.');
    }
    this.rng = mulberry32(deps.options.seed);
    this.host = new Host(this.rng);
    this.signal = deps.signal ?? new AbortController().signal;
    this.seats = deps.players.map((info, i) => ({
      info,
      agent: deps.agents[i]!,
      active: true,
      front: [],
      back: [],
      claim: null,
      stats: {
        seat: info.seat,
        eliminatedStage: null,
        reachedFinal: false,
        finalChoice: null,
        finalOutcome: null,
        winnings: 0,
        claims: 0,
        truthfulClaims: 0,
        votesReceived: 0,
        invalidResponses: 0,
        llmCalls: 0,
        costUsd: 0,
        interview: null,
      },
    }));
    this.bank = shuffle(
      GOLDEN_BANK.flatMap(([value, count]) =>
        Array.from({ length: count }, (): Ball => ({ id: this.nextBallId(), kind: 'cash', value })),
      ),
      this.rng,
    );
  }

  async run(): Promise<GameResult> {
    this.push({ type: 'game_started', players: this.deps.players, options: this.deps.options });
    this.say(this.host.welcome(this.seats.map((s) => s.info.name)));

    await this.eliminationRound('r1');
    await this.eliminationRound('r2');
    const jackpot = await this.binOrWin();
    const payouts = await this.splitOrSteal(jackpot);

    await Promise.all(this.interviews);
    this.throwIfAborted();
    this.scoreInterviews();
    this.over = true;
    this.push({ type: 'game_over', payouts, jackpot });
    this.status([]);
    return { jackpot, payouts, stats: this.seats.map((s) => s.stats) };
  }

  /**
   * Hold the game while the human in `seat` is away. A move already being made
   * finishes; nothing new starts, and the chat and move clocks stop.
   */
  pause(seat: number, reason: PauseReason = 'away'): void {
    if (this.paused || this.events.at(-1)?.type === 'game_over') return;
    this.paused = { since: Date.now(), seat, reason, waiters: [] };
    for (const s of this.seats) s.agent.pause?.();
    this.push({ type: 'paused', seat, reason });
    // An open floor waiting on the human re-checks straight away and stops.
    this.floor?.wake?.();
  }

  /** Carry on. With a reason, only a pause for that reason ends (coming back to the page doesn't skip reading). */
  resume(reason?: PauseReason): boolean {
    const p = this.paused;
    if (!p || (reason && p.reason !== reason)) return false;
    this.paused = null;
    const pausedMs = Date.now() - p.since;
    if (this.floor) this.floor.endsAt += pausedMs;
    for (const s of this.seats) s.agent.resume?.();
    this.push({ type: 'resumed', seat: p.seat, pausedMs });
    for (const wake of p.waiters) wake();
    return true;
  }

  /**
   * "Read at my own pace": after an AI says something, wait for the human
   * still in the game to click Continue. The clocks stop meanwhile.
   */
  private async letHumanRead(): Promise<void> {
    if (!this.deps.options.readAtMyPace) return;
    const reader = this.seats.find((s) => s.active && s.agent.interactive);
    if (!reader || this.paused) return;
    this.pause(reader.info.seat, 'reading');
    await this.whilePaused();
  }

  /** A pause for suspense. Waits out any pause for the human player, and ends early if the game is stopped. */
  private async beat(ms: number): Promise<void> {
    // An abort that already happened would never fire the listener below.
    this.throwIfAborted();
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.signal.addEventListener('abort', done, { once: true });
    });
    this.throwIfAborted();
    await this.whilePaused();
  }

  private async whilePaused(): Promise<void> {
    while (this.paused) {
      const p = this.paused;
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        this.signal.addEventListener('abort', onAbort, { once: true });
        p.waiters.push(() => {
          this.signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      this.throwIfAborted();
    }
  }

  /** Record a fatal error in the game log (used when run() throws). */
  fail(message: string): void {
    this.over = true;
    this.status([]);
    this.push({ type: 'game_error', message });
  }

  /** Live per-player stats, e.g. to persist cost for a game that crashed. */
  get stats(): PlayerStats[] {
    return this.seats.map((s) => s.stats);
  }

  // ---------------------------------------------------------------- rounds

  private async eliminationRound(stage: 'r1' | 'r2'): Promise<void> {
    this.stage = stage;
    const active = this.activeSeats();
    let pool: Ball[];
    let frontCount: number;
    let backCount: number;

    if (stage === 'r1') {
      pool = [...this.drawCash(RULES.r1.cash), ...this.killers(RULES.r1.killers)];
      frontCount = RULES.r1.front;
      backCount = RULES.r1.back;
    } else {
      pool = [
        ...active.flatMap((s) => [...this.seats[s]!.front, ...this.seats[s]!.back]),
        ...this.drawCash(RULES.r2.extraCash),
        ...this.killers(RULES.r2.extraKillers),
      ];
      frontCount = RULES.r2.front;
      backCount = RULES.r2.back;
    }
    shuffle(pool, this.rng);

    const perPlayer = frontCount + backCount;
    active.forEach((seat, i) => {
      const balls = pool.slice(i * perPlayer, (i + 1) * perPlayer);
      const s = this.seats[seat]!;
      s.front = balls.slice(0, frontCount);
      s.back = balls.slice(frontCount);
      s.claim = null;
    });

    this.say(stage === 'r1' ? this.host.round1() : this.host.round2());
    this.push({
      type: 'round_started',
      stage,
      dealt: active.map((seat) => ({ seat, front: this.seats[seat]!.front, backCount })),
    });
    for (const seat of active) {
      this.push({ type: 'back_row', stage, seat, back: this.seats[seat]!.back }, { seats: [seat] });
    }

    // Claims: one at a time, so later players hear earlier claims.
    this.say(this.host.askClaims());
    for (const seat of active) {
      const s = this.seats[seat]!;
      const res = await this.ask(seat, { kind: 'claim', stage, backCount });
      if (res.kind !== 'claim') continue;
      s.claim = res.claim;
      s.stats.claims++;
      if (claimIsTruthful(res.claim, s.back)) s.stats.truthfulClaims++;
      this.push({ type: 'claim', stage, seat, claim: res.claim, say: res.say });
      if (!this.isHuman(seat)) await this.letHumanRead();
    }

    // Open floor: a timed free-for-all conversation before the vote.
    if (this.deps.options.chatSeconds > 0) {
      this.say(this.host.openDiscussion(this.deps.options.chatSeconds));
      await this.openFloor(stage, this.rotate(active, stage === 'r1' ? 1 : 2), this.deps.options.chatSeconds);
    }

    // Secret vote.
    this.say(this.host.callVote());
    const votes = await Promise.all(
      active.map(async (seat) => {
        const candidates = active.filter((s) => s !== seat);
        const res = await this.ask(seat, { kind: 'vote', stage, candidates });
        this.push({ type: 'vote_cast', stage, seat });
        return { seat, target: res.kind === 'vote' ? res.target : pickOne(candidates, this.rng) };
      }),
    );
    const tally = new Map<number, number>();
    for (const { target } of votes) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
      this.seats[target]!.stats.votesReceived++;
    }
    const most = Math.max(...tally.values());

    // Read the votes out one at a time with a pause before each, saving a vote for
    // whoever ends up with the most until last, so the result isn't clear until the end.
    const beat = this.deps.voteRevealMs ?? 0;
    const last = votes.findLastIndex((v) => tally.get(v.target) === most);
    const reading = [...votes.filter((_, i) => i !== last), votes[last]!];
    for (const [index, { seat, target }] of reading.entries()) {
      await this.beat(index === reading.length - 1 ? beat * 1.5 : beat);
      this.push({ type: 'vote_revealed', stage, seat, target, index, total: reading.length });
    }
    this.push({ type: 'votes_revealed', stage, votes });
    await this.beat(beat);

    const tied = active.filter((s) => tally.get(s) === most);
    const out = tied.length === 1 ? tied[0]! : await this.tieBreak(stage, tied);
    this.eliminate(stage, out);
    // Asked on the way out while the game carries on; the answers arrive when they're ready.
    void this.interview(out, { kind: 'interview', when: 'eliminated', candidates: this.activeSeats() });

    // The players left talk over the result and the reveal. Whoever just went doesn't
    // join: a knocked-out human can see everyone's secrets now.
    const reflectSeconds = this.deps.options.reflectSeconds;
    const left = this.activeSeats();
    if (reflectSeconds > 0 && left.length >= 2) {
      this.say(this.host.reflect(this.seats[out]!.info.name, reflectSeconds));
      await this.openFloor(stage, left, reflectSeconds, true);
    }
  }

  private async tieBreak(stage: 'r1' | 'r2', tied: number[]): Promise<number> {
    const deciders = this.activeSeats().filter((s) => !tied.includes(s));
    this.push({ type: 'tie', stage, tied, deciders });
    this.say(this.host.tie(this.names(tied), this.names(deciders)));

    if (deciders.length > 0) {
      for (const seat of tied) {
        await this.speak(seat, {
          kind: 'speak',
          stage,
          context: 'tie_plea',
          prompt: `The vote is tied. Persuade ${this.names(deciders).join(' and ')} to keep you in the game.`,
        });
      }
      for (const seat of deciders) {
        await this.speak(seat, {
          kind: 'speak',
          stage,
          context: 'tie_discuss',
          prompt: `You must agree with ${this.names(deciders.filter((d) => d !== seat)).join(' and ')} which of ${this.names(tied).join(' or ')} to eliminate.`,
        });
      }
      const decisions = await Promise.all(
        deciders.map(async (seat) => {
          const res = await this.ask(seat, { kind: 'tie_decide', stage, candidates: tied });
          return { seat, target: res.kind === 'tie_decide' ? res.target : pickOne(tied, this.rng) };
        }),
      );
      const first = decisions[0]!.target;
      const consensus = decisions.every((d) => d.target === first) ? first : null;
      this.push({ type: 'tie_decision', stage, decisions, consensus });
      if (consensus !== null) return consensus;
      this.say(this.host.noConsensus());
    }

    // The machine decides: one Killer among the tie-break balls.
    const mixer = shuffle([...this.drawCash(tied.length - 1), ...this.killers(1)], this.rng);
    const draws = tied.map((seat, i) => ({ seat, ball: mixer[i]! }));
    this.push({ type: 'tie_draw', stage, draws });
    return draws.find((d) => d.ball.kind === 'killer')!.seat;
  }

  private eliminate(stage: 'r1' | 'r2', seat: number): void {
    const s = this.seats[seat]!;
    s.active = false;
    s.stats.eliminatedStage = stage;
    const claim = s.claim ?? [];
    const truthful = claimIsTruthful(claim, s.back);
    this.push({ type: 'eliminated', stage, seat, front: s.front, back: s.back, claim, truthful });
    this.say(this.host.eliminated(s.info.name, s.back, truthful));
    s.front = [];
    s.back = [];

    // As on the show, everyone else turns their back row over too.
    const rows = this.activeSeats().map((other) => {
      const o = this.seats[other]!;
      const said = o.claim ?? [];
      return { seat: other, back: o.back, claim: said, truthful: claimIsTruthful(said, o.back) };
    });
    if (rows.length) {
      this.push({ type: 'back_rows_revealed', stage, rows });
      this.say(this.host.othersRevealed(rows.map((r) => ({ name: this.seats[r.seat]!.info.name, back: r.back, truthful: r.truthful }))));
    }
  }

  private async binOrWin(): Promise<number> {
    this.stage = 'bow';
    const [a, b] = this.activeSeats() as [number, number];
    for (const seat of [a, b]) this.seats[seat]!.stats.reachedFinal = true;

    const carried: Payout[] = [a, b].map((seat) => ({
      seat,
      amount: cashTotal([...this.seats[seat]!.front, ...this.seats[seat]!.back]),
    }));
    const slots = shuffle(
      [
        ...this.seats[a]!.front,
        ...this.seats[a]!.back,
        ...this.seats[b]!.front,
        ...this.seats[b]!.back,
        ...this.killers(RULES.bow.extraKillers),
      ],
      this.rng,
    );
    for (const seat of [a, b]) {
      this.seats[seat]!.front = [];
      this.seats[seat]!.back = [];
    }

    const [ca, cb] = [carried[0]!.amount, carried[1]!.amount];
    const first = ca > cb ? a : cb > ca ? b : pickOne([a, b], this.rng);
    const second = first === a ? b : a;
    this.firstSeat = first;
    this.board = { slots, opened: slots.map(() => null), won: [], binned: [], jackpot: 0 };

    this.push({
      type: 'bin_or_win_started',
      seats: [a, b],
      ballCount: slots.length,
      carried,
      firstSeat: first,
    });
    this.say(
      this.host.binOrWin(this.seats[first]!.info.name, formatMoney(Math.max(ca, cb))),
    );

    // First player bins, the other wins; then they swap roles. Repeat until five are won.
    let binner = first;
    let winner = second;
    while (this.board.won.length < RULES.bow.toWin) {
      await this.pick(binner, 'bin');
      await this.pick(winner, 'win');
      [binner, winner] = [winner, binner];
    }

    const leftoverIndex = this.board.opened.findIndex((b) => b === null);
    const leftover = this.board.slots[leftoverIndex]!;
    this.board.opened[leftoverIndex] = leftover;
    this.push({ type: 'bin_or_win_finished', jackpot: this.board.jackpot, leftoverIndex, leftover });
    this.say(this.host.binOrWinDone(this.board.jackpot));
    return this.board.jackpot;
  }

  private async pick(seat: number, action: 'bin' | 'win'): Promise<void> {
    const board = this.board!;
    const available = board.opened.flatMap((b, i) => (b === null ? [i] : []));
    const res = await this.ask(seat, { kind: 'pick', action, available });
    const index = res.kind === 'pick' ? res.index : pickOne(available, this.rng);
    const ball = board.slots[index]!;
    board.opened[index] = ball;
    if (action === 'bin') {
      board.binned.push(ball);
    } else {
      board.won.push(ball);
      board.jackpot =
        ball.kind === 'killer' ? round2(board.jackpot / RULES.killerDivisor) : board.jackpot + ball.value;
    }
    this.push({
      type: 'ball_picked',
      seat,
      action,
      index,
      ball,
      jackpot: board.jackpot,
      ...(res.kind === 'pick' && res.say ? { say: res.say } : {}),
    });
    if (res.kind === 'pick' && res.say && !this.isHuman(seat)) await this.letHumanRead();
  }

  private async splitOrSteal(jackpot: number): Promise<Payout[]> {
    this.stage = 'final';
    this.jackpot = jackpot;
    const [a, b] = this.activeSeats() as [number, number];
    const order: [number, number] = this.firstSeat === b ? [b, a] : [a, b];

    this.push({ type: 'final_started', jackpot, seats: order });
    this.say(this.host.splitOrSteal(jackpot, this.deps.options.finalChatSeconds));
    await this.openFloor('final', order, this.deps.options.finalChatSeconds);

    this.say(this.host.chooseNow());
    const choices = await Promise.all(
      order.map(async (seat) => {
        const res = await this.ask(seat, { kind: 'final_choice' });
        this.push({ type: 'choice_locked', seat });
        const choice: FinalChoice =
          res.kind === 'final_choice' ? res.choice : pickOne(['split', 'steal'] as const, this.rng);
        return { seat, choice };
      }),
    );

    const [c1, c2] = choices as [{ seat: number; choice: FinalChoice }, { seat: number; choice: FinalChoice }];
    let outcome: FinalOutcome;
    let payouts: Payout[];
    let stealer: string | undefined;
    if (c1.choice === 'split' && c2.choice === 'split') {
      outcome = 'both_split';
      payouts = [
        { seat: c1.seat, amount: round2(jackpot / 2) },
        { seat: c2.seat, amount: round2(jackpot / 2) },
      ];
    } else if (c1.choice === 'steal' && c2.choice === 'steal') {
      outcome = 'both_steal';
      payouts = [
        { seat: c1.seat, amount: 0 },
        { seat: c2.seat, amount: 0 },
      ];
    } else {
      outcome = 'one_steal';
      const thief = c1.choice === 'steal' ? c1 : c2;
      stealer = this.seats[thief.seat]!.info.name;
      payouts = choices.map((c) => ({ seat: c.seat, amount: c.seat === thief.seat ? jackpot : 0 }));
    }

    for (const c of choices) {
      const stats = this.seats[c.seat]!.stats;
      stats.finalChoice = c.choice;
      stats.winnings = payouts.find((p) => p.seat === c.seat)!.amount;
      stats.finalOutcome =
        outcome === 'both_split'
          ? 'shared'
          : outcome === 'both_steal'
            ? 'mutual_steal'
            : c.choice === 'steal'
              ? 'stole'
              : 'stolen_from';
    }

    this.push({ type: 'final_reveal', choices, outcome, payouts });
    this.say(this.host.reveal(outcome, jackpot, [this.seats[order[0]]!.info.name, this.seats[order[1]]!.info.name], stealer));

    // Last words now the balls are open. Whoever was stolen from gets in first.
    const first = outcome === 'one_steal' ? choices.find((c) => c.choice === 'split')!.seat : order[0];
    for (const seat of [first, order.find((s) => s !== first)!]) {
      const mine = choices.find((c) => c.seat === seat)!.choice;
      const other = choices.find((c) => c.seat !== seat)!;
      const otherName = this.seats[other.seat]!.info.name;
      const won = payouts.find((p) => p.seat === seat)!.amount;
      await this.speak(seat, {
        kind: 'speak',
        stage: 'final',
        context: 'final_reaction',
        prompt: `The balls are open. You chose ${mine.toUpperCase()} and ${otherName} chose ${other.choice.toUpperCase()}, so you leave with ${formatMoney(won)}. Give your honest reaction to ${otherName} and the audience in a sentence or two: how do you really feel?`,
      });
    }
    await Promise.all(
      order.map((seat) => this.interview(seat, { kind: 'interview', when: 'final', candidates: [], opponent: order.find((s) => s !== seat)! })),
    );
    return payouts;
  }

  // ------------------------------------------------------------ open floor

  /**
   * A timed conversation. One AI speaks at a time, so everyone hears everything:
   * whoever was just spoken to replies first, otherwise whoever has been quiet
   * longest. Humans can post whenever they like. Ends when time runs out, the
   * message cap is reached, or everyone has nothing more to say.
   */
  private async openFloor(stage: Stage, participants: number[], seconds: number, reflect = false): Promise<void> {
    const durationMs = Math.round(seconds * 1000);
    if (durationMs <= 0 || participants.length < 2) return;
    const cap = Math.max(1, this.deps.options.chatMaxMessages);
    const floor: Floor = {
      stage,
      participants,
      endsAt: Date.now() + durationMs,
      // The chat after a vote is a quick reaction, so it gets half the messages.
      max: reflect ? Math.max(2, Math.ceil(cap / 2)) : cap,
      reflect,
      messages: 0,
      lastSpeaker: null,
      owed: new Map(),
      history: [],
      lastAt: new Map(),
      counts: new Map(),
      passed: new Set(),
      humansDone: new Set(),
      lastHumanPost: new Map(),
      said: new Map(),
      wake: null,
    };
    this.floor = floor;
    this.push({
      type: 'chat_started',
      stage,
      participants,
      durationMs,
      endsAt: floor.endsAt,
      maxMessages: floor.max,
      ...(reflect ? { reflect: true } : {}),
    });

    let reason: ChatEndReason = 'time';
    try {
      for (;;) {
        this.throwIfAborted();
        await this.whilePaused();
        const left = floor.endsAt - Date.now();
        if (left <= 0) break;
        // Once the AIs have used up the message cap, a human still gets their say
        // (and answers to their questions) until time runs out.
        const capped = floor.messages >= floor.max;
        const humansTalking = participants.some((s) => this.isHuman(s) && !floor.humansDone.has(s));
        if (capped && !humansTalking) {
          reason = 'limit';
          break;
        }
        // A human was asked something: give them a moment to answer.
        const askedHuman = [...floor.owed.keys()].find((s) => this.isHuman(s) && !floor.humansDone.has(s));
        if (askedHuman !== undefined) {
          const answered = await this.waitForHuman(floor, Math.min(left, HUMAN_REPLY_WAIT_MS));
          if (!answered) floor.owed.delete(askedHuman);
          continue;
        }
        const next = this.nextChatSpeaker(floor, capped);
        if (next === undefined) {
          if (!humansTalking) {
            reason = capped ? 'limit' : 'quiet';
            break;
          }
          await this.waitForHuman(floor, left);
          continue;
        }
        const askedBy = floor.owed.get(next);
        const res = await this.ask(next, {
          kind: 'chat',
          stage,
          secondsLeft: Math.max(1, Math.ceil(left / 1000)),
          participants,
          ...(askedBy !== undefined ? { replyTo: askedBy } : {}),
          ...(reflect ? { reflect: true } : {}),
        });
        const say = res.kind === 'chat' ? res.say : null;
        // Saying the same thing again adds nothing, so it counts as a pass and the chat can wind up.
        // Except when a human asked: they get their answer, even if it's one the AI has given before.
        const answeringHuman = askedBy !== undefined && this.isHuman(askedBy);
        const repeat = say !== null && !answeringHuman && isRepeat(floor.said.get(next) ?? [], say);
        if (res.kind === 'chat' && say && !repeat) {
          this.recordChat(floor, next, say, res.to);
          await this.letHumanRead();
        } else {
          floor.passed.add(next);
          floor.owed.delete(next);
          this.push({ type: 'chat_pass', stage, seat: next });
        }
      }
    } finally {
      floor.wake?.();
      this.floor = undefined;
    }
    this.push({ type: 'chat_ended', stage, reason });
  }

  /** Who talks next. */
  private nextChatSpeaker(floor: Floor, capped: boolean): number | undefined {
    const canSpeak = (s: number) => !this.isHuman(s) && s !== floor.lastSpeaker && !floor.passed.has(s);
    const quietest = (seats: number[]) =>
      [...seats].sort((a, b) => (floor.lastAt.get(a) ?? -1) - (floor.lastAt.get(b) ?? -1))[0];

    // 1. A human's question always gets an answer (even past the message cap).
    for (const [addressee, asker] of floor.owed) {
      if (canSpeak(addressee) && this.isHuman(asker)) return addressee;
    }
    if (capped) return undefined;

    // Nobody gets more than their fair share of the conversation.
    const fairShare = Math.ceil(floor.max / floor.participants.length) + 1;
    const eligible = floor.participants.filter((s) => canSpeak(s) && (floor.counts.get(s) ?? 0) < fairShare);

    // 2. After a three-message back-and-forth between two players, someone else cuts in.
    const [a, b, c] = floor.history.slice(-3);
    if (a !== undefined && a === c && a !== b) {
      const outsiders = eligible.filter((s) => s !== a && s !== b);
      if (outsiders.length) return quietest(outsiders);
    }
    // 3. Replies owed between AIs, oldest question first.
    for (const addressee of floor.owed.keys()) {
      if (eligible.includes(addressee)) return addressee;
    }
    // 4. Whoever has been quiet longest.
    return quietest(eligible);
  }

  private recordChat(floor: Floor, seat: number, say: string, to: number | null): void {
    const target = to !== null && to !== seat && floor.participants.includes(to) ? to : null;
    floor.messages++;
    floor.history.push(seat);
    floor.said.set(seat, [...(floor.said.get(seat) ?? []), say]);
    floor.lastSpeaker = seat;
    floor.owed.delete(seat);
    if (target !== null) floor.owed.set(target, seat);
    floor.lastAt.set(seat, floor.messages);
    floor.counts.set(seat, (floor.counts.get(seat) ?? 0) + 1);
    // Something new was said, so everyone may want to respond again.
    floor.passed.clear();
    this.push({ type: 'speech', stage: floor.stage, seat, say, ...(target !== null ? { to: target } : {}) });
    floor.wake?.();
  }

  /** Resolves true as soon as a human posts or says they're done; false on timeout. */
  private waitForHuman(floor: Floor, ms: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        floor.wake = null;
        resolve(value);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      this.signal.addEventListener('abort', onAbort);
      floor.wake = () => finish(true);
    });
  }

  /** A human contestant posts into the open floor (any time while it's open). */
  postChat(seat: number, text: string, to: number | null): { ok: true } | { ok: false; error: string } {
    const floor = this.floor;
    // While paused the floor's clock is stopped, so it can't have run out.
    if (!floor || (!this.paused && Date.now() >= floor.endsAt)) return { ok: false, error: 'The floor is closed.' };
    if (!floor.participants.includes(seat) || !this.isHuman(seat)) {
      return { ok: false, error: "You're not part of this conversation." };
    }
    const say = cleanSay(text);
    if (!say) return { ok: false, error: 'Say something first.' };
    const last = floor.lastHumanPost.get(seat) ?? 0;
    if (Date.now() - last < HUMAN_MIN_GAP_MS) return { ok: false, error: 'Slow down a little.' };
    floor.lastHumanPost.set(seat, Date.now());
    floor.humansDone.delete(seat);
    this.recordChat(floor, seat, say, to);
    // Replying counts as having read what came before.
    this.resume('reading');
    return { ok: true };
  }

  /** A human has nothing more to say; the floor can close once the AIs are done too. */
  doneTalking(seat: number): { ok: true } | { ok: false; error: string } {
    const floor = this.floor;
    if (!floor || !floor.participants.includes(seat)) return { ok: false, error: 'The floor is closed.' };
    floor.humansDone.add(seat);
    floor.wake?.();
    // Saying you're done counts as having read what came before.
    this.resume('reading');
    return { ok: true };
  }

  private isHuman(seat: number): boolean {
    return this.seats[seat]?.agent.interactive === true;
  }

  // ----------------------------------------------------------- agent calls

  private async speak(seat: number, request: Extract<ActionRequest, { kind: 'speak' }>): Promise<void> {
    const res = await this.ask(seat, request);
    if (res.kind === 'speak' && res.say) {
      this.push({ type: 'speech', stage: request.stage, seat, say: res.say });
      if (!this.isHuman(seat)) await this.letHumanRead();
    }
  }

  /**
   * Ask a contestant to act. Never throws for agent problems: invalid or
   * failed answers are logged and replaced with a fallback move.
   */
  private async ask(seat: number, request: ActionRequest): Promise<ActionResponse> {
    this.throwIfAborted();
    await this.whilePaused();
    const s = this.seats[seat]!;
    const requestId = randomUUID();
    this.waiting.set(seat, request.kind);
    this.status();

    if (s.agent.interactive) {
      this.push({ type: 'awaiting_input', seat, requestId, request }, { seats: [seat] });
    }

    try {
      const result = await s.agent.act(request, this.contextFor(seat), { requestId, signal: this.signal });
      this.throwIfAborted();
      this.recordUsage(s, result.usage);
      this.pushThoughts(seat, request.kind, result);
      if (s.agent.interactive) this.push({ type: 'input_received', seat, requestId }, { seats: [seat] });
      if (result.timedOut) {
        this.push({ type: 'agent_error', seat, action: request.kind, message: 'Ran out of time, so autopilot answered.' });
      }
      const valid = validateResponse(request, result.response);
      if (!valid.ok) throw new AgentError(valid.error);
      return valid.value;
    } catch (err) {
      if (this.signal.aborted) throw new GameAbortedError();
      if (err instanceof AgentError) {
        this.recordUsage(s, err.usage);
        if (err.fatal) throw new GameFatalError(`${s.info.name}: ${err.message}`);
      }
      s.stats.invalidResponses++;
      const message = err instanceof Error ? err.message : String(err);
      this.push({ type: 'agent_error', seat, action: request.kind, message: message.slice(0, 300) });
      return this.fallback(seat, request);
    } finally {
      this.waiting.delete(seat);
      this.status();
    }
  }

  /** What a contestant was thinking when they answered: private to them (and anyone watching once it's safe). */
  private pushThoughts(seat: number, action: ActionRequest['kind'], result: AgentResult): void {
    if (!result.thoughts && !result.reasoning) return;
    this.push(
      {
        type: 'thoughts',
        stage: this.stage,
        seat,
        action,
        ...(result.thoughts ? { thoughts: result.thoughts } : {}),
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      },
      { seats: [seat] },
    );
  }

  private recordUsage(s: SeatState, usage: Usage | undefined): void {
    if (!usage) return;
    s.stats.llmCalls++;
    s.stats.costUsd += usage.costUsd;
  }

  /** A neutral move for a contestant who failed to answer. */
  private fallback(seat: number, request: ActionRequest): ActionResponse {
    switch (request.kind) {
      case 'claim': {
        const back = this.seats[seat]!.back;
        return {
          kind: 'claim',
          claim: back.map((b) => (b.kind === 'killer' ? 'killer' : b.value)),
          say: '',
        };
      }
      case 'speak':
        return { kind: 'speak', say: '' };
      case 'chat':
        return { kind: 'chat', say: null, to: null };
      case 'vote':
      case 'tie_decide':
        return { kind: request.kind, target: pickOne(request.candidates, this.rng) };
      case 'pick':
        return { kind: 'pick', index: pickOne(request.available, this.rng) };
      case 'final_choice':
        return { kind: 'final_choice', choice: pickOne(['split', 'steal'] as const, this.rng) };
      case 'interview':
        return { kind: 'interview', answers: { say: '', claimsTrue: null } };
    }
  }

  /**
   * The host's exit interview. An aside, not a move: humans aren't asked, the
   * answers stay out of the other contestants' view, and a failed one is just
   * skipped (no fumble), though its cost still counts.
   */
  private interview(seat: number, request: Extract<ActionRequest, { kind: 'interview' }>): Promise<void> {
    const s = this.seats[seat]!;
    if (s.agent.interactive) return Promise.resolve();
    const done = (async () => {
      try {
        const result = await s.agent.act(request, this.contextFor(seat), { requestId: randomUUID(), signal: this.signal });
        this.recordUsage(s, result.usage);
        const valid = validateResponse(request, result.response);
        if (this.over || this.signal.aborted) return;
        if (!valid.ok || valid.value.kind !== 'interview') {
          this.deps.warn?.('Interview skipped: unusable answer', { seat, when: request.when, error: valid.ok ? 'wrong kind' : valid.error });
          return;
        }
        this.answers.set(seat, valid.value.answers);
        // Kept right before the answers, so the thinking pairs with them (and shows whether they meant it).
        this.pushThoughts(seat, 'interview', result);
        this.push({ type: 'interview', seat, when: request.when, answers: valid.value.answers });
      } catch (err) {
        if (err instanceof AgentError) this.recordUsage(s, err.usage);
        if (!this.signal.aborted) this.deps.warn?.('Interview skipped: the model failed', { seat, when: request.when, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    this.interviews.push(done);
    return done;
  }

  /** Check what each contestant said in their interview against what actually happened. */
  private scoreInterviews(): void {
    const top = Math.max(...this.seats.map((s) => s.stats.winnings));
    for (const [seat, a] of this.answers) {
      const stats = this.seats[seat]!.stats;
      const plan = a.planned === 'split' || a.planned === 'steal' ? a.planned : null;
      stats.interview = {
        claimsTrue: a.claimsTrue,
        lied: stats.truthfulClaims < stats.claims,
        sawItComing: a.sawItComing ?? null,
        calledWinner: a.winnerPick === undefined || a.winnerPick === null || top <= 0 ? null : this.seats[a.winnerPick]!.stats.winnings === top,
        planned: a.planned ?? null,
        stuckToPlan: plan && stats.finalChoice ? plan === stats.finalChoice : null,
        sameAgain: a.sameAgain ?? null,
        trust: a.trust ?? null,
      };
    }
  }

  private contextFor(seat: number): AgentContext {
    const s = this.seats[seat]!;
    const active = this.activeSeats();
    const inElimination = this.stage === 'r1' || this.stage === 'r2';
    return {
      seat,
      players: this.deps.players,
      activeSeats: active,
      stage: this.stage,
      options: this.deps.options,
      myFront: inElimination ? [...s.front] : [],
      myBack: inElimination ? [...s.back] : [],
      fronts: inElimination
        ? Object.fromEntries(active.map((a) => [a, [...this.seats[a]!.front]]))
        : {},
      claims: inElimination
        ? Object.fromEntries(
            active.flatMap((a) => {
              const c = this.seats[a]!.claim;
              return c ? [[a, [...c]]] : [];
            }),
          )
        : {},
      ...(this.board
        ? {
            board: {
              slots: [...this.board.opened],
              jackpot: this.board.jackpot,
              won: [...this.board.won],
              binned: [...this.board.binned],
            },
          }
        : {}),
      ...(this.jackpot !== undefined ? { jackpot: this.jackpot } : {}),
      events: this.events.filter((e) => canSee(e, { seat, omniscient: false })),
    };
  }

  // --------------------------------------------------------------- helpers

  private push(body: GameEventBody, vis: Visibility = 'public'): void {
    const event = { ...body, seq: this.events.length, ts: Date.now(), vis } as GameEvent;
    this.events.push(event);
    this.deps.emit(event);
  }

  private say(text: string): void {
    this.push({ type: 'host', text });
  }

  private status(waitingOn?: number[]): void {
    const seats = waitingOn ?? [...this.waiting.keys()];
    const action = seats.length ? (this.waiting.get(seats[0]!) ?? null) : null;
    this.deps.onStatus?.({ type: 'status', waitingOn: seats, action });
  }

  private activeSeats(): number[] {
    return this.seats.filter((s) => s.active).map((s) => s.info.seat);
  }

  /** Rotate speaking order so the same player doesn't always go first. */
  private rotate(seats: number[], by: number): number[] {
    const k = by % seats.length;
    return [...seats.slice(k), ...seats.slice(0, k)];
  }

  private names(seats: number[]): string[] {
    return seats.map((s) => this.seats[s]!.info.name);
  }

  private drawCash(n: number): Ball[] {
    if (this.bank.length < n) throw new Error('The bank is empty');
    return this.bank.splice(0, n);
  }

  private killers(n: number): Ball[] {
    return Array.from({ length: n }, (): Ball => ({ id: this.nextBallId(), kind: 'killer' }));
  }

  private nextBallId(): string {
    return `b${++this.ballSeq}`;
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) throw new GameAbortedError();
  }
}
