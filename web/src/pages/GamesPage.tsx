import { useCallback, useEffect, useState } from 'react';
import type { GameSummary } from '@gb/shared';
import { GameList } from '../components/GameList';
import { adminKey, api } from '../lib/api';

const PAGE = 30;

export function GamesPage() {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.games(PAGE, offset).then(setGames, (e: unknown) => setError(String(e)));
  }, [offset]);
  useEffect(load, [load]);

  const remove = async (id: string) => {
    if (!confirm('Delete this game? It will also disappear from the leaderboard.')) return;
    try {
      await api.remove(id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <h1>All games</h1>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <GameList games={games} {...(adminKey.get() ? { onDelete: (id: string) => void remove(id) } : {})} />
        <div className="pager">
          <button className="btn btn--small btn--ghost" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
            Newer
          </button>
          <button className="btn btn--small btn--ghost" disabled={games.length < PAGE} onClick={() => setOffset((o) => o + PAGE)}>
            Older
          </button>
        </div>
      </section>
    </div>
  );
}
