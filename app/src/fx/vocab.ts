// B1: sound words -> knob moves (vocab.json), looked up by the suggest_moves tool so Muse knows
// how far to turn which knobs for "muddy", "punchy", "stand out", and that a word can mean
// different moves on a bass than on a vocal.
import { DEVICE_IDS, getDevice, getParam, VOCAB, type VocabEntry, type VocabMove } from './catalog';

export const SOURCE_TYPES = ['vocal', 'bass', 'drums', 'pad', 'guitar', 'keys', 'bus', 'master'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const NAME_HINTS: [SourceType, RegExp][] = [
  ['vocal', /\b(vocals?|vox|voice|singer|lead vox|bv|bgv|choir|rap)\b/i],
  ['bass', /\b(bass|sub|808)\b/i],
  ['drums', /\b(drums?|kick|snare|hats?|hi-?hat|toms?|perc\w*|beat|loop|cymbals?|overheads?)\b/i],
  ['pad', /\b(pads?|strings?|synth|ambien\w*|texture|drone)\b/i],
  ['guitar', /\b(guitars?|gtr|acoustic|electric)\b/i],
  ['keys', /\b(keys|piano|rhodes|organ|wurli\w*|ep)\b/i],
  ['bus', /\b(bus|group|stem|mix)\b/i],
];

/** A source type from a track name ("Vocal take" -> vocal, "Bass DI" -> bass), or undefined. */
export function sourceTypeOf(trackName: string): SourceType | undefined {
  return NAME_HINTS.find(([, re]) => re.test(trackName))?.[0];
}

// filler words go; more/less stay, they carry the direction ("less bright" is dull, not bright)
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\b(a bit|a little|too|very|much|really|some|the|it|sound|sounds|make|making)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** The vocab entry for a word: exact word or alias first, then a word/alias inside the phrase;
 *  among those, one for this source type beats 'any', which beats the rest. */
export function lookupWord(word: string, source?: string): VocabEntry | undefined {
  const w = norm(word);
  if (!w) return undefined;
  const names = (e: VocabEntry) => [e.word, ...(e.aliases ?? [])].map(norm);
  const exact = VOCAB.filter((e) => names(e).includes(w));
  const within = exact.length ? exact : VOCAB.filter((e) => names(e).some((n) => n && new RegExp(`\\b${n.replace(/[-]/g, '\\-')}\\b`).test(w)));
  const rank = (e: VocabEntry) => (source && e.sourceTypes.includes(source) ? 0 : e.sourceTypes.includes('any') ? 1 : 2);
  return [...within].sort((a, b) => rank(a) - rank(b))[0];
}

/** Devices whose catalog words mention the word (for a word with no vocab entry). */
export function devicesForWord(word: string): string[] {
  const w = norm(word);
  return DEVICE_IDS.filter((id) => {
    const d = getDevice(id);
    return [...(d.words ?? []), ...d.params.flatMap((p) => p.words ?? [])].some((x) => norm(x) === w || norm(x).includes(w) || w.includes(norm(x)));
  });
}

const AMOUNT = { 'a bit': 0.5, normal: 1, 'a lot': 1.5 } as const;
export type Amount = keyof typeof AMOUNT;

/** The entry's moves scaled by amount (relative moves only: add x k, mul ^ k), with units. */
export function scaledMoves(e: VocabEntry, amount: Amount = 'normal'): (VocabMove & { unit?: string })[] {
  const k = AMOUNT[amount] ?? 1;
  return e.moves.map((m) => {
    const unit = getParam(getDevice(m.device), m.param).unit;
    const value = typeof m.value !== 'number' || m.op === 'set' ? m.value : m.op === 'add' ? round(m.value * k) : round(m.value ** k);
    return { ...m, value, ...(unit ? { unit } : {}) };
  });
}

const round = (x: number) => Math.round(x * 1000) / 1000;
export const AMOUNTS = Object.keys(AMOUNT) as Amount[];
