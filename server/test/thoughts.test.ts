import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, pairThoughts, type GameEvent, type GameEventBody, type PlayerInfo } from '@gb/shared';
import { GameEngine } from '../src/engine/engine.js';
import { MockAgent } from '../src/agents/mock.js';

/** Number events in order, the way the engine does. */
function log(...bodies: GameEventBody[]): GameEvent[] {
  return bodies.map((b, seq) => ({ ...b, seq, ts: seq, vis: 'public' }) as GameEvent);
}
const thought = (seat: number, action: 'claim' | 'chat' | 'vote' | 'final_choice' | 'pick', text = `${seat} ${action}`): GameEventBody => ({
  type: 'thoughts',
  stage: 'r1',
  seat,
  action,
  thoughts: text,
});

describe('pairThoughts', () => {
  it('puts each thought with the move it explains', () => {
    const events = log(
      thought(0, 'claim'), // 0
      { type: 'claim', stage: 'r1', seat: 0, claim: [5000, 'killer'], say: 'Five grand' }, // 1
      thought(1, 'chat'), // 2
      { type: 'speech', stage: 'r1', seat: 1, say: 'Hmm' }, // 3
      thought(2, 'chat'), // 4
      { type: 'chat_pass', stage: 'r1', seat: 2 }, // 5
    );
    const { byMove, loose } = pairThoughts(events);
    expect(byMove.get('1')?.seq).toBe(0);
    expect(byMove.get('3')?.seq).toBe(2);
    expect(byMove.get('5')?.seq).toBe(4);
    expect(loose.size).toBe(0);
  });

  it('keeps votes and final choices secret until they are revealed', () => {
    const before = log(
      thought(0, 'vote'),
      thought(1, 'vote'),
      { type: 'vote_cast', stage: 'r1', seat: 0 },
      { type: 'vote_revealed', stage: 'r1', seat: 1, target: 2, index: 0, total: 2 }, // 3
    );
    const mid = pairThoughts(before);
    expect(mid.byMove.get('3')?.seat).toBe(1);
    // Seat 0's vote hasn't been read out yet: its thinking stays hidden, not loose.
    expect([...mid.byMove.values()].map((t) => t.seat)).toEqual([1]);
    expect(mid.loose.size).toBe(0);

    const final = log(
      thought(0, 'final_choice'),
      thought(1, 'final_choice'),
      { type: 'choice_locked', seat: 0 },
      { type: 'choice_locked', seat: 1 },
      { type: 'final_reveal', choices: [{ seat: 0, choice: 'split' }, { seat: 1, choice: 'steal' }], outcome: 'one_steal', payouts: [] }, // 4
    );
    const done = pairThoughts(final);
    expect(done.byMove.get('4:0')?.seat).toBe(0);
    expect(done.byMove.get('4:1')?.seat).toBe(1);
    expect(pairThoughts(final.slice(0, 4)).byMove.size).toBe(0);
    expect(pairThoughts(final.slice(0, 4)).loose.size).toBe(0);
  });

  it('pairs votes in games from before they were read out one at a time', () => {
    const events = log(thought(0, 'vote'), thought(1, 'vote'), {
      type: 'votes_revealed',
      stage: 'r1',
      votes: [
        { seat: 0, target: 1 },
        { seat: 1, target: 0 },
      ],
    });
    const { byMove } = pairThoughts(events);
    expect(byMove.get('2:0')?.seat).toBe(0);
    expect(byMove.get('2:1')?.seat).toBe(1);
  });

  it('shows a thought with no move where it happened', () => {
    const events = log(
      thought(2, 'chat', 'cut off by the clock'), // 0: the floor closed before it spoke
      { type: 'chat_ended', stage: 'r1', reason: 'time' },
      thought(2, 'vote'),
      thought(3, 'claim', 'still deciding'), // 3: its claim hasn't arrived yet
    );
    const { byMove, loose } = pairThoughts(events);
    expect([...loose].sort()).toEqual([0, 3]);
    expect(byMove.size).toBe(0);
  });

  it('leaves no thought unplaced in a whole game', async () => {
    const players: PlayerInfo[] = ['Ava', 'Ben', 'Cleo', 'Dev'].map((name, seat) => ({ seat, name, kind: 'mock' }));
    for (const seed of [1, 2, 3, 4, 5]) {
      const events: GameEvent[] = [];
      await new GameEngine({
        players,
        agents: players.map((p) => new MockAgent('mock/chaos', seed + p.seat)),
        options: { ...DEFAULT_OPTIONS, seed, chatSeconds: 1, finalChatSeconds: 1, reflectSeconds: 0 },
        emit: (e) => events.push(e),
      }).run();
      const all = events.filter((e) => e.type === 'thoughts');
      const { byMove, loose } = pairThoughts(events);
      expect(all.length).toBeGreaterThan(0);
      expect(byMove.size + loose.size).toBe(all.length);
      // Every vote's thinking sits with that player's vote being read out.
      for (const e of events) {
        if (e.type === 'vote_revealed') expect(byMove.get(`${e.seq}`)?.seat ?? e.seat).toBe(e.seat);
      }
    }
  });
});
