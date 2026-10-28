import {
  DECISION_POINTS,
  type ActionRequest,
  type ActionResponse,
  type ClaimValue,
  type DecisionPoint,
  type InterviewAnswers,
  type TrustRating,
  type VoteRating,
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
      if (request.kind === 'tie_decide') return { ok: true, value: { kind: 'tie_decide', target } };
      // The ratings are an aside: unusable ones are null, and never make the vote fail.
      const ratings = voteRatings(r.ratings, request.candidates);
      return { ok: true, value: { kind: 'vote', target, ...(ratings ? { ratings } : {}) } };
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
        answers.trust = score1to5(a.trust);
        answers.sameAgain = yesNo(a.sameAgain);
      }
      answers.trustEach = trustRatings(a.trustEach, request.others);
      const answered = Object.values(answers).some((v) => v !== null && v !== '');
      if (!answered) return fail('Answer at least one of the questions.');
      return { ok: true, value: { kind: 'interview', answers } };
    }
  }
}

/** A trust score: 1 to 5, rounded, from a number or a numeric string. */
function score1to5(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : null;
}

/** [{ seat, score }] for the players they were asked about, one each, in seat order; null if none. */
function trustRatings(value: unknown, others: number[]): TrustRating[] | null {
  if (!Array.isArray(value)) return null;
  const bySeat = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { seat, score } = item as Record<string, unknown>;
    const n = score1to5(score);
    if (typeof seat === 'number' && others.includes(seat) && n !== null && !bySeat.has(seat)) bySeat.set(seat, n);
  }
  const ratings = [...bySeat].sort(([a], [b]) => a - b).map(([seat, score]) => ({ seat, score }));
  return ratings.length ? ratings : null;
}

/** One rating per candidate, in their order, with nulls for what's missing or unusable; null if none of it is usable. */
function voteRatings(value: unknown, candidates: number[]): VoteRating[] | null {
  const given = Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
  const ratings = candidates.map((seat) => {
    const r = given.find((g) => g.seat === seat);
    return { seat, believes: yesNo(r?.believes), trust: score1to5(r?.trust) };
  });
  return ratings.some((r) => r.believes !== null || r.trust !== null) ? ratings : null;
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
