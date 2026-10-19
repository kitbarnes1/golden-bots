import {
  describeBall,
  describeClaimValue,
  describeList,
  formatMoney,
  type ActionRequest,
  type Ball,
  type ClaimValue,
  type GameEvent,
  type PlayerInfo,
} from '@gb/shared';
import type { AgentContext } from './types.js';

const balls = (list: Ball[]) => (list.length ? describeList(list.map(describeBall)) : 'nothing');
const claimed = (list: ClaimValue[]) => describeList(list.map(describeClaimValue));
const STAGE_TITLES = { r1: 'ROUND 1', r2: 'ROUND 2', bow: 'BIN OR WIN', final: 'SPLIT OR STEAL' } as const;

export function systemPrompt(ctx: AgentContext): string {
  const me = ctx.players[ctx.seat]!;
  const others = ctx.players.filter((p) => p.seat !== ctx.seat).map((p) => p.name);
  const identity =
    me.kind === 'ai' && ctx.options.revealModelNames
      ? ` Everyone knows you are the AI model ${me.modelLabel ?? me.model}.`
      : '';
  return `You are ${me.name}, a contestant on "Golden Balls", the British TV game show.${identity} Your opponents are ${describeList(others)}. They may be other AI models or humans.

HOW THE GAME WORKS
- Round 1: 12 cash balls (worth £10 to £75,000) from the Golden Bank plus 4 KILLER balls are shuffled and dealt, 4 to each of the 4 players: 2 on your front row (everyone can see them) and 2 on your back row (only you can see them). Each player announces what is on their back row. You may tell the truth or lie. After a discussion, everyone secretly votes to eliminate one player. The eliminated player leaves with nothing, all of their balls are thrown away, and their back row is revealed so everyone sees whether they lied.
- Round 2: The 3 survivors' 12 balls go back in the machine with 2 more cash balls and 1 more KILLER (15 balls). Each player gets 2 on the front row and 3 on the back row. Same again: claim, discuss, vote. One more player is eliminated.
- Ties: if a vote is tied, the players not involved must agree who goes. If they can't agree (or everyone is tied), each tied player draws a ball from the machine and whoever draws a KILLER is out.
- Bin or Win: the 2 finalists' 10 balls plus 1 more KILLER (11 balls) are mixed up face down, so nobody knows which is which. The finalists take turns: one picks a ball to BIN (thrown away), the other picks a ball to WIN (added to the jackpot). Cash won is added to the jackpot; each KILLER won divides the jackpot so far by 10. It ends when 5 balls have been won.
- Split or Steal: the finalists talk, then each secretly chooses SPLIT or STEAL. Both SPLIT: they share the jackpot 50/50. One STEALs: the stealer takes everything and the other gets nothing. Both STEAL: both get nothing. Promises made in conversation are not binding.

THINGS TO KNOW
- Eliminated players' balls leave the game, so who you vote out shapes how much money reaches the final. KILLERs reduce the jackpot.
- Players who seem to hold Killers or little cash are the ones who usually get voted off, because they drag the prize down. That's why bluffs on the show make a back row sound better than it is, not worse.
- Bluffing about your back row is allowed and is part of the show. So is honesty. Your strategy is up to you.
- Your goal is to leave with as much money as possible.

HOW TO RESPOND
Reply with one JSON object and nothing else: no markdown, no code fences. Always include "thoughts": your private reasoning. Other contestants never see it (the TV audience may). Anything in "say" is spoken out loud to everyone: keep it natural and in character, under 60 words.`;
}

export function userPrompt(request: ActionRequest, ctx: AgentContext): string {
  return `THE GAME SO FAR
${transcript(ctx.events, ctx.seat, ctx.players)}

WHERE THINGS STAND
${situation(ctx)}

YOUR TURN
${task(request, ctx)}`;
}

function name(players: PlayerInfo[], seat: number): string {
  return players[seat]?.name ?? `Player ${seat + 1}`;
}

/** Render the events a seat can see as plain text, from that seat's point of view. */
export function transcript(events: GameEvent[], seat: number, players: PlayerInfo[]): string {
  const n = (s: number) => (s === seat ? `${name(players, s)} (you)` : name(players, s));
  const lines: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'host':
        lines.push(`HOST: ${e.text}`);
        break;
      case 'round_started':
        lines.push(
          `--- ${STAGE_TITLES[e.stage]} --- Front rows: ${e.dealt.map((d) => `${n(d.seat)}: ${balls(d.front)}`).join('; ')}.`,
        );
        break;
      case 'back_row':
        lines.push(`(Private) You peek at your back row: ${balls(e.back)}.`);
        break;
      case 'claim':
        lines.push(`${n(e.seat)} claims their back row is ${claimed(e.claim)}.${e.say ? ` ${n(e.seat)}: "${e.say}"` : ''}`);
        break;
      case 'speech':
        lines.push(e.to !== undefined ? `${n(e.seat)} to ${n(e.to)}: "${e.say}"` : `${n(e.seat)}: "${e.say}"`);
        break;
      case 'chat_started':
        lines.push(`--- OPEN FLOOR (${Math.round(e.durationMs / 1000)} seconds to talk) ---`);
        break;
      case 'chat_ended':
        lines.push('--- The floor is closed ---');
        break;
      case 'thoughts':
        if (e.seat === seat && e.thoughts) {
          lines.push(`(Your private thoughts at the time: ${truncate(e.thoughts, 300)})`);
        }
        break;
      case 'votes_revealed':
        lines.push(`Votes: ${e.votes.map((v) => `${n(v.seat)} voted for ${n(v.target)}`).join('; ')}.`);
        break;
      case 'tie':
        lines.push(`The vote is tied between ${describeList(e.tied.map(n))}.`);
        break;
      case 'tie_decision':
        lines.push(
          `Tie-break decisions: ${e.decisions.map((d) => `${n(d.seat)} chose ${n(d.target)}`).join('; ')}. ${e.consensus === null ? 'No agreement.' : `Agreed: ${n(e.consensus)} goes.`}`,
        );
        break;
      case 'tie_draw':
        lines.push(`Tie-break draw: ${e.draws.map((d) => `${n(d.seat)} drew ${describeBall(d.ball)}`).join('; ')}.`);
        break;
      case 'eliminated':
        lines.push(
          `${n(e.seat)} is ELIMINATED. Their back row was really ${balls(e.back)} (they claimed ${claimed(e.claim)}, so they ${e.truthful ? 'told the truth' : 'LIED'}).`,
        );
        break;
      case 'bin_or_win_started':
        lines.push(
          `--- BIN OR WIN --- ${e.ballCount} balls face down. Cash brought into the final: ${e.carried.map((c) => `${n(c.seat)} ${formatMoney(c.amount)}`).join(', ')}.`,
        );
        break;
      case 'ball_picked':
        lines.push(
          `${n(e.seat)} chose ball ${e.index + 1} to ${e.action.toUpperCase()}: ${describeBall(e.ball)}. Jackpot now ${formatMoney(e.jackpot)}.${e.say ? ` ${n(e.seat)}: "${e.say}"` : ''}`,
        );
        break;
      case 'bin_or_win_finished':
        lines.push(`Bin or Win is over. The last ball was ${describeBall(e.leftover)}. Jackpot: ${formatMoney(e.jackpot)}.`);
        break;
      case 'final_started':
        lines.push(`--- SPLIT OR STEAL --- Jackpot: ${formatMoney(e.jackpot)}.`);
        break;
      case 'final_reveal':
        lines.push(`The balls are opened: ${e.choices.map((c) => `${n(c.seat)} chose ${c.choice.toUpperCase()}`).join('; ')}.`);
        break;
      case 'agent_error':
        lines.push(`(${n(e.seat)} fumbled their turn; the host acted for them.)`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

function situation(ctx: AgentContext): string {
  const p = ctx.players;
  const lines: string[] = [`Stage: ${STAGE_TITLES[ctx.stage]}.`];
  lines.push(`Players still in: ${describeList(ctx.activeSeats.map((s) => name(p, s)))}.`);
  if (ctx.stage === 'r1' || ctx.stage === 'r2') {
    lines.push(`Your front row (everyone can see): ${balls(ctx.myFront)}.`);
    lines.push(`Your back row (only you can see): ${balls(ctx.myBack)}.`);
    for (const seat of ctx.activeSeats) {
      if (seat === ctx.seat) continue;
      const claim = ctx.claims[seat];
      lines.push(
        `${name(p, seat)}: front row ${balls(ctx.fronts[seat] ?? [])}; back row ${claim ? `claimed to be ${claimed(claim)}` : 'not announced yet'}.`,
      );
    }
    const mine = ctx.claims[ctx.seat];
    if (mine) lines.push(`You claimed your back row is ${claimed(mine)}.`);
  }
  if (ctx.stage === 'bow' && ctx.board) {
    const open = ctx.board.slots.flatMap((b, i) => (b === null ? [i + 1] : []));
    lines.push(`Face-down balls you can choose from: ${open.join(', ')}.`);
    lines.push(`Won so far: ${balls(ctx.board.won)}. Binned so far: ${balls(ctx.board.binned)}.`);
    lines.push(`Jackpot so far: ${formatMoney(ctx.board.jackpot)}.`);
  }
  if (ctx.stage === 'final' && ctx.jackpot !== undefined) {
    lines.push(`The jackpot is ${formatMoney(ctx.jackpot)}.`);
  }
  return lines.join('\n');
}

function task(request: ActionRequest, ctx: AgentContext): string {
  const p = ctx.players;
  switch (request.kind) {
    case 'claim':
      return `Announce what is on your back row. You have ${request.backCount} hidden balls. You can tell the truth or bluff.
Respond with JSON: {"thoughts": "...", "claimed_back_row": [${request.backCount} items, each a cash amount in pounds as a number like 5000, or "KILLER"], "say": "what you tell the others"}`;
    case 'speak':
      return `${request.prompt}
Respond with JSON: {"thoughts": "...", "say": "..."}`;
    case 'chat': {
      const others = request.participants.filter((s) => s !== ctx.seat).map((s) => name(p, s));
      const purpose =
        ctx.stage === 'final'
          ? `This is your conversation with ${describeList(others)} before you both secretly choose SPLIT or STEAL (jackpot ${formatMoney(ctx.jackpot ?? 0)}).`
          : 'This is the open discussion before the secret vote.';
      const reply =
        request.replyTo !== undefined ? `${name(p, request.replyTo)} just spoke to you directly, so reply to them.\n` : '';
      return `OPEN FLOOR: about ${request.secondsLeft} seconds left. ${purpose}
${reply}Talk to everyone, or to one player by name: question their claims, defend yourself, make a deal, or persuade. Keep it short and natural, like real conversation (under 40 words), and don't repeat yourself. If you have nothing useful to add right now, pass.
Respond with JSON: {"thoughts": "...", "say": "...", "to": "<one player's exact name, or everyone>"}
or, to stay quiet: {"thoughts": "...", "pass": true}`;
    }
    case 'vote': {
      const names = request.candidates.map((s) => `"${name(p, s)}"`).join(', ');
      return `Secretly vote to eliminate one player. You can't vote for yourself. Choose one of: ${names}.
Respond with JSON: {"thoughts": "...", "vote_for": "<exact name>"}`;
    }
    case 'tie_decide': {
      const names = request.candidates.map((s) => `"${name(p, s)}"`).join(', ');
      return `Decide which of the tied players should be eliminated: ${names}. If the deciders don't all agree, the machine picks at random.
Respond with JSON: {"thoughts": "...", "eliminate": "<exact name>"}`;
    }
    case 'pick': {
      const nums = request.available.map((i) => i + 1).join(', ');
      return `Choose a ball to ${request.action.toUpperCase()}${request.action === 'bin' ? ' (throw away)' : ' (add to the jackpot)'}. Available: ${nums}.
The balls are face down and identical, so there is nothing to read: it's pure luck. Go with a hunch, like contestants on the show do ("I've got a good feeling about ball 6").
Respond with JSON: {"thoughts": "...", "ball": <number>, "say": "optional short remark"}`;
    }
    case 'final_choice':
      return `Make your secret choice: SPLIT or STEAL. The jackpot is ${formatMoney(ctx.jackpot ?? 0)}.
Respond with JSON: {"thoughts": "...", "choice": "SPLIT" or "STEAL"}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
