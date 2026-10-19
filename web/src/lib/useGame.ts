import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameDetail, GameEvent, GameStatus, LiveStatus } from '@gb/shared';
import { api } from './api';

export interface GameData {
  detail: GameDetail | null;
  events: GameEvent[];
  status: GameStatus | null;
  waitingOn: number[];
  /** What the players in waitingOn are doing (e.g. 'chat' = typing). */
  waitingAction: string | null;
  /** Server clock minus ours, from the latest live event (for countdowns). */
  clockSkewMs: number;
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
  const [waitingAction, setWaitingAction] = useState<string | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const lastSeq = useRef(-1);

  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let ended = false;
    let source: EventSource | null = null;
    let onVisibility: (() => void) | null = null;
    /** The human player, while their secrets are still being kept from this viewer. */
    let humanSeat: number | undefined;
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
        humanSeat = d.viewer.omniscient ? undefined : d.players.find((p) => p.kind === 'human')?.seat;

        // A player's game pauses while they're away, so let go of it when the tab is hidden.
        if (d.viewer.seat !== undefined) {
          onVisibility = () => {
            if (document.hidden) {
              source?.close();
              source = null;
            } else if (!source && !ended) {
              connect();
            }
          };
          document.addEventListener('visibilitychange', onVisibility);
          if (document.hidden) return;
        }
        connect();
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    function connect() {
      const es = new EventSource(api.streamUrl(id, lastSeq.current));
      source = es;
      es.onopen = () => setConnected(true);
      es.addEventListener('game', (msg) => {
        const event = JSON.parse((msg as MessageEvent<string>).data) as GameEvent;
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        // Events arrive within a moment of being created, so this approximates clock skew.
        setClockSkewMs(event.ts - Date.now());
        setEvents((prev) => [...prev, event]);
        // With the human knocked out there's nothing left to hide: reload for the full story.
        if (event.type === 'eliminated' && event.seat === humanSeat && !cancelled) {
          setTimeout(() => setVersion((n) => n + 1), 300);
        }
      });
      es.addEventListener('status', (msg) => {
        const s = JSON.parse((msg as MessageEvent<string>).data) as LiveStatus;
        if (s.type === 'status') {
          setWaitingOn(s.waitingOn);
          setWaitingAction(s.action);
        }
      });
      es.addEventListener('end', () => {
        ended = true;
        es.close();
        setConnected(false);
        setWaitingOn([]);
        // Re-fetch: finished games reveal everything, including private thoughts.
        if (!cancelled) setTimeout(() => setVersion((n) => n + 1), 300);
      });
      es.onerror = () => setConnected(false);
    }

    return () => {
      cancelled = true;
      source?.close();
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [id, version]);

  return { detail, events, status, waitingOn, waitingAction, clockSkewMs, error, connected, reload };
}
