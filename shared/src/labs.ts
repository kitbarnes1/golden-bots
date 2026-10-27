import type { LeaderboardRow, ModelFacts, ModelOption } from './api.js';

/**
 * Model creators by their OpenRouter id prefix, with where they're based.
 * Countries are left out where we aren't sure. Corrections welcome.
 */
const LABS: Record<string, { name: string; country?: string }> = {
  openai: { name: 'OpenAI', country: 'United States' },
  anthropic: { name: 'Anthropic', country: 'United States' },
  google: { name: 'Google', country: 'United States' },
  'meta-llama': { name: 'Meta', country: 'United States' },
  meta: { name: 'Meta', country: 'United States' },
  'x-ai': { name: 'xAI', country: 'United States' },
  nvidia: { name: 'NVIDIA', country: 'United States' },
  microsoft: { name: 'Microsoft', country: 'United States' },
  amazon: { name: 'Amazon', country: 'United States' },
  perplexity: { name: 'Perplexity', country: 'United States' },
  'ibm-granite': { name: 'IBM', country: 'United States' },
  thinkingmachines: { name: 'Thinking Machines', country: 'United States' },
  nousresearch: { name: 'Nous Research', country: 'United States' },
  liquid: { name: 'Liquid AI', country: 'United States' },
  inception: { name: 'Inception', country: 'United States' },
  writer: { name: 'Writer', country: 'United States' },
  'arcee-ai': { name: 'Arcee AI', country: 'United States' },
  allenai: { name: 'Ai2', country: 'United States' },
  mistralai: { name: 'Mistral AI', country: 'France' },
  cohere: { name: 'Cohere', country: 'Canada' },
  deepseek: { name: 'DeepSeek', country: 'China' },
  qwen: { name: 'Qwen (Alibaba)', country: 'China' },
  'z-ai': { name: 'Z.ai', country: 'China' },
  moonshotai: { name: 'Moonshot AI', country: 'China' },
  minimax: { name: 'MiniMax', country: 'China' },
  tencent: { name: 'Tencent', country: 'China' },
  'bytedance-seed': { name: 'ByteDance', country: 'China' },
  bytedance: { name: 'ByteDance', country: 'China' },
  xiaomi: { name: 'Xiaomi', country: 'China' },
  stepfun: { name: 'StepFun', country: 'China' },
  meituan: { name: 'Meituan', country: 'China' },
  baidu: { name: 'Baidu', country: 'China' },
  inclusionai: { name: 'inclusionAI (Ant Group)', country: 'China' },
  upstage: { name: 'Upstage', country: 'South Korea' },
  sakana: { name: 'Sakana AI', country: 'Japan' },
  ai21: { name: 'AI21 Labs', country: 'Israel' },
  poolside: { name: 'Poolside' },
  'dots-studio': { name: 'Dots Studio' },
};

/** Open-weight models OpenRouter doesn't link to a Hugging Face repo (yet), by id without ":free". */
const OPEN_WEIGHTS: Record<string, boolean> = {
  'dots-studio/dots-3-note-preview': true, // "an open-weight mixture-of-experts model", per OpenRouter
};

/** "openai/gpt-5:free" -> "openai". Aliases like "~openai/..." count as the same creator. */
export function labId(modelId: string): string {
  return (modelId.split('/')[0] ?? modelId).replace(/^~/, '');
}

/** What we know about a model: from its id alone, plus OpenRouter's catalogue entry if there is one. */
export function modelFacts(modelId: string, listed?: Pick<ModelOption, 'openWeights' | 'released'>): ModelFacts {
  const lab = labId(modelId);
  const known = LABS[lab];
  const override = OPEN_WEIGHTS[modelId.replace(/:free$/, '')];
  return {
    lab,
    labName: known?.name ?? lab.replace(/(^|[-_])(\w)/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase()),
    country: known?.country ?? null,
    openWeights: override ?? (listed ? listed.openWeights === true : null),
    released: listed?.released ?? null,
  };
}

export type GroupBy = 'model' | 'lab' | 'country' | 'openness' | 'generation';

/** Released this recently counts as current. */
export const RECENT_MS = 183 * 24 * 60 * 60_000;

/** Which group a contestant falls in, and what to call it. `after` orders the groups that go at the end: not known, then humans, then bots. */
function groupOf(row: LeaderboardRow, by: Exclude<GroupBy, 'model'>, now: number): { id: string; label: string; after?: number } {
  if (row.kind === 'human') return { id: 'humans', label: 'Human players', after: 2 };
  if (row.kind === 'mock') return { id: 'mocks', label: 'Mock bots', after: 3 };
  const f = row.facts ?? modelFacts(row.key);
  switch (by) {
    case 'lab':
      return { id: f.lab, label: f.labName };
    case 'country':
      return f.country ? { id: f.country, label: f.country } : { id: 'unknown', label: 'Not known', after: 1 };
    case 'openness':
      return f.openWeights === null
        ? { id: 'unknown', label: 'Not known', after: 1 }
        : f.openWeights
          ? { id: 'open', label: 'Open weights' }
          : { id: 'closed', label: 'Closed (commercial)' };
    case 'generation':
      return f.released === null
        ? { id: 'unknown', label: 'Not known', after: 1 }
        : now - f.released <= RECENT_MS
          ? { id: 'recent', label: 'Released in the last 6 months' }
          : { id: 'older', label: 'Older' };
  }
}

/**
 * Add up contestants into groups (by creator, country, open or closed weights,
 * or how recent). Counts are summed over every seat played, so a game with two
 * OpenAI models counts twice for OpenAI; averages are recomputed from the sums.
 */
export function groupRows(rows: LeaderboardRow[], by: GroupBy, now = Date.now()): LeaderboardRow[] {
  if (by === 'model') return rows;
  const groups = new Map<string, { row: LeaderboardRow; after: number }>();
  for (const r of rows) {
    const g = groupOf(r, by, now);
    const key = `${by}:${g.id}`;
    const existing = groups.get(key);
    if (!existing) {
      const { facts: _facts, ...rest } = r;
      groups.set(key, { row: { ...rest, key, label: g.label, members: [r.label] }, after: g.after ?? 0 });
      continue;
    }
    const t = existing.row;
    for (const k of SUMMED) t[k] += r[k];
    t.bestWin = Math.max(t.bestWin, r.bestWin);
    t.lastPlayed = Math.max(t.lastPlayed, r.lastPlayed);
    t.members!.push(r.label);
  }
  return [...groups.values()]
    .map(({ row, after }) => ({ row: { ...row, avgWinnings: row.games ? row.totalWinnings / row.games : 0 }, after }))
    .sort((a, b) => a.after - b.after || b.row.avgWinnings - a.row.avgWinnings)
    .map(({ row }) => row);
}

const SUMMED = [
  'games',
  'finals',
  'totalWinnings',
  'r1Eliminations',
  'r2Eliminations',
  'splits',
  'steals',
  'sharedPots',
  'stoleWins',
  'gotStolenFrom',
  'mutualSteals',
  'claims',
  'truthfulClaims',
  'votesReceived',
  'invalidResponses',
  'costUsd',
] as const satisfies readonly (keyof LeaderboardRow)[];
