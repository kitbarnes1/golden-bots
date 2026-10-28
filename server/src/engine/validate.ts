import {
  DECISION_POINTS,
  type ActionRequest,
  type ActionResponse,
  type ClaimValue,
  type DecisionPoint,
  type InterviewAnswers,
} from '@gb/shared';

export const MAX_SAY_LENGTH = 600;
export const MAX_CLAIM_VALUE = 75_000;

export type Validation = { ok: true; value: ActionResponse } | { ok: false; error: string };

const fail = (error: string): Validation => ({ ok: false, error });

export function cleanSay(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_SAY_LENGTH ? `${text.slice(0, MAX_SAY_LENGTH - 1)}…` : text;
}

/** Accepts 5000, "5000", "£5,000", "5k", "killer", "KILLER". */
export function parseClaimValue(value: unknown): ClaimValue | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= MAX_CLAIM_VALUE
      ? Math.round(value * 100) / 100
      : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text.includes('killer')) return 'killer';
  const match = text.replace(/[£,\s]/g, '').match(/^(\d+(?:\.\d+)?)(k)?$/);
  if (!match) return null;
  const amount = Number(match[1]) * (match[2] ? 1000 : 1);
  return parseClaimValue(amount);
}

/**
 * Checks a (possibly untrusted) response against the request it answers and
 * normalises it. Used for model output and for human submissions alike.
 */
export function validateResponse(request: ActionRequest, raw: unknown): Validation {
  if (!raw || typeof raw !== 'object') return fail('Response must be an object.');
  const r = raw as Record<string, unknown>;

  switch (request.kind) {
    case 'claim': {
      if (!Array.isArray(r.claim)) return fail('claim must be a list of values.');
      if (r.claim.length !== request.backCount) {
        return fail(`You must claim exactly ${request.backCount} values, one per back-row ball.`);
      }
      const claim: ClaimValue[] = [];
      for (const v of r.claim) {
        const parsed = parseClaimValue(v);
        if (parsed === null) {
          return fail(`"${String(v)}" is not a valid ball. Use a cash amount up to £75,000 or "KILLER".`);
        }
        claim.push(parsed);
      }
      return { ok: true, value: { kind: 'claim', claim, say: cleanSay(r.say) } };
    }
    case 'speak': {
      const say = cleanSay(r.say);
      if (!say) return fail('say must be a non-empty string.');
      return { ok: true, value: { kind: 'speak', say } };
    }
    case 'chat': {
      // An empty message (or an explicit pass) means "nothing to add right now".
      const say = r.pass === true ? '' : cleanSay(r.say);
      const to = typeof r.to === 'number' && request.participants.includes(r.to) ? r.to : null;
      return { ok: true, value: { kind: 'chat', say: say || null, to: say ? to : null } };
    }
    case 'vote':
    case 'tie_decide': {
      const target = typeof r.target === 'string' ? Number(r.target) : r.target;
      if (typeof target !== 'number' || !request.candidates.includes(target)) {
        return fail('target must be one of the listed players.');
      }
      return { ok: true, value: { kind: request.kind, target } };
    }
    case 'pick': {
      const index = typeof r.index === 'string' ? Number(r.index) : r.index;
      if (typeof index !== 'number' || !request.available.includes(index)) {
        return fail('That ball is not available to pick.');
      }
      const say = cleanSay(r.say);
      return { ok: true, value: { kind: 'pick', index, ...(say ? { say } : {}) } };
    }
    case 'final_choice': {
      const choice = typeof r.choice === 'string' ? r.choice.trim().toLowerCase() : '';
      if (choice !== 'split' && choice !== 'steal') return fail('choice must be "split" or "steal".');
      return { ok: true, value: { kind: 'final_choice', choice } };
    }
    case 'interview': {
      // An answer that has already been checked once (the LLM agent checks its own) keeps its
      // fields under `answers`, and must pass again as it is.
      const a = r.kind === 'interview' && r.answers && typeof r.answers === 'object' ? (r.answers as Record<string, unknown>) : r;
      const answers: InterviewAnswers = { say: cleanSay(a.say), claimsTrue: yesNo(a.claimsTrue) };
      if (request.when === 'eliminated') {
        answers.sawItComing = yesNo(a.sawItComing);
        answers.winnerPick = typeof a.winnerPick === 'number' && request.candidates.includes(a.winnerPick) ? a.winnerPick : null;
        answers.differently = cleanSay(a.differently);
      } else {
        const planned = typeof a.planned === 'string' ? a.planned.trim().toLowerCase() : '';
        answers.planned = planned === 'split' || planned === 'steal' || planned === 'undecided' ? planned : null;
        answers.decided = decisionPoint(a.decided);
        answers.why = cleanSay(a.why);
        const trust = typeof a.trust === 'string' ? Number(a.trust) : a.trust;
        answers.trust = typeof trust === 'number' && Number.isFinite(trust) ? Math.min(5, Math.max(1, Math.round(trust))) : null;
        answers.sameAgain = yesNo(a.sameAgain);
      }
      const answered = Object.values(answers).some((v) => v !== null && v !== '');
      if (!answered) return fail('Answer at least one of the questions.');
      return { ok: true, value: { kind: 'interview', answers } };
    }
  }
}

/** true/false, or "yes"/"no" in words. */
function yesNo(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (/^(yes|y|true)\b/.test(v)) return true;
  if (/^(no|n|false)\b/.test(v)) return false;
  return null;
}

/** "round 2", "Bin or Win", "the last moment"... to a DecisionPoint. */
function decisionPoint(value: unknown): DecisionPoint | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v in DECISION_POINTS) return v as DecisionPoint;
  if (/before|start|beginning/.test(v)) return 'before';
  if (/round ?1|r1|first round/.test(v)) return 'r1';
  if (/round ?2|r2|second round/.test(v)) return 'r2';
  if (/bin/.test(v)) return 'bow';
  if (/chat|talk|conversation/.test(v)) return 'final_chat';
  if (/last|moment|end/.test(v)) return 'last_moment';
  return null;
}
