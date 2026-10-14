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
  type ClaimValue,
  type FinalChoice,
  type FinalOutcome,
  type GameEvent,
  type GameEventBody,
  type GameOptions,
  type LiveStatus,
  type Payout,
  type PlayerInfo,
  type Stage,
  type Usage,
  type Visibility,
} from '@gb/shared';
import { AgentError, type Agent, type AgentContext } from '../agents/types.js';
import { Host } from './host.js';
import { mulberry32, pickOne, shuffle, type Rng } from './rng.js';
import { validateResponse } from './validate.js';

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

const round2 = (n: number) => Math.round(n * 100) / 100;

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

  constructor(private readonly deps: EngineDeps) {
    if (deps.players.length !== 4 || deps.agents.length !== 4) {
      throw new Error('Golden Balls needs exactly four players.');
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

    this.push({ type: 'game_over', payouts, jackpot });
    this.status([]);
    return { jackpot, payouts, stats: this.seats.map((s) => s.stats) };
  }

  /** Record a fatal error in the game log (used when run() throws). */
  fail(message: string): void {
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
    }

    // Open discussion.
    if (this.deps.options.discussionPasses > 0) this.say(this.host.openDiscussion());
    for (let pass = 0; pass < this.deps.options.discussionPasses; pass++) {
      for (const seat of this.rotate(active, pass + 1)) {
        await this.speak(seat, {
          kind: 'speak',
          stage,
          context: 'discussion',
          prompt:
            pass === 0
              ? 'Open discussion before the vote. React to the claims you have heard.'
              : 'The discussion continues. This is your last chance to speak before the vote.',
        });
      }
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
    this.push({ type: 'votes_revealed', stage, votes });

    const tally = new Map<number, number>();
    for (const { target } of votes) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
      this.seats[target]!.stats.votesReceived++;
    }
    const most = Math.max(...tally.values());
    const tied = active.filter((s) => tally.get(s) === most);
    const out = tied.length === 1 ? tied[0]! : await this.tieBreak(stage, tied);
    this.eliminate(stage, out);
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
  }

  private async splitOrSteal(jackpot: number): Promise<Payout[]> {
    this.stage = 'final';
    this.jackpot = jackpot;
    const [a, b] = this.activeSeats() as [number, number];
    const order: [number, number] = this.firstSeat === b ? [b, a] : [a, b];

    this.push({ type: 'final_started', jackpot, seats: order });
    this.say(this.host.splitOrSteal(jackpot));

    for (let pass = 0; pass < this.deps.options.finalDiscussionPasses; pass++) {
      for (const seat of order) {
        const other = this.seats[order[0] === seat ? order[1] : order[0]]!.info.name;
        await this.speak(seat, {
          kind: 'speak',
          stage: 'final',
          context: 'final',
          prompt:
            pass === this.deps.options.finalDiscussionPasses - 1
              ? `Last words to ${other} before you both choose.`
              : `Talk to ${other} about the ${formatMoney(jackpot)} jackpot before you both choose SPLIT or STEAL.`,
        });
      }
    }

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
    return payouts;
  }

  // ----------------------------------------------------------- agent calls

  private async speak(seat: number, request: Extract<ActionRequest, { kind: 'speak' }>): Promise<void> {
    const res = await this.ask(seat, request);
    if (res.kind === 'speak' && res.say) {
      this.push({ type: 'speech', stage: request.stage, seat, say: res.say });
    }
  }

  /**
   * Ask a contestant to act. Never throws for agent problems: invalid or
   * failed answers are logged and replaced with a fallback move.
   */
  private async ask(seat: number, request: ActionRequest): Promise<ActionResponse> {
    this.throwIfAborted();
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
      if (result.thoughts || result.reasoning) {
        this.push(
          {
            type: 'thoughts',
            stage: this.stage,
            seat,
            action: request.kind,
            ...(result.thoughts ? { thoughts: result.thoughts } : {}),
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
          },
          { seats: [seat] },
        );
      }
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
      case 'vote':
      case 'tie_decide':
        return { kind: request.kind, target: pickOne(request.candidates, this.rng) };
      case 'pick':
        return { kind: 'pick', index: pickOne(request.available, this.rng) };
      case 'final_choice':
        return { kind: 'final_choice', choice: pickOne(['split', 'steal'] as const, this.rng) };
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
    if (this.bank.length < n) throw new Error('The Golden Bank is empty');
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
