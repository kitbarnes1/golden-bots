import type { ActionRequest } from '@gb/shared';
import { validateResponse } from '../engine/validate.js';
import type { ActMeta, Agent, AgentContext, AgentResult } from './types.js';

interface Pending {
  requestId: string;
  request: ActionRequest;
  resolve: (result: AgentResult) => void;
  timer: NodeJS.Timeout;
  /** When autopilot takes over. */
  deadline: number;
  /** Time left on the clock while the game is paused. */
  frozenMs?: number;
  expire: () => void;
}

export type SubmitResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

/**
 * A contestant played by a person in the browser. The engine publishes an
 * awaiting_input event; the person answers via the API, which calls submit().
 * If they don't answer in time, autopilot plays for them from then on.
 */
export class HumanAgent implements Agent {
  readonly interactive = true;
  private pending: Pending | null = null;
  private autopilotEngaged = false;

  constructor(
    private readonly autopilot: Agent,
    private readonly timeoutMs: number,
  ) {}

  get waitingFor(): { requestId: string; request: ActionRequest } | null {
    return this.pending ? { requestId: this.pending.requestId, request: this.pending.request } : null;
  }

  async act(request: ActionRequest, ctx: AgentContext, meta: ActMeta): Promise<AgentResult> {
    if (this.autopilotEngaged) {
      return { ...(await this.autopilot.act(request, ctx, meta)), thoughts: undefined, timedOut: true };
    }
    return new Promise<AgentResult>((resolve) => {
      const expire = () => {
        this.pending = null;
        this.autopilotEngaged = true;
        void this.autopilot.act(request, ctx, meta).then(
          (r) => resolve({ ...r, thoughts: undefined, timedOut: true }),
          () => resolve({ response: null, timedOut: true }),
        );
      };
      const pending: Pending = {
        requestId: meta.requestId,
        request,
        resolve,
        expire,
        deadline: Date.now() + this.timeoutMs,
        timer: setTimeout(expire, this.timeoutMs),
      };
      this.pending = pending;
      meta.signal.addEventListener('abort', () => {
        clearTimeout(pending.timer);
        this.pending = null;
        resolve({ response: null });
      });
    });
  }

  /** The game is paused while this person is away: stop the clock on their move. */
  pause(): void {
    const p = this.pending;
    if (!p || p.frozenMs !== undefined) return;
    clearTimeout(p.timer);
    p.frozenMs = Math.max(0, p.deadline - Date.now());
  }

  resume(): void {
    const p = this.pending;
    if (!p || p.frozenMs === undefined) return;
    p.deadline = Date.now() + p.frozenMs;
    p.timer = setTimeout(p.expire, p.frozenMs);
    delete p.frozenMs;
  }

  submit(requestId: string, response: unknown): SubmitResult {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) {
      return { ok: false, status: 409, error: 'That move is no longer expected.' };
    }
    const valid = validateResponse(pending.request, response);
    if (!valid.ok) return { ok: false, status: 400, error: valid.error };
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve({ response: valid.value });
    return { ok: true };
  }
}
