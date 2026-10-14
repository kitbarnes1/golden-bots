import type { Config } from './config.js';
import type { GameManager, Logger } from './games/manager.js';
import type { ModelCatalog } from './models.js';

/**
 * Optionally starts an all-AI game on a timer with a random lineup, so the
 * leaderboard keeps growing without anyone pressing buttons.
 */
export function startAutoplay(cfg: Config, manager: GameManager, catalog: ModelCatalog, log: Logger): () => void {
  if (cfg.autoplayIntervalMinutes <= 0) return () => {};

  const tick = async () => {
    if (manager.hasRunningAutoplay() || manager.runningCount >= cfg.maxConcurrentGames) return;
    try {
      const available = new Set((await catalog.list()).map((m) => m.id));
      const configured = cfg.autoplayModels.length ? cfg.autoplayModels : cfg.featuredModels;
      const pool = configured.filter((id) => available.has(id));
      if (pool.length === 0) {
        log.warn({}, 'Autoplay: no available models in the pool');
        return;
      }
      const lineup = pickLineup(pool, 4);
      manager.createGame({ seats: lineup.map((model) => ({ kind: 'ai', model })) }, { autoplay: true });
      log.info({ lineup }, 'Autoplay game started');
    } catch (err) {
      log.error({ err }, 'Autoplay failed to start a game');
    }
  };

  const timer = setInterval(() => void tick(), cfg.autoplayIntervalMinutes * 60_000);
  log.info({ everyMinutes: cfg.autoplayIntervalMinutes }, 'Autoplay enabled');
  return () => clearInterval(timer);
}

/** Distinct models where possible; repeats only if the pool is smaller than the table. */
export function pickLineup(pool: string[], size: number, rng: () => number = Math.random): string[] {
  const bag = [...pool];
  const out: string[] = [];
  while (out.length < size) {
    if (bag.length === 0) bag.push(...pool);
    out.push(bag.splice(Math.floor(rng() * bag.length), 1)[0]!);
  }
  return out;
}
