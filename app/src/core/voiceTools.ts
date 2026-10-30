// B14 "Muse talks back": a toggle (off by default) that reads Muse's final reply aloud, so a
// musician with hands on an instrument can push-to-talk in and hear the answer. The toggle is a
// tool like every other action (the chat panel's speaker button calls it too); the renderer does
// the speaking (renderer/voice.ts) with Meta's MMS-TTS English. This module also turns a reply
// into what is spoken: short replies whole, long ones by their first sentence, with numbers and
// units written out (MMS-TTS only reads lowercase letters, a few digits and no punctuation).
import type { Session } from './session';
import type { ToolDef } from './tools';

export const voiceReplyOn = (s: Session) => s.voiceReply === true;

export function setVoiceReply(s: Session, on: boolean): Session {
  return { ...s, voiceReply: on };
}

/** The line Muse sees in the session summary while voice replies are on. */
export function voiceLine(s: Session): string {
  return voiceReplyOn(s) ? 'Voice replies: on (your final reply is read aloud; past 160 characters only its first sentence).' : '';
}

export const VOICE_TOOLS: ToolDef[] = [
  {
    name: 'set_voice_reply',
    description:
      'Turn spoken replies on or off: when on, your final reply is read aloud to the user (a long reply only by its first sentence), ' +
      'so keep it short. Use when the user asks you to talk back, or to stop talking.',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true = read replies aloud' } },
      required: ['on'],
      additionalProperties: false,
    },
    quiet: true, // a preference, not an edit: no undo step (undo also leaves it as it is)
    run: (ctx, a) => {
      ctx.store.set(setVoiceReply(ctx.store.get(), a.on));
      return { voice_reply: a.on };
    },
    logText: (a) => `turned voice replies ${a.on ? 'on' : 'off'}`,
  },
];

/** Replies longer than this are spoken by their first sentence only. */
export const LONG_REPLY = 160;

/** What to say for a reply: plain text (no markdown, links or code), whole if short, else the
 *  first sentence. Empty if there is nothing to say. */
export function spokenReply(reply: string): string {
  const plain = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '') // list bullets
    .replace(/[*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= LONG_REPLY) return plain;
  const first = /^.+?[.?!](?=\s|$)/.exec(plain)?.[0] ?? plain;
  if (first.length <= LONG_REPLY * 1.5) return first;
  const cut = first.slice(0, LONG_REPLY);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)) + '.';
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0 .. 999 999 999 in words ("three hundred twenty one"); larger numbers digit by digit. */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`numberWords: ${n}`);
  if (n >= 1e9) return String(n).split('').map((d) => ONES[+d]).join(' ');
  const under1000 = (k: number): string[] => {
    const out: string[] = [];
    if (k >= 100) out.push(ONES[Math.floor(k / 100)], 'hundred');
    const r = k % 100;
    if (r >= 20) out.push(TENS[Math.floor(r / 10)] + (r % 10 ? ` ${ONES[r % 10]}` : ''));
    else if (r || !out.length) out.push(ONES[r]);
    return out;
  };
  if (n === 0) return 'zero';
  const parts: string[] = [];
  for (const [size, name] of [[1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) {
      parts.push(...under1000(Math.floor(n / size)), name);
      n %= size;
    }
  }
  if (n) parts.push(...under1000(n));
  return parts.join(' ');
}

function decimalWords(raw: string): string {
  const [whole, frac] = raw.replace(/,/g, '').split('.');
  const w = numberWords(Number(whole || '0'));
  return frac ? `${w} point ${frac.split('').map((d) => ONES[+d]).join(' ')}` : w;
}

const UNITS: Record<string, [string, string]> = {
  db: ['decibel', 'decibels'],
  hz: ['hertz', 'hertz'],
  khz: ['kilohertz', 'kilohertz'],
  ms: ['millisecond', 'milliseconds'],
  s: ['second', 'seconds'],
  sec: ['second', 'seconds'],
  bpm: ['bee pee em', 'bee pee em'],
  st: ['semitone', 'semitones'],
  '%': ['percent', 'percent'],
};
const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** Text the MMS-TTS English model can read: numbers, units and symbols in words. */
export function speakable(text: string): string {
  return text
    .replace(/(\d)\s*[–-]\s*(\d)/g, '$1 to $2') // ranges: 2–9 s
    .replace(/(^|[\s(])([-−+])(?=\d)/g, (_m, pre, sign) => `${pre}${sign === '+' ? 'plus' : 'minus'} `)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, num: string) => {
      const w = numberWords(Number(num)).split(' ');
      const last = w.pop()!;
      const ord = ORDINAL[last] ?? (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
      return [...w, ord].join(' ');
    })
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(khz|hz|db|ms|sec|s|bpm|st|%)(?![a-z])/gi, (_m, num: string, unit: string) => {
      const [one, many] = UNITS[unit.toLowerCase()];
      return `${decimalWords(num)} ${num === '1' ? one : many}`;
    })
    .replace(/\d[\d,]*(?:\.\d+)?/g, (num) => decimalWords(num))
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/=/g, ' equals ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
