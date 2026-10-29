import type { GameEvent } from './events.js';

// Promise keeping in Split or Steal: did a finalist tell the other they'd split,
// and then steal? Read from what they said in the last chat, before the balls
// were opened. It's a plain text check rather than a model, so it scores every
// game ever played (no prompt needed) and the same line always scores the same.
//
// It looks for the speaker committing themselves: "I'll split", "I'm splitting",
// "I'm going SPLIT", "I promise to split", "let's split", "Split it is", "my
// hand is on SPLIT", and "I'd never steal from you" (there are only two balls).
// "I split if you split" counts: it's the classic pledge, and the other player
// takes it as one. Questions, hedges ("maybe I'll split"), other conditions
// ("I'll split if I can trust you"), and lines about what the other player said
// or should do don't count.

/** Does this line commit the speaker to choosing Split? */
export function promisesSplit(say: string): boolean {
  return sentences(normalise(say)).some(promiseIn);
}

/**
 * The finalists who told the other they'd split, in the final chat before the
 * reveal, each with the first line that did. What they say after the reveal
 * ("I'm choosing Split" said in hindsight) doesn't count.
 */
export function splitPromises(events: readonly GameEvent[]): Map<number, string> {
  const promised = new Map<number, string>();
  for (const e of events) {
    if (e.type === 'final_reveal') break;
    if (e.type === 'speech' && e.stage === 'final' && !promised.has(e.seat) && promisesSplit(e.say)) promised.set(e.seat, e.say);
  }
  return promised;
}

const r = String.raw;

/** "split", but not "split or steal". */
const SPLIT = r`split\b(?![\s,]*(?:or|\/)\s*(?:steal|not)\b)`;
/** The split ball, however it's named: "split", "the split ball", "the 50/50 split". */
const BALL = r`(?:the\s+)?(?:50\/50\s+|fifty-fifty\s+|golden\s+)?${SPLIT}(?:\s+ball)?`;
const SHARE = r`share\s+(?:it|this|the\s+(?:jackpot|pot|money|prize|cash|winnings|lot)|£[\d,.]+k?|50\/50|fifty-fifty|evenly|equally|half)`;
/** Words that can sit between "I'll" and the verb without changing what it means. */
const ADV = r`(?:\s+(?:definitely|absolutely|100%|really|honestly|genuinely|truly|still|always|just|also|too|both|fully|totally|firmly|happily|gladly|now|already|obviously|clearly|certainly|surely|of\s+course|for\s+sure))*`;
const VERB = r`(?:choose|pick|select|press|hit|push|take|play|grab|open|vote|lock\s+in|go(?:\s+(?:with|for))?|stick\s+(?:with|to)|stay\s+with|stand\s+by)`;
const VERB_ING = r`(?:choosing|picking|selecting|pressing|hitting|pushing|taking|playing|grabbing|opening|voting|locking\s+in|going(?:\s+(?:with|for))?|sticking\s+(?:with|to)|staying\s+with|standing\s+by)`;
/** What they'll do: "split", "choose split", "take the 50/50 split", "share the pot". */
const ACT = r`(?:${SPLIT}|${VERB}\s+${BALL}|choose\s+to\s+${SPLIT}|${SHARE}|be\s+(?:splitting\b|${VERB_ING}\s+${BALL}))`;
/** The same, after a few words and "and": "keep my word and split". */
const ACT_AFTER = r`(?:(?:(?!(?:not|never|no)\b)(?![a-z']*n't\b)[^\s,;:.!?]+\s+){1,4}?and\s+(?:then\s+)?)?${ACT}`;
/** What they're doing: "splitting", "going SPLIT", "standing by split", "going to split". */
const DOING = r`(?:splitting\b(?![\s,]*or\s+steal)|${VERB_ING}\s+${BALL}|choosing\s+to\s+${SPLIT}|sharing\s+(?:it|this|the\s+(?:jackpot|pot|money|prize))|(?:going\s+to|gonna)${ADV}\s+${ACT_AFTER}|(?:locked\s+in|set|settled|committed|sticking|staying|all\s+in)\s+(?:on|to|with)\s+(?:the\s+)?split(?:ting)?\b|with\s+you\s+on\s+${SPLIT}|in\s+for\s+(?:a\s+|the\s+)?${SPLIT})`;
const WILL = r`\bi(?:'ll|\s+will|\s+shall)`;
const AM = r`(?:\bi(?:'m|\s+am)|\bim)`;
const WONT = r`\bi(?:'ll\s+never|'d\s+never|'m\s+not|'m\s+never|\s+won't|\s+will\s+not|\s+will\s+never|\s+wouldn't|\s+would\s+not|\s+would\s+never|\s+am\s+not|\s+am\s+never|\s+do\s+not|\s+don't|\s+never|\s+shall\s+not|\s+can't|\s+cannot|\s+could\s+never|\s+couldn't)`;
/** Words that can open a one-word reply: "OK, split." */
const OPENER = r`(?:(?:ok(?:ay)?|so|then|right|fine|deal|agreed|done|yes|yeah|yep|alright|well|good|great|sure)[\s,!.—–-]+)*`;
/** Words that, between "let's" and "split", make it something other than a plan to split. */
const NOT_A_PLAN = r`(?:not|never|talk|think|discuss|see|consider|hope|pretend|say|forget|imagine|wait|decide|whether|who|what|which|when|if|might|may|could|would|should|will)`;

interface Pattern {
  re: RegExp;
  /** Only a promise with "if you do" attached: a bare "I split" might be the past tense. */
  needsReciprocal?: boolean;
}

const PATTERNS: Pattern[] = [
  // I'll split / I will choose split / I'll take the 50/50 split / I'll keep my word and split
  { re: new RegExp(r`${WILL}${ADV}\s+${ACT_AFTER}`, 'g') },
  // I'm splitting / I'm going SPLIT / I'm standing by SPLIT / I'm going to split / I'm with you on split
  { re: new RegExp(r`${AM}${ADV}\s+${DOING}`, 'g') },
  // I choose split
  { re: new RegExp(r`\bi${ADV}\s+(?:choose|pick|select|take|vote|go\s+(?:for|with))\s+${BALL}`, 'g') },
  // I promise to split / I plan to split / I plan on splitting
  { re: new RegExp(r`\bi${ADV}\s+(?:promise|swear|vow|pledge|guarantee|intend|plan|mean|aim)\s+(?:you\s+)?to${ADV}\s+${ACT_AFTER}`, 'g') },
  { re: new RegExp(r`\bi${ADV}\s+(?:plan|intend)\s+on\s+splitting\b`, 'g') },
  // I've decided to split / I've chosen split
  { re: new RegExp(r`\bi(?:'ve|\s+have)?${ADV}\s+(?:decided|chosen|picked|settled|committed)\s+(?:to\s+|on\s+)?(?:the\s+)?split(?:ting)?\b`, 'g') },
  // I told you I was splitting / I said I'd split
  {
    re: new RegExp(
      r`\bi${ADV}\s+(?:told\s+you|said|promised(?:\s+you)?|swore)\s+(?:that\s+)?(?:i(?:'d|\s+would|'ll|\s+will|\s+was\s+going\s+to)${ADV}\s+${ACT_AFTER}|i(?:\s+was|'m|\s+am)${ADV}\s+${DOING})`,
      'g',
    ),
  },
  // I split if you split
  { re: new RegExp(r`\bi${ADV}\s+${SPLIT}`, 'g'), needsReciprocal: true },
  // Let's split / let's both go Split / let's keep our word and split / let's share it
  { re: new RegExp(r`\blet(?:'s|\s+us)\s+(?:(?!${NOT_A_PLAN}\b)[^\s,;:.!?]+\s+){0,5}?${ACT}`, 'g') },
  // Split, 50/50, done. / Split it is. / SPLIT from me.
  { re: new RegExp(r`^${OPENER}${SPLIT}(?:\s+it\s+is|\s+for\s+me|\s+from\s+me|\s+all\s+the\s+way)?(?=\s*(?:[,.!—–-]|$))`, 'g') },
  // SPLIT if you SPLIT.
  { re: new RegExp(r`^${OPENER}${SPLIT}(?=\s+(?:if|as\s+long\s+as|so\s+long\s+as)\s)`, 'g'), needsReciprocal: true },
  // My hand is on SPLIT / my choice is split
  {
    re: new RegExp(
      r`\bmy\s+(?:hand|finger|choice|vote|pick|answer|decision|ball|mind)\s+(?:is|'s|stays|will\s+be|goes)\s+(?:firmly\s+|already\s+|locked\s+)?(?:on\s+|made\s+up[:,]?\s*|in\s+on\s+)?(?:the\s+)?${SPLIT}`,
      'g',
    ),
  },
  // It's split for me
  { re: new RegExp(r`\b(?:it's|it\s+is)\s+(?:a\s+)?${SPLIT}\s+(?:for|from)\s+me\b`, 'g') },
  // I won't steal / I'd never steal from you / I'm not going to steal
  {
    re: new RegExp(
      r`${WONT}${ADV}\s+(?:(?:going\s+to|gonna)\s+)?(?:be\s+)?(?:steal(?:ing)?|(?:choos(?:e|ing)|pick(?:ing)?|press(?:ing)?|go(?:ing)?(?:\s+for)?)\s+(?:the\s+)?steal)\b`,
      'g',
    ),
  },
];

/** Reassurances that look like hedges or conditions but aren't: "don't worry", "if I'm honest". */
const ASIDES =
  /\b(?:(?:don't|do\s+not)\s+worry|no\s+worries|no\s+doubt(?:\s+about\s+it)?|make\s+no\s+mistake|not\s+gonna\s+lie|no\s+lie|no\s+joke|no\s+question|no\s+games|no\s+tricks|no\s+matter\s+what|if\s+(?:i'm|i\s+am)\s+(?:being\s+)?(?:honest|real|frank|truthful)|if\s+(?:it|that)\s+helps|if\s+anything|if\s+you\s+ask\s+me|if\s+you\s+must\s+know)\b/g;
/** Words that, earlier in the same clause, soften a commitment into something less: "maybe I'll split". */
const HEDGE = /\b(?:not|never|no|maybe|might|perhaps|probably|possibly|unsure|doubt|think|guess|hope|wish|wonder|whether|pretend|imagine|consider|considering|until)\b|n't\b/;
/** Someone else's words: "you said I'll split" is about them. */
const OTHER_SPEAKER =
  /\b(?:you|he|she|they|everyone|everybody|people|someone|nobody|anyone)(?:\s+(?:always|all|just|also|both|even|never|once|really|literally|probably)){0,2}\s+(?:said|says|say|told|tell|promised|promise|swore|swear|claimed|claim|claims|think|thinks|thought|believe|believes|believed|expect|expects|expected|bet|assume|assumed)\b/;
const CONDITION = /(?<!\beven\s)\b(?:if|unless|as\s+long\s+as|so\s+long\s+as|provided|providing|assuming|only\s+when|in\s+case)\b/g;
/** "If you do", "as long as you split", "if you're in": the other side of a pledge, not a get-out. */
const RECIPROCAL =
  /^\s+(?:that\s+)?(?:you(?:'re|'ll)?|we(?:\s+both)?)\s+(?:also\s+|too\s+|both\s+)?(?:do|does|will|are|split|splitting|go\s+split|choose\s+split|pick\s+split|promise|agree|in|keep\s+your\s+word|stick)\b/;
/** Where a clause ends, for hedges. */
const CLAUSE_BREAK = /[,;:—–]|\s-\s|\bbut\b/;
/** Where what a condition applies to ends: "if we both steal we lose, so I'm splitting". */
const SCOPE_BREAK = /;|\b(?:but|so(?!\s+long)|and|though|although|however|anyway|because|since)\b/;
const QUESTION_WORD = /^(?:why|what|how|who|where|when|which|would|will|can|could|should|shall|do|does|did|is|are|am|was|were|have|has)\b/;

function normalise(say: string): string {
  return say
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[*"“”]/g, '')
    .replace(ASIDES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences that state something. A question doesn't, but a statement with a short question tagged on does: "I'm splitting, are you?" */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => {
      s = s.trim();
      if (!s.endsWith('?')) return [s];
      const cut = Math.max(...[',', ';', ':', '—', '–', ' - '].map((c) => s.lastIndexOf(c)));
      if (cut <= 0) return [];
      const head = s.slice(0, cut).trim();
      const tail = s.slice(cut + 1).trim();
      return tail.split(/\s+/).length <= 6 && !QUESTION_WORD.test(head) ? [head] : [];
    })
    .filter((s) => s.length > 0);
}

function promiseIn(sentence: string): boolean {
  return PATTERNS.some(({ re, needsReciprocal }) =>
    [...sentence.matchAll(re)].some((m) => counts(sentence, m.index, m.index + m[0].length, needsReciprocal === true)),
  );
}

/** Is this match a commitment, given the words around it? */
function counts(sentence: string, start: number, end: number, needsReciprocal: boolean): boolean {
  const before = sentence.slice(0, start);
  if (HEDGE.test(before.split(CLAUSE_BREAK).pop()!)) return false;
  const scopeBefore = before.split(SCOPE_BREAK).pop()!;
  if (OTHER_SPEAKER.test(scopeBefore)) return false;
  const scope = `${scopeBefore} … ${sentence.slice(end).split(SCOPE_BREAK)[0]}`;
  let reciprocal = false;
  for (const c of scope.matchAll(CONDITION)) {
    if (!RECIPROCAL.test(scope.slice(c.index + c[0].length))) return false;
    reciprocal = true;
  }
  return reciprocal || !needsReciprocal;
}
