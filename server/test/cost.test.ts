import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, ESTIMATE_RANGE, estimateSeatCost, formatUsd, type ModelOption } from '@gb/shared';

const model = (id: string, promptPrice: number, completionPrice: number, extra: Partial<ModelOption> = {}): ModelOption => ({
  id,
  name: id,
  featured: false,
  promptPrice,
  completionPrice,
  ...extra,
});

describe('game cost estimate', () => {
  it('prices a seat from the model and the tokens a seat really uses', () => {
    // 75k in at $2/M + 4k out at $10/M
    expect(estimateSeatCost(model('google/gemini-4-argon', 2, 10), DEFAULT_OPTIONS)).toBeCloseTo(0.19, 5);
    expect(estimateSeatCost(model('x/free', 0, 0, { free: true }), DEFAULT_OPTIONS)).toBe(0);
    expect(estimateSeatCost(undefined, DEFAULT_OPTIONS)).toBeNull();
    expect(estimateSeatCost({ id: 'x/unpriced', name: 'x', featured: false }, DEFAULT_OPTIONS)).toBeNull();
  });

  it('lands near what a real game cost', () => {
    // Game 17bb4b94: Gemini 4 Argon, Qwen3.8 Omni Flash, Llama 4 Maverick, Claude Haiku 5.5 cost $0.27.
    const table = [model('a', 2, 10), model('b', 0.15, 0.47), model('c', 0.19, 0.65), model('d', 0.1, 0.5)];
    const total = table.reduce((sum, m) => sum + estimateSeatCost(m, DEFAULT_OPTIONS)!, 0);
    expect(0.27).toBeGreaterThan(total * ESTIMATE_RANGE.low);
    expect(0.27).toBeLessThan(total * ESTIMATE_RANGE.high);
  });

  it('follows the chat options and reasoning', () => {
    const m = model('a', 2, 10, { supportsReasoning: true });
    const base = estimateSeatCost(m, DEFAULT_OPTIONS)!;
    const noChat = estimateSeatCost(m, { ...DEFAULT_OPTIONS, chatSeconds: 0, reflectSeconds: 0, finalChatSeconds: 0 })!;
    expect(noChat).toBeCloseTo(base / 2, 5);
    expect(estimateSeatCost(m, { ...DEFAULT_OPTIONS, chatMaxMessages: 24 })!).toBeGreaterThan(base);
    expect(estimateSeatCost(m, { ...DEFAULT_OPTIONS, reasoningEffort: 'medium' })!).toBeGreaterThan(base);
  });

  it('formats small amounts readably', () => {
    expect([0, 0.0004, 0.0123, 0.005, 0.19, 1.5].map(formatUsd)).toEqual(['$0', 'under $0.001', '$0.01', '$0.005', '$0.19', '$1.50']);
  });
});
