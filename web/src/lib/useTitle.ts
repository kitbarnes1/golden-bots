import { useEffect } from 'react';

const SITE = 'Golden Bots';

/** Names the browser tab after the page being shown ("Leaderboard · Golden Bots"), so tabs and history can be told apart. */
export function useTitle(page?: string | null): void {
  useEffect(() => {
    document.title = page ? `${page} · ${SITE}` : SITE;
  }, [page]);
}
