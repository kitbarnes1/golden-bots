import { describeBall, describeList, formatMoney, type Ball, type FinalOutcome } from '@gb/shared';
import { pickOne, type Rng } from './rng.js';

/** Template lines for the show's host. Deterministic given the game's RNG. */
export class Host {
  constructor(private readonly rng: Rng) {}

  private one(...lines: string[]): string {
    return pickOne(lines, this.rng);
  }

  welcome(names: string[]): string {
    return this.one(
      `Good evening and welcome to Golden Balls! Tonight's contestants are ${describeList(names)}. One of them could leave with a life-changing sum. Or nothing at all.`,
      `Welcome to Golden Balls, the show where trust is everything and nothing. Please welcome ${describeList(names)}!`,
    );
  }

  round1(): string {
    return 'Twelve cash balls from the Golden Bank, plus four Killers. Each of you has two balls on your front row and two on your back row. Take a peek at your back row, and let nobody else see.';
  }

  round2(): string {
    return 'Your balls go back in the machine with two more cash balls from the Golden Bank and one more Killer. This time you each get two on the front and three on the back. Have a look.';
  }

  askClaims(): string {
    return this.one(
      "Let's hear it. Tell us what's on your back rows. You can tell the truth, or you can lie.",
      'Time to tell everyone what you have on your back row. Remember, nobody can check. Yet.',
    );
  }

  openDiscussion(seconds: number): string {
    return this.one(
      `Somebody here could be lying. The floor is open for ${seconds} seconds: talk it through.`,
      `Who do you believe? Who don't you trust? You've got ${seconds} seconds. Talk to each other.`,
    );
  }

  callVote(): string {
    return 'Time to vote. Secretly choose the player you want to eliminate.';
  }

  tie(tied: string[], deciders: string[]): string {
    if (deciders.length === 0) {
      return `It's a complete tie between ${describeList(tied)}. The machine will decide: each of you draws a ball, and whoever draws the Killer goes home.`;
    }
    return `We have a tie between ${describeList(tied)}. ${describeList(deciders)}, you must agree who goes. If you can't, the machine decides.`;
  }

  noConsensus(): string {
    return "No agreement. It's down to the machine: whoever draws the Killer is out.";
  }

  eliminated(name: string, back: Ball[], truthful: boolean): string {
    const balls = describeList(back.map(describeBall));
    return truthful
      ? `${name}, I'm sorry, you leave with nothing. Your back row was ${balls}. You were telling the truth.`
      : `${name}, you leave with nothing. Your back row was actually ${balls}. You were lying!`;
  }

  binOrWin(first: string, carried: string): string {
    return `Welcome to Bin or Win. Your ten balls plus one more Killer are mixed up. ${first}, you brought the most money into the final (${carried}), so you go first. One of you bins a ball, the other wins a ball, until we have five winners.`;
  }

  binOrWinDone(jackpot: number): string {
    return `That's five balls won. The jackpot stands at ${formatMoney(jackpot)}.`;
  }

  splitOrSteal(jackpot: number, chatSeconds: number): string {
    const talk = chatSeconds > 0 ? ` You have ${chatSeconds} seconds to talk to each other first.` : '';
    return `${formatMoney(jackpot)} is on the table. In front of you are two golden balls: one says SPLIT, one says STEAL.${talk}`;
  }

  chooseNow(): string {
    return 'Make your choice. Pick up a ball, and hold it up when I say so.';
  }

  reveal(outcome: FinalOutcome, jackpot: number, names: [string, string], stealer?: string): string {
    if (outcome === 'both_split') {
      return `You both chose SPLIT! You each take home ${formatMoney(jackpot / 2)}.`;
    }
    if (outcome === 'both_steal') {
      return `You both chose STEAL. ${names[0]} and ${names[1]}, you both leave with nothing.`;
    }
    return `${stealer} chose STEAL and takes home all ${formatMoney(jackpot)}!`;
  }
}
