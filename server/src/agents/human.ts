import type { ActionRequest } from '@gb/shared';
import { validateResponse } from '../engine/validate.js';
import type { ActMeta, Agent, AgentContext, AgentResult } from './types.js';

interface Pending {
  requestId: string;
  request: ActionRequest;
  resolve: (result: AgentResult) => void;
  timer: NodeJS.Timeout;
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
      const timer = setTimeout(() => {
        this.pending = null;
        this.autopilotEngaged = true;
        void this.autopilot.act(request, ctx, meta).then(
          (r) => resolve({ ...r, thoughts: undefined, timedOut: true }),
          () => resolve({ response: null, timedOut: true }),
        );
      }, this.timeoutMs);
      this.pending = { requestId: meta.requestId, request, resolve, timer };
      meta.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.pending = null;
        resolve({ response: null });
      });
    });
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
