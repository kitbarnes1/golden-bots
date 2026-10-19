import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  canSee,
  cashTotal,
  type ActionRequest,
  type GameEvent,
  type GameOptions,
  type PlayerInfo,
} from '@gb/shared';
import { GameEngine, GameFatalError } from '../src/engine/engine.js';
import { MockAgent } from '../src/agents/mock.js';
import { AgentError, type Agent, type AgentContext, type AgentResult } from '../src/agents/types.js';

const players: PlayerInfo[] = ['Ava', 'Ben', 'Cleo', 'Dev'].map((name, seat) => ({ seat, name, kind: 'mock' }));

function options(seed: number, extra: Partial<GameOptions> = {}): GameOptions {
  return { ...DEFAULT_OPTIONS, seed, ...extra };
}

type Script = (request: ActionRequest, ctx: AgentContext) => unknown;

/** Delegates to a mock but lets a test override specific decisions. */
class ScriptedAgent implements Agent {
  private readonly base: MockAgent;
  constructor(
    seed: number,
    private readonly script: Script = () => undefined,
  ) {
    this.base = new MockAgent('mock/chaos', seed);
  }
  async act(request: ActionRequest, ctx: AgentContext, meta: { requestId: string; signal: AbortSignal }): Promise<AgentResult> {
    const scripted = this.script(request, ctx);
    if (scripted !== undefined) return { response: scripted };
    return this.base.act(request, ctx, meta);
  }
}

async function play(seed: number, scripts: Script[] = [], extra: Partial<GameOptions> = {}) {
  const events: GameEvent[] = [];
  const engine = new GameEngine({
    players,
    agents: players.map((p) => new ScriptedAgent(seed + p.seat, scripts[p.seat])),
    options: options(seed, extra),
    emit: (e) => events.push(e),
  });
  const result = await engine.run();
  return { result, events, engine };
}

const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('GameEngine', () => {
  it('plays a complete game with the right ball counts', async () => {
    const { result, events } = await play(42);

    const rounds = ofType(events, 'round_started');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.dealt).toHaveLength(4);
    expect(rounds[0]!.dealt.every((d) => d.front.length === 2 && d.backCount === 2)).toBe(true);
    expect(rounds[1]!.dealt).toHaveLength(3);
    expect(rounds[1]!.dealt.every((d) => d.front.length === 2 && d.backCount === 3)).toBe(true);

    const r1Balls = [
      ...rounds[0]!.dealt.flatMap((d) => d.front),
      ...ofType(events, 'back_row').filter((e) => e.stage === 'r1').flatMap((e) => e.back),
    ];
    expect(r1Balls).toHaveLength(16);
    expect(r1Balls.filter((b) => b.kind === 'killer')).toHaveLength(4);
    expect(new Set(r1Balls.map((b) => b.id)).size).toBe(16);

    const eliminated = ofType(events, 'eliminated');
    expect(eliminated.map((e) => e.stage)).toEqual(['r1', 'r2']);

    // Round 2 = survivors' round 1 balls + 2 cash + 1 killer.
    const r1Survivors = new Set(eliminated[0]!.front.concat(eliminated[0]!.back).map((b) => b.id));
    const carriedOver = r1Balls.filter((b) => !r1Survivors.has(b.id));
    const r2Balls = [
      ...rounds[1]!.dealt.flatMap((d) => d.front),
      ...ofType(events, 'back_row').filter((e) => e.stage === 'r2').flatMap((e) => e.back),
    ];
    expect(r2Balls).toHaveLength(15);
    expect(carriedOver.every((b) => r2Balls.some((x) => x.id === b.id))).toBe(true);
    expect(r2Balls.filter((b) => b.kind === 'killer')).toHaveLength(
      carriedOver.filter((b) => b.kind === 'killer').length + 1,
    );

    const picks = ofType(events, 'ball_picked');
    expect(picks).toHaveLength(10);
    expect(picks.filter((p) => p.action === 'win')).toHaveLength(5);
    expect(ofType(events, 'game_over')[0]!.jackpot).toBe(result.jackpot);
    expect(result.stats.filter((s) => s.reachedFinal)).toHaveLength(2);
  });

  it('builds the jackpot from won balls, with killers dividing the running total by 10', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { events, result } = await play(seed);
      let jackpot = 0;
      for (const p of ofType(events, 'ball_picked')) {
        if (p.action !== 'win') continue;
        jackpot = p.ball.kind === 'killer' ? Math.round((jackpot / 10) * 100) / 100 : jackpot + p.ball.value;
        expect(p.jackpot).toBe(jackpot);
      }
      expect(result.jackpot).toBe(jackpot);
    }
  });

  it('runs Bin or Win in the right order: richest finalist bins first, then roles alternate', async () => {
    const { events } = await play(7);
    const start = ofType(events, 'bin_or_win_started')[0]!;
    const [a, b] = start.carried;
    if (a!.amount !== b!.amount) {
      expect(start.firstSeat).toBe(a!.amount > b!.amount ? a!.seat : b!.seat);
    }
    const first = start.firstSeat;
    const second = start.seats.find((s) => s !== first)!;
    const picks = ofType(events, 'ball_picked').map((p) => [p.seat, p.action]);
    expect(picks.slice(0, 4)).toEqual([
      [first, 'bin'],
      [second, 'win'],
      [second, 'bin'],
      [first, 'win'],
    ]);
    const bow = ofType(events, 'bin_or_win_started')[0]!;
    const finalBalls = ofType(events, 'ball_picked').map((p) => p.ball);
    finalBalls.push(ofType(events, 'bin_or_win_finished')[0]!.leftover);
    expect(finalBalls).toHaveLength(bow.ballCount);
    expect(bow.ballCount).toBe(11);
  });

  it('pays out correctly for every split/steal combination', async () => {
    const combos = [
      ['split', 'split'],
      ['split', 'steal'],
      ['steal', 'split'],
      ['steal', 'steal'],
    ] as const;
    for (const [x, y] of combos) {
      // Everyone always votes for the highest seat available, so seats 0 and 1 reach the final.
      const voteHigh: Script = (req) =>
        req.kind === 'vote' ? { target: Math.max(...req.candidates) } : undefined;
      const scripts: Script[] = [
        (req, ctx) => (req.kind === 'final_choice' ? { choice: x } : voteHigh(req, ctx)),
        (req, ctx) => (req.kind === 'final_choice' ? { choice: y } : voteHigh(req, ctx)),
        voteHigh,
        voteHigh,
      ];
      const { result, events } = await play(99, scripts);
      const reveal = ofType(events, 'final_reveal')[0]!;
      const jackpot = result.jackpot;
      const won = (seat: number) => result.payouts.find((p) => p.seat === seat)!.amount;
      expect(reveal.choices.map((c) => c.seat).sort()).toEqual([0, 1]);
      if (x === 'split' && y === 'split') {
        expect(reveal.outcome).toBe('both_split');
        expect(won(0)).toBeCloseTo(jackpot / 2, 2);
        expect(won(1)).toBeCloseTo(jackpot / 2, 2);
      } else if (x === 'steal' && y === 'steal') {
        expect(reveal.outcome).toBe('both_steal');
        expect(won(0) + won(1)).toBe(0);
      } else {
        expect(reveal.outcome).toBe('one_steal');
        expect(won(x === 'steal' ? 0 : 1)).toBe(jackpot);
        expect(won(x === 'steal' ? 1 : 0)).toBe(0);
      }
      const stats = result.stats;
      expect(stats[0]!.finalChoice).toBe(x);
      expect(stats[1]!.finalChoice).toBe(y);
    }
  });

  it('settles a 2-2 tie by consensus of the untied players', async () => {
    // Seats 0 & 1 vote for 2; seats 2 & 3 vote for 0 -> tie between 0 and 2. Deciders 1 & 3 both pick 2.
    const scripts: Script[] = [
      (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: 2 } : undefined),
      (req) =>
        req.kind === 'vote' && req.stage === 'r1'
          ? { target: 2 }
          : req.kind === 'tie_decide'
            ? { target: 2 }
            : undefined,
      (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: 0 } : undefined),
      (req) =>
        req.kind === 'vote' && req.stage === 'r1'
          ? { target: 0 }
          : req.kind === 'tie_decide'
            ? { target: 2 }
            : undefined,
    ];
    const { events } = await play(5, scripts);
    const tie = ofType(events, 'tie').find((t) => t.stage === 'r1')!;
    expect(tie.tied.sort()).toEqual([0, 2]);
    expect(tie.deciders.sort()).toEqual([1, 3]);
    expect(ofType(events, 'tie_decision')[0]!.consensus).toBe(2);
    expect(ofType(events, 'eliminated')[0]!.seat).toBe(2);
    // Tied players get to plead their case.
    const pleas = ofType(events, 'speech').filter((s) => s.stage === 'r1');
    expect(pleas.length).toBeGreaterThan(0);
  });

  it('falls back to the machine when deciders disagree, and when everyone is tied', async () => {
    // 2-2 tie between 0 and 2, deciders disagree.
    const disagree: Script[] = [
      (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: 2 } : undefined),
      (req) =>
        req.kind === 'vote' && req.stage === 'r1' ? { target: 2 } : req.kind === 'tie_decide' ? { target: 0 } : undefined,
      (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: 0 } : undefined),
      (req) =>
        req.kind === 'vote' && req.stage === 'r1' ? { target: 0 } : req.kind === 'tie_decide' ? { target: 2 } : undefined,
    ];
    const a = await play(11, disagree);
    const draw = ofType(a.events, 'tie_draw')[0]!;
    expect(draw.draws).toHaveLength(2);
    expect(draw.draws.filter((d) => d.ball.kind === 'killer')).toHaveLength(1);
    const loser = draw.draws.find((d) => d.ball.kind === 'killer')!.seat;
    expect(ofType(a.events, 'eliminated')[0]!.seat).toBe(loser);

    // Round 1: everyone votes for the next seat -> 1-1-1-1, no deciders.
    const ring: Script[] = [0, 1, 2, 3].map(
      (seat) => (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: (seat + 1) % 4 } : undefined),
    );
    const b = await play(12, ring);
    const tie = ofType(b.events, 'tie')[0]!;
    expect(tie.tied).toHaveLength(4);
    expect(tie.deciders).toHaveLength(0);
    expect(ofType(b.events, 'tie_decision')).toHaveLength(0);
    expect(ofType(b.events, 'tie_draw')[0]!.draws).toHaveLength(4);
  });

  it('replaces invalid answers with a fallback move and records them', async () => {
    const broken: Script = (req) => (req.kind === 'speak' ? undefined : { nonsense: true });
    const { result, events } = await play(3, [broken]);
    const errors = ofType(events, 'agent_error').filter((e) => e.seat === 0);
    expect(errors.length).toBeGreaterThan(0);
    expect(result.stats[0]!.invalidResponses).toBe(errors.length);
    // The fallback claim is the truth.
    const claim = ofType(events, 'claim').find((c) => c.seat === 0 && c.stage === 'r1')!;
    const back = ofType(events, 'back_row').find((b) => b.seat === 0 && b.stage === 'r1')!.back;
    expect(claim.claim.slice().sort()).toEqual(back.map((b) => (b.kind === 'killer' ? 'killer' : b.value)).sort());
  });

  it('keeps hidden information private', async () => {
    const seen: AgentContext[] = [];
    const spy: Script = (_req, ctx) => {
      seen.push(ctx);
      return undefined;
    };
    const { events } = await play(21, [spy]);
    for (const e of ofType(events, 'back_row')) expect(e.vis).toEqual({ seats: [e.seat] });
    for (const e of ofType(events, 'thoughts')) expect(e.vis).toEqual({ seats: [e.seat] });
    for (const ctx of seen) {
      for (const e of ctx.events) {
        expect(canSee(e, { seat: 0, omniscient: false })).toBe(true);
        if (e.type === 'back_row' || e.type === 'thoughts') expect(e.seat).toBe(0);
      }
      if (ctx.stage === 'bow' && ctx.board) {
        // Face-down balls are hidden from the finalists.
        const picked = ctx.events.filter((e) => e.type === 'ball_picked').length;
        expect(ctx.board.slots.filter((s) => s !== null)).toHaveLength(picked);
      }
    }
  });

  it('tracks honesty of back-row claims', async () => {
    const liar: Script = (req, ctx) =>
      req.kind === 'claim' ? { claim: ctx.myBack.map(() => 75_000), say: 'Big money!' } : undefined;
    const truthful: Script = (req, ctx) =>
      req.kind === 'claim'
        ? { claim: ctx.myBack.map((b) => (b.kind === 'killer' ? 'killer' : b.value)), say: '' }
        : undefined;
    const { result } = await play(8, [liar, truthful, truthful, truthful]);
    const s0 = result.stats[0]!;
    const s1 = result.stats[1]!;
    expect(s0.claims).toBeGreaterThanOrEqual(1);
    expect(s1.truthfulClaims).toBe(s1.claims);
    // Claiming 75k for every ball is only true if every ball really is 75k, which is impossible (only one exists).
    expect(s0.truthfulClaims).toBe(0);
  });

  it('survives hundreds of random games', async () => {
    for (let seed = 100; seed < 400; seed++) {
      const { result, events } = await play(seed);
      expect(ofType(events, 'eliminated')).toHaveLength(2);
      const total = result.payouts.reduce((s, p) => s + p.amount, 0);
      expect(total).toBeLessThanOrEqual(result.jackpot + 0.01);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      const start = ofType(events, 'bin_or_win_started')[0]!;
      expect(start.carried.every((c) => c.amount >= 0)).toBe(true);
    }
  });

  it('is reproducible from its seed', async () => {
    // Timestamps (and chat deadlines) come from the wall clock.
    const strip = (events: GameEvent[]) => events.map(({ ts: _ts, ...rest }) => ('endsAt' in rest ? { ...rest, endsAt: 0 } : rest));
    const a = await play(1234);
    const b = await play(1234);
    expect(strip(a.events)).toEqual(strip(b.events));
    expect(cashTotal([])).toBe(0);
  });

  describe('open floor chat', () => {
    const floorEvents = (events: GameEvent[], stage: string) => {
      const start = events.findIndex((e) => e.type === 'chat_started' && e.stage === stage);
      const end = events.findIndex((e, i) => i > start && e.type === 'chat_ended');
      return { started: events[start], ended: events[end], inside: events.slice(start + 1, end) };
    };
    const speechesIn = (inside: GameEvent[]) =>
      inside.filter((e): e is Extract<GameEvent, { type: 'speech' }> => e.type === 'speech');

    it('stops at the message cap', async () => {
      const chatty: Script = (req) => (req.kind === 'chat' ? { say: 'Talking!' } : undefined);
      const { events } = await play(31, [chatty, chatty, chatty, chatty], { chatMaxMessages: 6 });
      const r1 = floorEvents(events, 'r1');
      expect(speechesIn(r1.inside)).toHaveLength(6);
      expect(r1.ended).toMatchObject({ reason: 'limit' });
    });

    it('lets whoever is spoken to reply next', async () => {
      // Everyone always addresses the next player round the table.
      const addressNext: Script = (req, ctx) => {
        if (req.kind !== 'chat') return undefined;
        const i = req.participants.indexOf(ctx.seat);
        return { say: 'Your turn', to: req.participants[(i + 1) % req.participants.length] };
      };
      const { events } = await play(32, [addressNext, addressNext, addressNext, addressNext], { chatMaxMessages: 8 });
      const said = speechesIn(floorEvents(events, 'r1').inside);
      expect(said.length).toBe(8);
      for (let i = 0; i + 1 < said.length; i++) expect(said[i + 1]!.seat).toBe(said[i]!.to);
    });

    it("doesn't let two players hog the floor", async () => {
      // Everyone answers whoever spoke to them, and otherwise talks to the first other player.
      const replier: Script = (req, ctx) => {
        if (req.kind !== 'chat') return undefined;
        const to = req.replyTo ?? req.participants.find((s) => s !== ctx.seat)!;
        return { say: 'No, you!', to };
      };
      const { events } = await play(38, [replier, replier, replier, replier], { chatMaxMessages: 8 });
      const r1 = floorEvents(events, 'r1');
      const speakers = new Set(speechesIn(r1.inside).map((s) => s.seat));
      expect(speakers.size).toBe((r1.started as Extract<GameEvent, { type: 'chat_started' }>).participants.length);
    });

    it('closes early when everyone has nothing to say', async () => {
      const quiet: Script = (req) => (req.kind === 'chat' ? { pass: true } : undefined);
      const { events } = await play(33, [quiet, quiet, quiet, quiet]);
      const r1 = floorEvents(events, 'r1');
      expect(speechesIn(r1.inside)).toHaveLength(0);
      expect(r1.inside.filter((e) => e.type === 'chat_pass')).toHaveLength(4);
      expect(r1.ended).toMatchObject({ reason: 'quiet' });
    });

    it('closes when time runs out', async () => {
      const slow: Agent = {
        async act(request, ctx, meta) {
          if (request.kind === 'chat') {
            await new Promise((r) => setTimeout(r, 300));
            return { response: { say: 'Let me think about that...' } };
          }
          return new MockAgent('mock/honest', ctx.seat).act(request, ctx, meta);
        },
      };
      const events: GameEvent[] = [];
      const started = Date.now();
      await new GameEngine({
        players,
        agents: [slow, slow, slow, slow],
        options: options(34, { chatSeconds: 1, finalChatSeconds: 1, chatMaxMessages: 40 }),
        emit: (e) => events.push(e),
      }).run();
      const r1 = floorEvents(events, 'r1');
      expect(r1.ended).toMatchObject({ reason: 'time' });
      expect(speechesIn(r1.inside).length).toBeLessThanOrEqual(5);
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('is a two-way conversation in the final, and can be switched off', async () => {
      const { events } = await play(35);
      const final = floorEvents(events, 'final');
      const finalists = (final.started as Extract<GameEvent, { type: 'chat_started' }>).participants;
      expect(finalists).toHaveLength(2);
      const said = speechesIn(final.inside);
      for (let i = 0; i + 1 < said.length; i++) expect(said[i + 1]!.seat).not.toBe(said[i]!.seat);

      const silent = await play(36, [], { chatSeconds: 0, finalChatSeconds: 0 });
      expect(silent.events.some((e) => e.type === 'chat_started')).toBe(false);
    });
  });

  it('stops the game when a contestant hits an unrecoverable error', async () => {
    const broken: Agent = {
      async act() {
        throw new AgentError('OpenRouter rejected the API key (401)', undefined, undefined, true);
      },
    };
    const events: GameEvent[] = [];
    const engine = new GameEngine({
      players,
      agents: [broken, ...players.slice(1).map((p) => new MockAgent('mock/honest', p.seat))],
      options: options(37),
      emit: (e) => events.push(e),
    });
    await expect(engine.run()).rejects.toBeInstanceOf(GameFatalError);
    expect(events.some((e) => e.type === 'agent_error')).toBe(false);
  });

  it('can be aborted mid-game', async () => {
    const controller = new AbortController();
    const events: GameEvent[] = [];
    const engine = new GameEngine({
      players,
      agents: players.map((p) => new MockAgent('mock/chaos', p.seat, 5)),
      options: options(1),
      emit: (e) => {
        events.push(e);
        if (e.type === 'claim') controller.abort();
      },
      signal: controller.signal,
    });
    await expect(engine.run()).rejects.toThrow(/aborted/i);
  });
});
