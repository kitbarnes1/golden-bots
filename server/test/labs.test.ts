import { describe, expect, it } from 'vitest';
import { groupRows, labId, modelFacts, RECENT_MS, type LeaderboardRow, type ModelFacts } from '@gb/shared';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 27);

function row(key: string, label: string, stats: Partial<LeaderboardRow> = {}, facts?: Partial<ModelFacts>): LeaderboardRow {
  const kind = key.startsWith('human:') ? 'human' : key.startsWith('mock/') ? 'mock' : 'ai';
  return {
    key,
    label,
    kind,
    games: 1,
    finals: 0,
    totalWinnings: 0,
    avgWinnings: 0,
    bestWin: 0,
    r1Eliminations: 0,
    r2Eliminations: 0,
    splits: 0,
    steals: 0,
    sharedPots: 0,
    stoleWins: 0,
    gotStolenFrom: 0,
    mutualSteals: 0,
    claims: 0,
    truthfulClaims: 0,
    votesReceived: 0,
    invalidResponses: 0,
    costUsd: 0,
    lastPlayed: 0,
    interviews: 0,
    liedInterviews: 0,
    ownedUp: 0,
    sawItAsked: 0,
    sawItComing: 0,
    winnerPicks: 0,
    winnerRight: 0,
    plansGiven: 0,
    plannedSteal: 0,
    planChecks: 0,
    stuckToPlan: 0,
    againAsked: 0,
    sameAgain: 0,
    trustScores: 0,
    trustTotal: 0,
    ...stats,
    ...(kind === 'ai' ? { facts: { ...modelFacts(key), ...facts } } : {}),
  };
}

describe('model facts', () => {
  it('knows creators by the start of the model id, aliases included', () => {
    expect(labId('openai/gpt-6.1-terra')).toBe('openai');
    expect(labId('~anthropic/claude-latest')).toBe('anthropic');
    expect(modelFacts('meta-llama/llama-4-maverick')).toMatchObject({ lab: 'meta-llama', labName: 'Meta', country: 'United States' });
    expect(modelFacts('deepseek/deepseek-v4.1-flash:free')).toMatchObject({ labName: 'DeepSeek', country: 'China' });
    expect(modelFacts('mistralai/mistral-large-4-0').country).toBe('France');
    // Unknown creators get a readable name and no country, rather than a guess.
    expect(modelFacts('some-new_lab/model')).toMatchObject({ labName: 'Some New Lab', country: null });
    expect(modelFacts('poolside/laguna-s-2.1').country).toBeNull();
  });

  it('takes openness and release date from the catalogue, with corrections', () => {
    expect(modelFacts('x/y')).toMatchObject({ openWeights: null, released: null });
    expect(modelFacts('x/y', { openWeights: true, released: 123 })).toMatchObject({ openWeights: true, released: 123 });
    expect(modelFacts('x/y', {})).toMatchObject({ openWeights: false });
    // Described as open-weight by its maker, though OpenRouter lists no Hugging Face repo.
    expect(modelFacts('dots-studio/dots-3-note-preview:free', { openWeights: false }).openWeights).toBe(true);
  });
});

describe('groupRows', () => {
  const rows = [
    row('openai/a', 'GPT A', { games: 2, totalWinnings: 1000, bestWin: 900, splits: 1, steals: 1, claims: 4, truthfulClaims: 3, costUsd: 0.5, lastPlayed: 5 }, { openWeights: false, released: NOW - 30 * DAY }),
    row('openai/b', 'GPT B', { games: 1, totalWinnings: 500, bestWin: 500, claims: 2, truthfulClaims: 2, costUsd: 0.25, lastPlayed: 9 }, { openWeights: true, released: NOW - 400 * DAY }),
    row('anthropic/c', 'Claude C', { games: 3, totalWinnings: 300, bestWin: 300 }, { openWeights: false, released: NOW - 10 * DAY }),
    row('deepseek/d', 'DeepSeek D', { games: 2, totalWinnings: 4000, bestWin: 4000 }, { openWeights: true }),
    row('mystery/e', 'Mystery E', { games: 1 }, { openWeights: null, released: null }),
    row('human:kit', 'Kit', { games: 1, totalWinnings: 9999 }),
    row('mock/honest', 'Honest Abe', { games: 4 }),
  ];

  it('leaves the rows alone when grouping by model', () => {
    expect(groupRows(rows, 'model')).toBe(rows);
  });

  it('adds up each creator, recomputing averages, with humans and bots last', () => {
    const byLab = groupRows(rows, 'lab', NOW);
    const openai = byLab.find((r) => r.label === 'OpenAI')!;
    expect(openai).toMatchObject({ key: 'lab:openai', games: 3, totalWinnings: 1500, avgWinnings: 500, bestWin: 900, splits: 1, steals: 1, claims: 6, truthfulClaims: 5, costUsd: 0.75, lastPlayed: 9 });
    expect(openai.members).toEqual(['GPT A', 'GPT B']);
    expect(openai.facts).toBeUndefined();
    expect(byLab.map((r) => r.label)).toEqual(['DeepSeek', 'OpenAI', 'Anthropic', 'Mystery', 'Human players', 'Mock bots']);
  });

  it('groups by country, openness and how new, putting what we don’t know last', () => {
    const byCountry = groupRows(rows, 'country', NOW);
    expect(byCountry.find((r) => r.label === 'United States')!.members).toEqual(['GPT A', 'GPT B', 'Claude C']);
    expect(byCountry.find((r) => r.label === 'China')!.members).toEqual(['DeepSeek D']);
    expect(byCountry.at(-3)!.label).toBe('Not known');

    const byOpenness = groupRows(rows, 'openness', NOW);
    expect(byOpenness.find((r) => r.label === 'Open weights')!.members).toEqual(['GPT B', 'DeepSeek D']);
    expect(byOpenness.find((r) => r.label === 'Closed (commercial)')!.members).toEqual(['GPT A', 'Claude C']);
    expect(byOpenness.find((r) => r.label === 'Not known')!.members).toEqual(['Mystery E']);

    const byAge = groupRows(rows, 'generation', NOW);
    expect(byAge.find((r) => r.label === 'Released in the last 6 months')!.members).toEqual(['GPT A', 'Claude C']);
    expect(byAge.find((r) => r.label === 'Older')!.members).toEqual(['GPT B']);
    expect(byAge.find((r) => r.label === 'Not known')!.members).toEqual(['DeepSeek D', 'Mystery E']);
    expect(RECENT_MS).toBeGreaterThan(180 * DAY);
  });
});
