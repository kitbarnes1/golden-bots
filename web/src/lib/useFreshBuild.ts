import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * A tab left open across a deploy keeps running the old code. When the reader moves to
 * another page, check (at most once a minute) whether a newer build is out, and if so
 * load that page afresh.
 */
export function useFreshBuild() {
  const { pathname } = useLocation();
  const lastCheck = useRef(Date.now());
  useEffect(() => {
    if (!import.meta.env.PROD || Date.now() - lastCheck.current < 60_000) return;
    lastCheck.current = Date.now();
    const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
    if (!running) return;
    const mine = new URL(running.src).pathname;
    void fetch('/', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => {
        const latest = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
        if (latest && latest !== mine) window.location.reload();
      })
      .catch(() => {});
  }, [pathname]);
}
