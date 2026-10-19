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
  /** Most messages in any one chat, so fast models can't run up a big bill. */
  chatMaxMessages: number;
  /** If true, AI contestants are named after their model; otherwise they get show-style first names. */
  revealModelNames: boolean;
  /** Ask OpenRouter for native reasoning at this effort (models that support it). */
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  /** Seed for the ball machine, for reproducible games. */
  seed: number;
}

export const DEFAULT_OPTIONS: Omit<GameOptions, 'seed'> = {
  chatSeconds: 60,
  finalChatSeconds: 60,
  chatMaxMessages: 12,
  revealModelNames: true,
  reasoningEffort: 'none',
};

export type BinOrWin = 'bin' | 'win';

export type ActionRequest =
  | { kind: 'claim'; stage: 'r1' | 'r2'; backCount: number }
  | { kind: 'speak'; stage: Stage; context: SpeakContext; prompt: string }
  /** A turn in an open-floor chat. replyTo = someone who just spoke to you. */
  | { kind: 'chat'; stage: Stage; secondsLeft: number; participants: number[]; replyTo?: number }
  | { kind: 'vote'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'tie_decide'; stage: 'r1' | 'r2'; candidates: number[] }
  | { kind: 'pick'; action: BinOrWin; available: number[] }
  | { kind: 'final_choice' };

export type SpeakContext = 'tie_plea' | 'tie_discuss';

export type ActionResponse =
  | { kind: 'claim'; claim: ClaimValue[]; say: string }
  | { kind: 'speak'; say: string }
  /** say = null means "pass": nothing to add right now. to = null means everyone. */
  | { kind: 'chat'; say: string | null; to: number | null }
  | { kind: 'vote'; target: number }
  | { kind: 'tie_decide'; target: number }
  | { kind: 'pick'; index: number; say?: string }
  | { kind: 'final_choice'; choice: FinalChoice };

export type GameStatus = 'running' | 'finished' | 'abandoned' | 'error';

export interface Payout {
  seat: number;
  amount: number;
}
