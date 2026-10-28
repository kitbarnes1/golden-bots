// Core domain types shared by the server (engine) and the web client.

export type Ball =
  | { id: string; kind: 'cash'; value: number }
  | { id: string; kind: 'killer' };

/** What a player *says* is on one of their hidden balls. */
export type ClaimValue = number | 'killer';

/** r1/r2 = elimination rounds, bow = Bin or Win, final = Split or Steal. */
export type Stage = 'r1' | 'r2' | 'bow' | 'final';

export type PlayerKind = 'ai' | 'human' | 'mock';

export type FinalChoice = 'split' | 'steal';

export type FinalOutcome = 'both_split' | 'one_steal' | 'both_steal';

export interface PlayerInfo {
  seat: number;
  /** Name shown to everyone (including the other contestants). */
  name: string;
  kind: PlayerKind;
  /** OpenRouter model id (ai) or mock strategy id (mock). */
  model?: string;
  /** Human-friendly model label for the UI, e.g. "Claude Sonnet 4.5". */
  modelLabel?: string;
}

export interface GameOptions {
  /** Length of the open-floor chat before each vote, in seconds (0 = no chat). */
  chatSeconds: number;
  /** Length of the finalists' chat before Split or Steal, in seconds (0 = no chat). */
  finalChatSeconds: number;
  /** Chat after each vote, for the players left to react to the result, in seconds (0 = none). */
  reflectSeconds: number;
  /** Most messages in any one chat, so fast models can't run up a big bill. */
  chatMaxMessages: number;
  /** If true, AI contestants are named after their model; otherwise they get show-style first names. */
  revealModelNames: boolean;
  /** With a human seated: after each thing an AI says, wait for them to click Continue. */
  readAtMyPace: boolean;
  /** Native reasoning effort. 'none' turns it off, or as low as the model allows. */
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  /** Seed for the ball machine, for reproducible games. */
  seed: number;
}

export const DEFAULT_OPTIONS: Omit<GameOptions, 'seed'> = {
  chatSeconds: 60,
  finalChatSeconds: 60,
  reflectSeconds: 30,
  chatMaxMessages: 12,
  revealModelNames: true,
  reasoningEffort: 'none',
  readAtMyPace: true,
};

export type BinOrWin = 'bin' | 'win';

export type ActionRequest =
  | { kind: 'claim'; stage: 'r1' | 'r2'; backCount: number }
  | { kind: 'speak'; stage: Stage; context: SpeakContext; prompt: string }
  /** A turn in an open-floor chat. replyTo = someone who just spoke to you. reflect = the chat after a vote. */
  | { kind: 'chat'; stage: Stage; secondsLeft: number; participants: number[]; replyTo?: number; reflect?: boolean }
  | { kind: 'vote'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'tie_decide'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'pick'; action: BinOrWin; available: number[] }
  | { kind: 'final_choice' }
  /**
   * The host's questions on the way out (when: 'eliminated') or after the final.
   * An aside, never part of the game: only AI and mock contestants are asked, and
   * the answers stay out of everyone else's view of the game.
   */
  | {
      kind: 'interview';
      when: 'eliminated' | 'final';
      /** Knocked out: who they can pick as the biggest winner (the players still in). */
      candidates: number[];
      /** Finalists: the other finalist. */
      opponent?: number;
      /** Everyone else in the game, each to be rated for trust. */
      others: number[];
    };

export type SpeakContext = 'tie_plea' | 'tie_discuss' | 'final_reaction';

/** When a finalist says they made up their mind. */
export type DecisionPoint = 'before' | 'r1' | 'r2' | 'bow' | 'final_chat' | 'last_moment';

export const DECISION_POINTS: Record<DecisionPoint, string> = {
  before: 'Before the game',
  r1: 'In round 1',
  r2: 'In round 2',
  bow: 'During Bin or Win',
  final_chat: 'In the final chat',
  last_moment: 'At the last moment',
};

/** How much one player trusted another, 1 (not at all) to 5 (completely). */
export interface TrustRating {
  seat: number;
  score: number;
}

/** Said privately with a vote, about one other player: do they believe that player's back-row claim, and how far do they trust them (1 to 5)? null with no usable answer. */
export interface VoteRating {
  seat: number;
  believes: boolean | null;
  trust: number | null;
}

/** Exit interview answers. null (or missing) where a contestant gave no usable answer. */
export interface InterviewAnswers {
  /** A sentence or two for the audience. */
  say: string;
  /** "Was everything you claimed about your back rows the truth?" */
  claimsTrue: boolean | null;
  /** Knocked out: "Did you see it coming?" */
  sawItComing?: boolean | null;
  /** Knocked out: who they think will leave with the most money (a seat). */
  winnerPick?: number | null;
  /** Knocked out: "What would you do differently?" */
  differently?: string;
  /** Finalists: what they meant to choose when the game began. */
  planned?: FinalChoice | 'undecided' | null;
  /** Finalists: when they made up their mind. */
  decided?: DecisionPoint | null;
  /** Finalists: why they chose as they did. */
  why?: string;
  /** Finalists: how much they trusted the other finalist in Split or Steal, 1 (not at all) to 5 (completely). */
  trust?: number | null;
  /** Everyone: how much they trusted each of the other players over the game, 1 to 5. */
  trustEach?: TrustRating[] | null;
  /** Finalists: knowing what the other chose, would they choose the same again? */
  sameAgain?: boolean | null;
}

export type ActionResponse =
  | { kind: 'claim'; claim: ClaimValue[]; say: string }
  | { kind: 'speak'; say: string }
  /** say = null means "pass": nothing to add right now. to = null means everyone. */
  | { kind: 'chat'; say: string | null; to: number | null }
  /** ratings: AI players' private view of each candidate, left out when they gave none. */
  | { kind: 'vote'; target: number; ratings?: VoteRating[] }
  | { kind: 'tie_decide'; target: number }
  | { kind: 'pick'; index: number; say?: string }
  | { kind: 'final_choice'; choice: FinalChoice }
  | { kind: 'interview'; answers: InterviewAnswers };

export type GameStatus = 'running' | 'finished' | 'abandoned' | 'error';

export interface Payout {
  seat: number;
  amount: number;
}
