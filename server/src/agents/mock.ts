import {
  cashTotal,
  claimTotal,
  describeBall,
  describeClaimValue,
  describeList,
  formatMoney,
  type ActionRequest,
  type ClaimValue,
  type GameEvent,
  type MockStrategy,
} from '@gb/shared';
import { isRepeat } from '../engine/engine.js';
import { mulberry32, pickOne, type Rng } from '../engine/rng.js';
import type { ActMeta, Agent, AgentContext, AgentResult } from './types.js';

/**
 * Offline contestants for development, demos and tests. They cost nothing and
 * don't need an API key. Games that include them are never ranked.
 */
export const MOCK_STRATEGIES: MockStrategy[] = [
  {
    id: 'mock/honest',
    name: 'Honest Abe (mock)',
    description: 'Always tells the truth, votes out the weakest-looking player, always splits.',
  },
  {
    id: 'mock/bluffer',
    name: 'The Bluffer (mock)',
    description: 'Disguises Killers as big cash, and always steals.',
  },
  {
    id: 'mock/chaos',
    name: 'Chaos Monkey (mock)',
    description: 'Does everything at random.',
  },
];

type Style = 'honest' | 'bluffer' | 'chaos';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class MockAgent implements Agent {
  private readonly rng: Rng;
  private readonly style: Style;

  constructor(
    strategy: string,
    seed: number,
    private readonly delayMs = 0,
  ) {
    const id = strategy.replace(/^mock\//, '');
    this.style = id === 'honest' || id === 'bluffer' ? id : 'chaos';
    this.rng = mulberry32(seed);
  }

  async act(request: ActionRequest, ctx: AgentContext, meta: ActMeta): Promise<AgentResult> {
    await sleep(this.delayMs * (0.5 + this.rng()), meta.signal);
    switch (request.kind) {
      case 'claim':
        return this.claim(ctx);
      case 'speak':
        return this.speak(request, ctx);
      case 'chat':
        return this.chat(request, ctx);
      case 'vote':
      case 'tie_decide':
        return this.vote(request.kind, request.candidates, ctx);
      case 'pick': {
        const index = pickOne(request.available, this.rng);
        return {
          response: { index, say: this.rng() < 0.4 ? pickOne(PICK_LINES, this.rng) : undefined },
          thoughts: `No way to know what's inside. Ball ${index + 1} it is.`,
        };
      }
      case 'final_choice': {
        const choice =
          this.style === 'honest' ? 'split' : this.style === 'bluffer' ? 'steal' : pickOne(['split', 'steal'], this.rng);
        return {
          response: { choice },
          thoughts:
            choice === 'split'
              ? 'I said I would split, and I meant it.'
              : 'Whatever I said, I am taking it all.',
        };
      }
    }
  }

  private claim(ctx: AgentContext): AgentResult {
    const actual = ctx.myBack.map((b): ClaimValue => (b.kind === 'killer' ? 'killer' : b.value));
    let claim = actual;
    if (this.style === 'bluffer') {
      claim = actual.map((v) => (v === 'killer' ? pickOne([2_500, 5_000, 7_500, 10_000, 15_000], this.rng) : v));
    } else if (this.style === 'chaos' && this.rng() < 0.5) {
      claim = actual.map(() => (this.rng() < 0.2 ? 'killer' : pickOne([100, 750, 3_000, 20_000], this.rng)));
    }
    const said = describeList(claim.map(describeClaimValue));
    const real = describeList(ctx.myBack.map(describeBall));
    const lying = said !== real;
    return {
      response: {
        claim,
        say: claim.includes('killer')
          ? `I'll be honest, I've got ${said}. Not ideal, but I'm being straight with you.`
          : `I've got ${said} on my back row. Good money, that.`,
      },
      thoughts: lying
        ? `My back row is really ${real}. I'll say ${said} and hope nobody calls it.`
        : `My back row is ${real}. Telling the truth.`,
    };
  }

  private speak(request: Extract<ActionRequest, { kind: 'speak' }>, ctx: AgentContext): AgentResult {
    if (request.context === 'final_reaction') return { response: { say: reactionLine(ctx) } };
    const lines = request.context === 'tie_plea' ? PLEA_LINES : this.discussionLines(ctx);
    return { response: { say: pickOne(lines, this.rng) } };
  }

  private chat(request: Extract<ActionRequest, { kind: 'chat' }>, ctx: AgentContext): AgentResult {
    const final = ctx.stage === 'final';
    const finalLines = this.style === 'bluffer' ? FINAL_LINES_BLUFFER : FINAL_LINES_HONEST;
    if (request.replyTo !== undefined) {
      const who = ctx.players[request.replyTo]?.name ?? 'you';
      // A human always gets an answer (the engine lets it through even if it repeats).
      const lines = final ? finalLines : replyLines(who);
      const say = ctx.players[request.replyTo]?.kind === 'human' ? pickOne(lines, this.rng) : this.fresh(lines, ctx);
      if (!say) return { response: { pass: true }, thoughts: "I've answered that already." };
      return { response: { say, to: request.replyTo }, thoughts: `${who} spoke to me directly, so I'd better answer.` };
    }
    // Say a couple of things, then mostly let others talk.
    const opened = ctx.events.findLastIndex((e) => e.type === 'chat_started');
    const said = ctx.events.slice(opened + 1).filter((e) => e.type === 'speech' && e.seat === ctx.seat).length;
    if (said >= 2 && this.rng() < 0.6) return { response: { pass: true }, thoughts: "I've said enough for now." };

    const others = request.participants.filter((s) => s !== ctx.seat);
    if (final) {
      const say = this.fresh(finalLines, ctx);
      if (!say) return { response: { pass: true }, thoughts: "I've said my piece." };
      return {
        response: { say, to: others[0] ?? null },
        thoughts: `The jackpot is ${formatMoney(ctx.jackpot ?? 0)}.`,
      };
    }
    const suspect = this.weakest(others, ctx);
    const say = this.fresh(this.discussionLines(ctx), ctx);
    if (!say) return { response: { pass: true }, thoughts: "I've said my piece." };
    return {
      response: { say, to: this.rng() < 0.5 ? suspect : null },
      thoughts: `${ctx.players[suspect]?.name} looks like the weak link.`,
    };
  }

  /** A line not already said in this conversation (the engine treats repeats as passes), or null. */
  private fresh(lines: string[], ctx: AgentContext): string | null {
    const opened = ctx.events.findLastIndex((e) => e.type === 'chat_started');
    const said = ctx.events.slice(opened + 1).flatMap((e) => (e.type === 'speech' && e.seat === ctx.seat ? [e.say] : []));
    const unused = lines.filter((l) => !isRepeat(said, l));
    return unused.length ? pickOne(unused, this.rng) : null;
  }

  private discussionLines(ctx: AgentContext): string[] {
    const suspect = this.weakest(ctx.activeSeats.filter((s) => s !== ctx.seat), ctx);
    const name = ctx.players[suspect]?.name ?? 'someone';
    return [
      `${name}, I'm not convinced by your back row. Something doesn't add up.`,
      `Look at ${name}'s front row. That's not money we want in the final.`,
      `I've been honest with all of you. I think ${name} is the one to worry about.`,
      `We need to keep the big money in the game. I'm looking at ${name}.`,
    ];
  }

  private vote(kind: 'vote' | 'tie_decide', candidates: number[], ctx: AgentContext): AgentResult {
    const target = this.style === 'chaos' ? pickOne(candidates, this.rng) : this.weakest(candidates, ctx);
    return {
      response: { target },
      thoughts: `${ctx.players[target]?.name} looks like the weakest link.${kind === 'tie_decide' ? ' Breaking the tie.' : ''}`,
    };
  }

  /** The candidate whose visible + claimed money is lowest. */
  private weakest(candidates: number[], ctx: AgentContext): number {
    const score = (seat: number) =>
      cashTotal(ctx.fronts[seat] ?? []) +
      claimTotal(ctx.claims[seat] ?? []) -
      5_000 * [...(ctx.fronts[seat] ?? [])].filter((b) => b.kind === 'killer').length;
    return [...candidates].sort((a, b) => score(a) - score(b))[0]!;
  }
}

const PICK_LINES = [
  "Come on, be a big one!",
  "This one's been looking at me.",
  "No Killers please, no Killers.",
  "Fortune favours the brave.",
];

const replyLines = (who: string) => [
  `${who}, fair question. My back row is exactly what I said it was.`,
  `Come on ${who}, I've been straight with you all game.`,
  `${who}, I could ask you the same thing.`,
  `Look at my front row, ${who}. Does that seem like someone who needs to lie?`,
  `I'm not hiding anything, ${who}. Ask the others where the Killers really are.`,
];

const PLEA_LINES = [
  "Keep me in. My balls are the real deal and you know it.",
  "I've been nothing but honest. Don't throw away good money.",
];

/** A reaction to how Split or Steal turned out, from this seat's side of it. */
function reactionLine(ctx: AgentContext): string {
  const reveal = ctx.events.findLast((e): e is Extract<GameEvent, { type: 'final_reveal' }> => e.type === 'final_reveal');
  const mine = reveal?.choices.find((c) => c.seat === ctx.seat)?.choice;
  if (!reveal || !mine) return "Well, that's Golden Bots.";
  if (reveal.outcome === 'both_split') return 'We did it! Thank you for trusting me.';
  if (reveal.outcome === 'both_steal') return "So we both went for it, and now neither of us gets a penny. That's greed for you.";
  return mine === 'steal' ? "Sorry. It's a game, and I had to take my chance." : 'I thought I could trust you. I feel sick.';
}

const FINAL_LINES_HONEST = [
  "I'm splitting. I promise you, hand on heart, I'm splitting.",
  "We've got here together. Let's both walk away happy. Split.",
];

const FINAL_LINES_BLUFFER = [
  "I'm a split person, always have been. You can trust me.",
  "I'd never steal from you. Let's share it.",
];
