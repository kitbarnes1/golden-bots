import {
  describeBall,
  describeClaimValue,
  describeList,
  formatMoney,
  RULES,
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
  return `You are ${me.name}, a contestant on "Golden Bots", a game show based on the British TV show Golden Balls.${identity} Your opponents are ${describeList(others)}. They may be other AI models or humans.

HOW THE GAME WORKS
- Round 1: 12 cash balls (worth £10 to £75,000) from the bank plus 4 KILLER balls are shuffled and dealt, 4 to each of the 4 players: 2 on your front row (everyone can see them) and 2 on your back row (only you can see them). Each player announces what is on their back row. You may tell the truth or lie. After a discussion, everyone secretly votes to eliminate one player. Then everyone's back row is revealed, so everyone sees who lied. The eliminated player leaves with nothing and all of their balls are thrown away.
- Round 2: The 3 survivors' 12 balls go back in the machine with 2 more cash balls and 1 more KILLER (15 balls). Each player gets 2 on the front row and 3 on the back row. Same again: claim, discuss, vote, reveal. One more player is eliminated.
- Ties: if a vote is tied, the players not involved must agree who goes. If they can't agree (or everyone is tied), each tied player draws a ball from the machine and whoever draws a KILLER is out.
- Bin or Win: the 2 finalists' 10 balls from Round 2 (cash, and any KILLERs among them) plus 1 more KILLER (11 balls) are mixed up face down, so nobody knows which is which. The finalists take turns: one picks a ball to BIN (thrown away), the other picks a ball to WIN (added to the jackpot). Cash won is added to the jackpot; each KILLER won divides the jackpot so far by 10. It ends when 5 balls have been won. The jackpot is shared by both finalists until Split or Steal, so binning a KILLER is good news for you both and binning cash throws that money away. Back rows stop mattering here: every ball is in the machine and nobody can tell which is which.
- Split or Steal: the finalists talk, then each secretly chooses SPLIT or STEAL. Both SPLIT: they share the jackpot 50/50. One STEALs: the stealer takes everything and the other gets nothing. Both STEAL: both get nothing. Promises made in conversation are not binding.

THINGS TO KNOW
- Eliminated players' balls leave the game, so who you vote out shapes how much money reaches the final. KILLERs reduce the jackpot.
- Votes usually go against players who seem to hold KILLERs or little cash: keeping them means less money and more KILLERs later on. That's why bluffs on the show make a back row sound better than it is, not worse.
- Big cash claims are good news for everyone's prize if they're true, so the question to ask about them is whether they're believable. Most of the bank is small change: of its 100 balls, 53 are under £1,000 and only 9 are £20,000 or more (just one each of £30,000, £40,000, £50,000, £60,000 and £75,000). Someone caught lying at a reveal has given you a reason not to trust them.
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
        lines.push(`--- ${e.reflect ? 'AFTER THE VOTE' : 'OPEN FLOOR'} (${Math.round(e.durationMs / 1000)} seconds to talk) ---`);
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
      case 'back_rows_revealed':
        lines.push(
          `The others' back rows are revealed: ${e.rows.map((r) => `${n(r.seat)} really had ${balls(r.back)} (claimed ${claimed(r.claim)}, so ${r.truthful ? 'told the truth' : 'LIED'})`).join('; ')}.`,
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
    const others = describeList(ctx.activeSeats.filter((s) => s !== ctx.seat).map((s) => name(p, s)));
    const open = ctx.board.slots.flatMap((b, i) => (b === null ? [i + 1] : []));
    lines.push(
      "Both finalists' balls and one extra KILLER went into the machine and were mixed up face down. Your old back row doesn't matter any more: nobody can tell which ball is which, so there is nothing left to hide.",
    );
    lines.push(`Face-down balls left to choose from: ${open.join(', ')}.`);
    lines.push(`Won so far: ${balls(ctx.board.won)}. Binned so far: ${balls(ctx.board.binned)}.`);
    const inside = machineContents(ctx);
    if (inside) lines.push(inside);
    lines.push(`Jackpot so far: ${formatMoney(ctx.board.jackpot)}, shared by you and ${others} until Split or Steal.`);
  }
  if (ctx.stage === 'final' && ctx.jackpot !== undefined) {
    lines.push(
      `Bin or Win is over and no balls are in play any more. All that matters now is the ${formatMoney(ctx.jackpot)} jackpot and whether you each choose SPLIT or STEAL.`,
    );
  }
  return lines.join('\n');
}

/**
 * What's in (or about to go into) the Bin or Win machine. Every finalist ball
 * has been seen by then (front rows, and back rows revealed after the vote), so
 * it can be listed exactly; models lose track when left to work it out.
 */
function machineBalls(ctx: AgentContext): { list: string; killers: number; count: number } | null {
  const dealt = ctx.events.findLast(
    (e): e is Extract<GameEvent, { type: 'round_started' }> => e.type === 'round_started' && e.stage === 'r2',
  );
  const revealed = ctx.events.findLast(
    (e): e is Extract<GameEvent, { type: 'back_rows_revealed' }> => e.type === 'back_rows_revealed' && e.stage === 'r2',
  );
  if (!dealt || !revealed) return null;
  const key = (b: Ball) => (b.kind === 'killer' ? 'killer' : String(b.value));
  const left = new Map<string, number>();
  const add = (b: Ball, n: number) => left.set(key(b), (left.get(key(b)) ?? 0) + n);
  for (const seat of ctx.activeSeats) {
    for (const b of dealt.dealt.find((d) => d.seat === seat)?.front ?? []) add(b, 1);
    for (const b of revealed.rows.find((r) => r.seat === seat)?.back ?? []) add(b, 1);
  }
  left.set('killer', (left.get('killer') ?? 0) + RULES.bow.extraKillers);
  for (const b of [...(ctx.board?.won ?? []), ...(ctx.board?.binned ?? [])]) add(b, -1);
  const count = [...left.values()].reduce((sum, n) => sum + Math.max(0, n), 0);
  const expected = ctx.board ? ctx.board.slots.filter((b) => b === null).length : count;
  if (count !== expected) return null; // Shouldn't happen; better silent than wrong.
  const killers = left.get('killer') ?? 0;
  const cash = [...left.entries()]
    .filter(([k, n]) => k !== 'killer' && n > 0)
    .flatMap(([k, n]) => Array.from({ length: n }, () => Number(k)))
    .sort((a, b) => a - b)
    .map((v) => formatMoney(v));
  const list = describeList([...cash, ...(killers > 0 ? [`${killers} KILLER${killers === 1 ? '' : 's'}`] : [])]);
  return { list, killers, count };
}

const killerCount = (n: number) => `${n} KILLER${n === 1 ? '' : 's'}`;

function machineContents(ctx: AgentContext): string | null {
  const m = machineBalls(ctx);
  return m
    ? `Everyone has seen every ball by now, so you know what's still in the machine, just not which ball is which: ${m.list} (${killerCount(m.killers)} among ${m.count} balls).`
    : null;
}

/** What the chat after a vote is for, and what comes next. */
function afterVote(ctx: AgentContext): string {
  if (ctx.stage !== 'r2') {
    return "The vote is over and everyone's back row has been revealed. React to that: who was lying, and who you trust now. In Round 2 everyone's balls go back in the machine with some new ones and fresh hands are dealt, so this round's balls won't be yours any more.";
  }
  const other = describeList(ctx.activeSeats.filter((s) => s !== ctx.seat).map((s) => name(ctx.players, s)));
  const m = machineBalls(ctx);
  const inside = m ? ` It will hold ${m.list} (${killerCount(m.killers)} among ${m.count} balls).` : '';
  return `The vote is over: you and ${other} are the finalists. Next comes Bin or Win, which is pure luck: all your balls plus one more KILLER go into the machine face down, so nobody can tell which ball is which or steer it.${inside} After that comes Split or Steal. Talk about the vote and the reveal, about trust, and about the final.`;
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
          : request.reflect
            ? afterVote(ctx)
            : 'This is the open discussion before the secret vote.';
      const reply =
        request.replyTo !== undefined ? `${name(p, request.replyTo)} just spoke to you directly, so reply to them.\n` : '';
      // Spell out what they've said already: models that can't see it in one place say it again.
      const opened = ctx.events.findLastIndex((e) => e.type === 'chat_started');
      const mine = ctx.events.slice(opened + 1).flatMap((e) => (e.type === 'speech' && e.seat === ctx.seat ? [e.say] : []));
      const already = mine.length
        ? `What you've already said in this conversation:\n${mine.map((s) => `- "${s}"`).join('\n')}\nDon't say any of that again, even in other words: anything that repeats it won't be heard.\n`
        : '';
      const done =
        ctx.stage === 'final'
          ? 'Once you have both said what you mean to do, there is nothing to gain by saying it again: pass.'
          : "If you've made your point, pass.";
      return `OPEN FLOOR: about ${request.secondsLeft} seconds left. ${purpose}
${reply}${already}Talk to everyone, or to one player by name: question their claims, defend yourself, make a deal, or persuade. Keep it short and natural, like real conversation (under 40 words), and only speak if you have something new to say. ${done} The conversation ends once everyone passes.
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
      const job =
        request.action === 'bin'
          ? 'BIN. It is thrown away and does not go into the jackpot: binning a KILLER is good news, binning cash loses that money.'
          : 'WIN. It goes into the jackpot you share: cash is added to it, a KILLER divides it by 10.';
      return `Choose a ball to ${job} Available: ${nums}.
The balls are face down and identical, so there is nothing to read: it's pure luck. Go with a hunch, like contestants on the show do ("I've got a good feeling about ball 6").
Respond with JSON: {"thoughts": "...", "ball": <number>, "say": "optional short remark"}`;
    }
    case 'final_choice':
      return `Make your secret choice: SPLIT or STEAL. The jackpot is ${formatMoney(ctx.jackpot ?? 0)}.
Respond with JSON: {"thoughts": "...", "choice": "SPLIT" or "STEAL"}`;
    case 'interview':
      return interviewTask(request, ctx);
  }
}

/** The host's questions on the way out. Nothing said here can change the game, so the model is asked to be candid. */
function interviewTask(request: Extract<ActionRequest, { kind: 'interview' }>, ctx: AgentContext): string {
  const p = ctx.players;
  const candid =
    'Your game is over and nothing you say now can change anything, so answer honestly. The other contestants will not hear this.';
  const others = request.others.map((s) => `"${name(p, s)}"`).join(', ');
  const trustEach = `"trust_each": {"<exact name>": 1 to 5, ...} (how much you trusted each of the other players over the whole game, 1 = not at all, 5 = completely: one score each for ${others})`;
  if (request.when === 'eliminated') {
    const names = request.candidates.map((s) => `"${name(p, s)}"`).join(', ');
    return `EXIT INTERVIEW: you have been voted out and leave with nothing. On your way out, the host asks you a few questions. ${candid}
Respond with JSON: {"thoughts": "...",
 "say": "a sentence or two to the audience about how it went for you",
 "saw_it_coming": true or false (did you expect to be voted out this time?),
 "claims_were_true": true or false (was everything you claimed about your back rows the truth?),
 "would_do_differently": "one short sentence",
 "will_win": "<exact name of the player you think will leave with the most money: one of ${names}>",
 ${trustEach}}`;
  }
  const reveal = ctx.events.findLast((e): e is Extract<GameEvent, { type: 'final_reveal' }> => e.type === 'final_reveal');
  const mine = reveal?.choices.find((c) => c.seat === ctx.seat)?.choice ?? 'split';
  const other = request.opponent ?? reveal?.choices.find((c) => c.seat !== ctx.seat)?.seat ?? 0;
  const theirs = reveal?.choices.find((c) => c.seat === other)?.choice ?? 'split';
  const won = reveal?.payouts.find((x) => x.seat === ctx.seat)?.amount ?? 0;
  return `EXIT INTERVIEW: the game is over. You chose ${mine.toUpperCase()}, ${name(p, other)} chose ${theirs.toUpperCase()}, and you leave with ${formatMoney(won)}. The host asks you a few questions. ${candid}
Respond with JSON: {"thoughts": "...",
 "say": "a sentence or two to the audience about how it went for you",
 "planned_at_start": "SPLIT", "STEAL" or "UNDECIDED" (what you meant to choose in the final when the game began),
 "decided_when": one of "before the game", "round 1", "round 2", "bin or win", "final chat", "last moment" (when you made up your mind),
 "why": "what made you choose ${mine.toUpperCase()}, in a sentence",
 "trust": 1 to 5 (how much you trusted ${name(p, other)} in Split or Steal: 1 = not at all, 5 = completely),
 "same_again": true or false (knowing what ${name(p, other)} chose, would you make the same choice again?),
 "claims_were_true": true or false (was everything you claimed about your back rows the truth?),
 ${trustEach}}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
