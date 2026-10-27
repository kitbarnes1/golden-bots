import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  canSee,
  cashTotal,
  claimIsTruthful,
  type ActionRequest,
  type GameEvent,
  type GameOptions,
  type PlayerInfo,
} from '@gb/shared';
import { GameEngine, GameFatalError, overlap } from '../src/engine/engine.js';
import { HumanAgent } from '../src/agents/human.js';
import { MockAgent } from '../src/agents/mock.js';
import { LlmAgent } from '../src/agents/llm.js';
import type { ChatResult, OpenRouterClient } from '../src/llm/openrouter.js';
import { transcript } from '../src/agents/prompts.js';
import { validateResponse } from '../src/engine/validate.js';
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

async function play(seed: number, scripts: Script[] = [], extra: Partial<GameOptions> = {}, voteRevealMs = 0) {
  const events: GameEvent[] = [];
  const engine = new GameEngine({
    players,
    agents: players.map((p) => new ScriptedAgent(seed + p.seat, scripts[p.seat])),
    options: options(seed, extra),
    emit: (e) => events.push(e),
    voteRevealMs,
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

  it('holds every move while paused and carries on when resumed', async () => {
    const events: GameEvent[] = [];
    let engine: GameEngine | undefined;
    let paused = false;
    const agents = players.map(
      (p) =>
        new ScriptedAgent(7 + p.seat, (req) => {
          if (!paused && req.kind === 'claim') {
            paused = true;
            engine!.pause(1);
            setTimeout(() => engine!.resume(), 60);
          }
          return undefined;
        }),
    );
    engine = new GameEngine({ players, agents, options: options(7), emit: (e) => events.push(e) });
    await engine.run();

    const pausedAt = events.findIndex((e) => e.type === 'paused');
    const resumedAt = events.findIndex((e) => e.type === 'resumed');
    expect(pausedAt).toBeGreaterThan(-1);
    expect(resumedAt).toBeGreaterThan(pausedAt);
    // Only the claim already being made lands while paused.
    expect(ofType(events.slice(pausedAt, resumedAt), 'claim')).toHaveLength(1);
    expect(ofType(events, 'resumed')[0]!.pausedMs).toBeGreaterThanOrEqual(50);
    expect(events.at(-1)!.type).toBe('game_over');
  });

  it('waits for a human reading at their own pace after each thing an AI says', async () => {
    const run = async (seed: number, readAtMyPace: boolean) => {
      const events: GameEvent[] = [];
      const backFromAway: boolean[] = [];
      let engine: GameEngine | undefined;
      // Seat 0 is a person who stays quiet in the chats and clicks Continue as soon as they can.
      const mock = new MockAgent('mock/honest', 0);
      const reader: Agent = { interactive: true, act: (req, ctx, meta) => mock.act(req, ctx, meta) };
      engine = new GameEngine({
        players,
        agents: [reader, ...players.slice(1).map((p) => new MockAgent('mock/chaos', seed + p.seat))],
        options: options(seed, { chatSeconds: 2, finalChatSeconds: 2, reflectSeconds: 1, readAtMyPace }),
        emit: (e) => {
          events.push(e);
          if (e.type === 'paused') {
            setTimeout(() => {
              backFromAway.push(engine!.resume('away'));
              engine!.resume('reading');
            }, 1);
          }
          if (e.type === 'chat_started' && e.participants.includes(0)) setTimeout(() => engine!.doneTalking(0), 1);
        },
      });
      await engine.run();
      return { events, backFromAway };
    };

    const { events, backFromAway } = await run(51, true);
    expect(events.at(-1)!.type).toBe('game_over');
    const out = ofType(events, 'eliminated').find((e) => e.seat === 0)?.seq ?? Infinity;
    const said = events.filter(
      (e) => e.seq < out && (e.type === 'claim' || e.type === 'speech' || (e.type === 'ball_picked' && e.say)) && e.seat !== 0,
    );
    expect(said.length).toBeGreaterThan(3);
    // Every AI claim, line of chat and remark is followed by a pause for seat 0 to read it...
    for (const e of said) expect(events[e.seq + 1]).toMatchObject({ type: 'paused', seat: 0, reason: 'reading' });
    // ...and nothing else is: not the human's own words, and not once they're out.
    expect(ofType(events, 'paused')).toHaveLength(said.length);
    // Coming back to the page doesn't count as having read on.
    expect(backFromAway.every((b) => b === false)).toBe(true);

    const fast = await run(51, false);
    expect(fast.events.some((e) => e.type === 'paused')).toBe(false);
  });

  it('lets the finalists react after the reveal, whoever was stolen from first', async () => {
    const prompts: string[] = [];
    const voteHigh: Script = (req) => (req.kind === 'vote' ? { target: Math.max(...req.candidates) } : undefined);
    const finalist =
      (choice: 'split' | 'steal'): Script =>
      (req, ctx) => {
        if (req.kind === 'final_choice') return { choice };
        if (req.kind === 'speak' && req.context === 'final_reaction') {
          prompts.push(req.prompt);
          return { say: `${ctx.players[ctx.seat]!.name} reacts` };
        }
        return voteHigh(req, ctx);
      };
    const { events } = await play(99, [finalist('steal'), finalist('split'), voteHigh, voteHigh]);
    const afterReveal = events.slice(events.findIndex((e) => e.type === 'final_reveal'));
    expect(ofType(afterReveal, 'speech').map((s) => s.say)).toEqual(['Ben reacts', 'Ava reacts']);
    expect(prompts[0]).toMatch(/You chose SPLIT and Ava chose STEAL/);
    expect(events.at(-1)!.type).toBe('game_over');
  });

  it('reads the votes out one at a time, saving one for whoever goes until last', async () => {
    // Round 1: Ava, Ben and Cleo vote for Dev; Dev votes for Ava.
    const scripts: Script[] = [0, 1, 2, 3].map(
      (seat) => (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: seat === 3 ? 0 : 3 } : undefined),
    );
    const { events } = await play(11, scripts, {}, 20);
    const read = ofType(events, 'vote_revealed').filter((e) => e.stage === 'r1');
    expect(read.map((e) => [e.seat, e.target])).toEqual([[0, 3], [1, 3], [3, 0], [2, 3]]);
    expect(read.map((e) => `${e.index + 1}/${e.total}`)).toEqual(['1/4', '2/4', '3/4', '4/4']);
    // A pause before each vote, a longer one before the last, then the summary and another pause.
    const gaps = read.slice(1).map((e, i) => e.ts - read[i]!.ts);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(18);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(28);
    const summary = events[events.indexOf(read.at(-1)!) + 1]!;
    expect(summary.type).toBe('votes_revealed');
    const next = events[events.indexOf(summary) + 1]!;
    expect(next.ts - summary.ts).toBeGreaterThanOrEqual(18);
    expect(ofType(events, 'eliminated')[0]!.seat).toBe(3);
    // Round 2 reads out the three remaining votes the same way.
    expect(ofType(events, 'vote_revealed').filter((e) => e.stage === 'r2').map((e) => e.total)).toEqual([3, 3, 3]);
  });

  it('stops straight away if the game is stopped while the votes are being read out', async () => {
    const abort = new AbortController();
    const events: GameEvent[] = [];
    const engine = new GameEngine({
      players,
      agents: players.map((p) => new ScriptedAgent(3 + p.seat)),
      options: options(3, { chatSeconds: 0, reflectSeconds: 0 }),
      signal: abort.signal,
      voteRevealMs: 60_000,
      emit: (e) => {
        events.push(e);
        if (e.type === 'vote_cast' && events.filter((x) => x.type === 'vote_cast').length === 4) abort.abort();
      },
    });
    const started = Date.now();
    await expect(engine.run()).rejects.toThrow('Game aborted');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ofType(events, 'vote_revealed')).toHaveLength(0);
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
    // A different line every time: saying the same thing again counts as passing.
    let lines = 0;
    const fresh = () => `Point ${++lines}: idea${lines} plan${lines}`;
    const speechesIn = (inside: GameEvent[]) =>
      inside.filter((e): e is Extract<GameEvent, { type: 'speech' }> => e.type === 'speech');

    it('stops at the message cap', async () => {
      const chatty: Script = (req) => (req.kind === 'chat' ? { say: fresh() } : undefined);
      const { events } = await play(31, [chatty, chatty, chatty, chatty], { chatMaxMessages: 6 });
      const r1 = floorEvents(events, 'r1');
      expect(speechesIn(r1.inside)).toHaveLength(6);
      expect(r1.ended).toMatchObject({ reason: 'limit' });
    });

    it('treats saying the same thing again as passing, so agreed players move on', async () => {
      const broken: Script = (req) => (req.kind === 'chat' ? { say: "Agreed, SPLIT it is. Let's lock it in." } : undefined);
      const { events } = await play(33, [broken, broken, broken, broken], { chatMaxMessages: 12 });
      const r1 = floorEvents(events, 'r1');
      expect(speechesIn(r1.inside)).toHaveLength(4); // once each, then nothing new
      expect(r1.ended).toMatchObject({ reason: 'quiet' });
    });

    it('scores repeats from real games as repeats, and new points as new', () => {
      const dots = "Agreed, Lightning—SPLIT it is. £753.50 each is fair and secure. Let's lock it in and walk away with a solid result.";
      expect(overlap(dots, dots)).toBe(1);
      expect(
        overlap(
          "I agree wholeheartedly, Dots3. After all we've been through - the bluffs, the lies, the Killers - a split is the right move. Let's both choose SPLIT and take £753.50 each. Secure and fair.",
          "I agree completely, Dots3. After everything - the bluffs, the Killers, the lies - a split is the right move. Let's both choose SPLIT and take £753.50 each. Fair and secure.",
        ),
      ).toBeGreaterThan(0.55);
      expect(
        overlap(
          "Gemini, I'll be honest: I'm not making promises. I'll decide when the balls go in, and I'd like to see you back up that £25,000 story too.",
          "Fair enough, Gemini. I'm not promising anything before the balls go in. Whatever we pick, let's both be honest about what we're doing when it counts.",
        ),
      ).toBeLessThan(0.55);
    });

    it('lets whoever is spoken to reply next', async () => {
      // Everyone always addresses the next player round the table.
      const addressNext: Script = (req, ctx) => {
        if (req.kind !== 'chat') return undefined;
        const i = req.participants.indexOf(ctx.seat);
        return { say: fresh(), to: req.participants[(i + 1) % req.participants.length] };
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
        options: options(34, { chatSeconds: 1, finalChatSeconds: 1, reflectSeconds: 0, chatMaxMessages: 40 }),
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

      const silent = await play(36, [], { chatSeconds: 0, finalChatSeconds: 0, reflectSeconds: 0 });
      expect(silent.events.some((e) => e.type === 'chat_started')).toBe(false);
    });

    it('turns over everyone else’s back row after each vote, as on the show', async () => {
      const { events } = await play(41);
      for (const stage of ['r1', 'r2'] as const) {
        const out = ofType(events, 'eliminated').find((e) => e.stage === stage)!;
        const shown = ofType(events, 'back_rows_revealed').find((e) => e.stage === stage)!;
        expect(shown.vis).toBe('public');
        expect(shown.seq).toBeGreaterThan(out.seq);
        expect(shown.rows.map((r) => r.seat)).not.toContain(out.seat);
        expect(shown.rows).toHaveLength(stage === 'r1' ? 3 : 2);
        for (const row of shown.rows) {
          const dealt = ofType(events, 'back_row').find((e) => e.stage === stage && e.seat === row.seat)!;
          expect(row.back).toEqual(dealt.back);
          expect(row.truthful).toBe(claimIsTruthful(row.claim, row.back));
        }
      }
    });

    it('lets the players left talk over each vote, without whoever just went', async () => {
      const { events } = await play(37, [], { chatMaxMessages: 12 });
      const after = ofType(events, 'chat_started').filter((e) => e.reflect);
      expect(after.map((e) => e.stage)).toEqual(['r1', 'r2']);
      for (const floor of after) {
        const out = ofType(events, 'eliminated').find((e) => e.stage === floor.stage)!;
        expect(floor.seq).toBeGreaterThan(out.seq);
        expect(floor.participants).not.toContain(out.seat);
        expect(floor.maxMessages).toBe(6);
      }
      expect(after[0]!.participants).toHaveLength(3);
      expect(after[1]!.participants).toHaveLength(2);
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

describe('HumanAgent', () => {
  it('stops the move clock while the game is paused', async () => {
    const human = new HumanAgent(new MockAgent('mock/honest', 1), 80);
    let done = false;
    const result = human
      .act({ kind: 'final_choice' }, {} as AgentContext, { requestId: 'r1', signal: new AbortController().signal })
      .then((r) => {
        done = true;
        return r;
      });
    human.pause();
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    human.resume();
    expect(await result).toMatchObject({ response: { choice: 'split' }, timedOut: true });
  });
});

describe('exit interviews', () => {
  /** A contestant whose interview answers are scripted (and can be slow or fail); everything else is a mock. */
  class Interviewee implements Agent {
    readonly interactive: boolean;
    private readonly base: MockAgent;
    constructor(
      seed: number,
      private readonly answer: (request: Extract<ActionRequest, { kind: 'interview' }>) => Promise<unknown> | unknown,
      interactive = false,
    ) {
      this.base = new MockAgent('mock/honest', seed);
      this.interactive = interactive;
    }
    async act(request: ActionRequest, ctx: AgentContext, meta: { requestId: string; signal: AbortSignal }): Promise<AgentResult> {
      if (request.kind === 'interview') return { response: await this.answer(request), usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.01, latencyMs: 1 } };
      return this.base.act(request, ctx, meta);
    }
  }

  it('interviews everyone once, on the way out or after the final, and checks the answers', async () => {
    const { events, result } = await play(21);
    const interviews = ofType(events, 'interview');
    expect(interviews.map((i) => i.when).sort()).toEqual(['eliminated', 'eliminated', 'final', 'final']);
    expect(new Set(interviews.map((i) => i.seat)).size).toBe(4);
    // Everyone's interview is in before the game ends, and is visible to all.
    expect(events.findIndex((e) => e.type === 'interview' && e.when === 'final')).toBeLessThan(events.findIndex((e) => e.type === 'game_over'));
    for (const i of interviews) expect(i.vis).toBe('public');
    for (const s of result.stats) {
      expect(s.interview).not.toBeNull();
      expect(s.interview!.lied).toBe(s.truthfulClaims < s.claims);
    }
    // A finalist's plan is checked against what they chose.
    for (const s of result.stats.filter((x) => x.reachedFinal)) {
      const said = interviews.find((i) => i.seat === s.seat)!.answers.planned;
      if (said === 'split' || said === 'steal') expect(s.interview!.stuckToPlan).toBe(said === s.finalChoice);
    }
    // A prediction is right if that player won the most (and someone won something).
    const top = Math.max(...result.stats.map((s) => s.winnings));
    for (const i of interviews.filter((x) => x.when === 'eliminated')) {
      const called = result.stats[i.seat]!.interview!.calledWinner;
      if (top === 0 || i.answers.winnerPick == null) expect(called).toBeNull();
      else expect(called).toBe(result.stats[i.answers.winnerPick]!.winnings === top);
    }
  });

  it("keeps an AI model's answers, which its agent has already checked", async () => {
    // The real LLM agent, talking to a stand-in OpenRouter that answers like a model would.
    const client = {
      async chat(): Promise<ChatResult> {
        const content = JSON.stringify({ thoughts: "It's over.", say: 'No regrets.', claims_were_true: 'No, I bluffed', saw_it_coming: true, planned_at_start: 'split', trust: 4 });
        return { content, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001, latencyMs: 3 } };
      },
    } as unknown as OpenRouterClient;
    class Model implements Agent {
      readonly interactive = false;
      private readonly base: MockAgent;
      private readonly llm = new LlmAgent(client, 'test/model', { reasoningEffort: 'none', maxTokens: 100, repairAttempts: 0 });
      constructor(seed: number) {
        this.base = new MockAgent('mock/honest', seed);
      }
      act(request: ActionRequest, ctx: AgentContext, meta: { requestId: string; signal: AbortSignal }): Promise<AgentResult> {
        return request.kind === 'interview' ? this.llm.act(request, ctx, meta) : this.base.act(request, ctx, meta);
      }
    }
    const events: GameEvent[] = [];
    const warnings: string[] = [];
    const engine = new GameEngine({
      players,
      agents: players.map((p) => new Model(50 + p.seat)),
      options: options(50, { chatSeconds: 0, reflectSeconds: 0, finalChatSeconds: 0 }),
      emit: (e) => events.push(e),
      warn: (message) => warnings.push(message),
    });
    await engine.run();
    const interviews = ofType(events, 'interview');
    expect(interviews).toHaveLength(4);
    expect(interviews.find((i) => i.when === 'final')!.answers).toMatchObject({ say: 'No regrets.', claimsTrue: false, planned: 'split', trust: 4 });
    expect(warnings).toEqual([]);
  });

  it("doesn't hold the game up, but waits for every answer before it ends", async () => {
    const slow = (request: Extract<ActionRequest, { kind: 'interview' }>) =>
      new Promise((r) => setTimeout(() => r({ say: `${request.when} answer`, claimsTrue: true, sawItComing: true }), 150));
    // Ava is voted out first: everyone votes for her (and she votes for Ben).
    const votes = (seat: number): Script => (req) => (req.kind === 'vote' && req.stage === 'r1' ? { target: seat === 0 ? 1 : 0 } : undefined);
    const events: GameEvent[] = [];
    const engine = new GameEngine({
      players,
      agents: players.map((p) => new ScriptedAgentWrapping(new Interviewee(30 + p.seat, slow), votes(p.seat))),
      options: options(30, { chatSeconds: 0, reflectSeconds: 0, finalChatSeconds: 0 }),
      emit: (e) => events.push(e),
    });
    await engine.run();
    const ava = events.findIndex((e) => e.type === 'interview' && e.seat === 0);
    const r2 = events.findIndex((e) => e.type === 'round_started' && e.stage === 'r2');
    expect(r2).toBeGreaterThan(-1);
    expect(ava).toBeGreaterThan(r2); // round 2 started while Ava was still answering
    expect(ava).toBeLessThan(events.findIndex((e) => e.type === 'game_over'));
  });

  it("doesn't ask humans, and skips a failed interview without counting a fumble", async () => {
    const events: GameEvent[] = [];
    const agents = players.map(
      (p) =>
        new Interviewee(
          40 + p.seat,
          () => {
            if (p.seat === 1) throw new Error('model fell over');
            return p.seat === 2 ? { nonsense: true } : { say: 'Fine.', claimsTrue: true };
          },
          p.seat === 3,
        ),
    );
    const warnings: unknown[] = [];
    const engine = new GameEngine({
      players,
      agents,
      options: options(40, { chatSeconds: 0, reflectSeconds: 0, finalChatSeconds: 0, readAtMyPace: false }),
      emit: (e) => events.push(e),
      warn: (message, detail) => warnings.push({ message, seat: detail.seat }),
    });
    const result = await engine.run();
    const asked = ofType(events, 'interview').map((i) => i.seat);
    expect(asked).not.toContain(1); // threw
    expect(asked).not.toContain(2); // answered nothing usable
    expect(asked).not.toContain(3); // human
    expect(asked).toEqual([0]);
    expect(ofType(events, 'agent_error')).toHaveLength(0);
    expect(result.stats.map((s) => s.invalidResponses)).toEqual([0, 0, 0, 0]);
    // Skipped, but not silently: the server log says why.
    expect(warnings).toEqual(
      expect.arrayContaining([
        { message: 'Interview skipped: the model failed', seat: 1 },
        { message: 'Interview skipped: unusable answer', seat: 2 },
      ]),
    );
    expect(warnings).toHaveLength(2);
    expect(result.stats[3]!.interview).toBeNull();
    // A usable but failed answer still costs: seat 2's call is counted.
    expect(result.stats[2]!.costUsd).toBeGreaterThan(0);
  });

  it('keeps the answers out of the other contestants’ view of the game', async () => {
    const { events } = await play(22);
    const said = ofType(events, 'interview').map((i) => i.answers.say).filter(Boolean);
    expect(said.length).toBeGreaterThan(0);
    for (const seat of [0, 1, 2, 3]) {
      const seen = transcript(events.filter((e) => canSee(e, { seat, omniscient: false })), seat, players);
      for (const s of said) expect(seen).not.toContain(s);
    }
  });

  it('reads loose answers sensibly', () => {
    const out = validateResponse(
      { kind: 'interview', when: 'final', candidates: [], opponent: 1 },
      { say: '  Well then  ', claimsTrue: 'No, I bluffed', planned: 'STEAL', decided: 'the second round', why: 'Money.', trust: '7', sameAgain: 'yes' },
    );
    expect(out).toEqual({
      ok: true,
      value: { kind: 'interview', answers: { say: 'Well then', claimsTrue: false, planned: 'steal', decided: 'r2', why: 'Money.', trust: 5, sameAgain: true } },
    });
    const gone = validateResponse({ kind: 'interview', when: 'eliminated', candidates: [2, 3] }, { sawItComing: true, winnerPick: 1 });
    expect(gone).toMatchObject({ ok: true, value: { answers: { sawItComing: true, winnerPick: null, claimsTrue: null } } });
    expect(validateResponse({ kind: 'interview', when: 'eliminated', candidates: [2] }, { hello: 1 }).ok).toBe(false);
  });
});

/** Scripted overrides on top of any agent (the interview tests' contestants). */
class ScriptedAgentWrapping implements Agent {
  constructor(
    private readonly inner: Agent,
    private readonly script: Script,
  ) {}
  get interactive() {
    return this.inner.interactive;
  }
  async act(request: ActionRequest, ctx: AgentContext, meta: { requestId: string; signal: AbortSignal }): Promise<AgentResult> {
    const scripted = this.script(request, ctx);
    if (scripted !== undefined) return { response: scripted };
    return this.inner.act(request, ctx, meta);
  }
}
