import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameDetail, GameEvent, GameStatus, LiveStatus } from '@gb/shared';
import { api } from './api';

export interface GameData {
  detail: GameDetail | null;
  events: GameEvent[];
  status: GameStatus | null;
  waitingOn: number[];
  error: string | null;
  connected: boolean;
  reload: () => void;
}

/** Loads a game and, while it's running, follows it live over SSE. */
export function useGame(id: string): GameData {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [status, setStatus] = useState<GameStatus | null>(null);
  const [waitingOn, setWaitingOn] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(-1);

  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    lastSeq.current = -1;

    api
      .game(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setEvents(d.events);
        setStatus(d.status);
        setError(null);
        lastSeq.current = d.events.at(-1)?.seq ?? -1;
        if (d.status !== 'running') return;

        source = new EventSource(api.streamUrl(id, lastSeq.current));
        source.onopen = () => setConnected(true);
        source.addEventListener('game', (msg) => {
          const event = JSON.parse((msg as MessageEvent<string>).data) as GameEvent;
          if (event.seq <= lastSeq.current) return;
          lastSeq.current = event.seq;
          setEvents((prev) => [...prev, event]);
        });
        source.addEventListener('status', (msg) => {
          const s = JSON.parse((msg as MessageEvent<string>).data) as LiveStatus;
          if (s.type === 'status') setWaitingOn(s.waitingOn);
        });
        source.addEventListener('end', () => {
          source?.close();
          setConnected(false);
          setWaitingOn([]);
          // Re-fetch: finished games reveal everything, including private thoughts.
          if (!cancelled) setTimeout(() => setVersion((n) => n + 1), 300);
        });
        source.onerror = () => setConnected(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [id, version]);

  return { detail, events, status, waitingOn, error, connected, reload };
}
