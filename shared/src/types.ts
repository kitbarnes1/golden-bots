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
  /** Open discussion passes (each active player speaks once per pass) before each vote. */
  discussionPasses: number;
  /** Conversation passes before the Split or Steal decision. */
  finalDiscussionPasses: number;
  /** If true, AI contestants are named after their model; otherwise they get show-style first names. */
  revealModelNames: boolean;
  /** Ask OpenRouter for native reasoning at this effort (models that support it). */
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  /** Seed for the ball machine, for reproducible games. */
  seed: number;
}

export const DEFAULT_OPTIONS: Omit<GameOptions, 'seed'> = {
  discussionPasses: 1,
  finalDiscussionPasses: 2,
  revealModelNames: true,
  reasoningEffort: 'none',
};

export type BinOrWin = 'bin' | 'win';

export type ActionRequest =
  | { kind: 'claim'; stage: 'r1' | 'r2'; backCount: number }
  | { kind: 'speak'; stage: Stage; context: SpeakContext; prompt: string }
  | { kind: 'vote'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'tie_decide'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'pick'; action: BinOrWin; available: number[] }
  | { kind: 'final_choice' };

export type SpeakContext = 'discussion' | 'tie_plea' | 'tie_discuss' | 'final';

export type ActionResponse =
  | { kind: 'claim'; claim: ClaimValue[]; say: string }
  | { kind: 'speak'; say: string }
  | { kind: 'vote'; target: number }
  | { kind: 'tie_decide'; target: number }
  | { kind: 'pick'; index: number; say?: string }
  | { kind: 'final_choice'; choice: FinalChoice };

export type GameStatus = 'running' | 'finished' | 'abandoned' | 'error';

export interface Payout {
  seat: number;
  amount: number;
}
