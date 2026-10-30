// B20: detect a clip's key from its notes (Bitwig's "Detect Event Key"). A pitch-class histogram,
// weighted by duration and velocity, is correlated with the Krumhansl-Kessler key profiles for all
// 24 keys. Muse can't hear the music, so a key it can read as text helps it transpose and pick
// sounds. Pure; no model.
import type { MidiNote } from './midi';
import { KEYS } from './session';

// Krumhansl & Kessler (1982) probe-tone ratings, tonic first
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** A runner-up closer than this (in correlation) is worth naming (often the relative key). */
export const CLOSE = 0.1;

export interface KeyGuess {
  key: string; // canonical, e.g. "A minor" (session.KEYS)
  r: number; // correlation with the key's profile, -1..1
  certainty: 'clear' | 'likely' | 'unsure';
  runnerUp?: { key: string; r: number };
}

function pearson(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Pitch-class weights: each note counts by its length times its velocity. */
export function pitchClassHistogram(notes: MidiNote[]): number[] {
  const h = new Array(12).fill(0);
  for (const n of notes) h[((n.pitch % 12) + 12) % 12] += n.duration * (n.velocity / 127);
  return h;
}

/** All 24 keys scored, best first. */
export function scoreKeys(notes: MidiNote[]): { key: string; r: number }[] {
  const h = pitchClassHistogram(notes);
  return KEYS.map((key, i) => {
    const tonic = i >> 1;
    const profile = i & 1 ? MINOR : MAJOR;
    // the profile rotated so its tonic sits on this key's pitch class
    const rotated = h.map((_, pc) => profile[(pc - tonic + 12) % 12]);
    return { key, r: pearson(h, rotated) };
  }).sort((a, b) => b.r - a.r);
}

/** The best key, or null when the notes can't say (fewer than 3 pitch classes). */
export function detectKey(notes: MidiNote[]): KeyGuess | null {
  const classes = new Set(notes.filter((n) => n.duration > 0).map((n) => ((n.pitch % 12) + 12) % 12));
  if (classes.size < 3) return null;
  const [best, second] = scoreKeys(notes);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const gap = best.r - second.r;
  const certainty = best.r >= 0.75 && gap >= CLOSE ? 'clear' : best.r >= 0.6 ? 'likely' : 'unsure';
  return { key: best.key, r: r2(best.r), certainty, ...(gap < CLOSE ? { runnerUp: { key: second.key, r: r2(second.r) } } : {}) };
}
