// Musical Typing (Logic Pro's Cmd-K keyboard): the computer keyboard as a piano. Pure key map
// and note bookkeeping; the renderer (MusicalTyping.tsx) plays the sound and draws the keys.
//
// Layout, by physical key (KeyboardEvent.code, so it works on any keyboard layout and with Shift):
//   home row  A S D F G H J K L ; '  = white keys C D E F G A B C D E F
//   top row   W E   T Y U   O P      = black keys C# D#  F# G# A#  C# D#
//   Z / X = octave down / up, C / V = velocity down / up, Tab = sustain while held.
// Octave naming: MIDI 60 is "C4" here (scientific pitch, as noteName in midi.ts and what Muse
// sees). Logic names the same note C3. A plays MIDI 60 (middle C) by default, as in Logic.
import { noteName, type MidiNote, type SampleRef } from './midi';
import type { Session } from './session';

/** Semitones above the current octave's C, per physical key. */
export const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

/** The key (code) that plays each semitone offset, for labels on the on-screen keyboard. */
export const KEY_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(NOTE_KEYS).map(([code, off]) => [off, code === 'Semicolon' ? ';' : code === 'Quote' ? "'" : code.slice(3)]),
);

export const DEFAULT_BASE = 60; // A = middle C
export const BASE_RANGE: [number, number] = [12, 108]; // A plays C0 .. C8
export const VELOCITIES = [1, 20, 40, 60, 80, 100, 120, 127];
export const DEFAULT_VELOCITY = 100;

export type TypingAction =
  | { type: 'note'; offset: number }
  | { type: 'octave'; delta: -1 | 1 }
  | { type: 'velocity'; delta: -1 | 1 }
  | { type: 'sustain' };

export function keyAction(code: string): TypingAction | null {
  if (code in NOTE_KEYS) return { type: 'note', offset: NOTE_KEYS[code] };
  if (code === 'KeyZ') return { type: 'octave', delta: -1 };
  if (code === 'KeyX') return { type: 'octave', delta: 1 };
  if (code === 'KeyC') return { type: 'velocity', delta: -1 };
  if (code === 'KeyV') return { type: 'velocity', delta: 1 };
  if (code === 'Tab') return { type: 'sustain' };
  return null;
}

export const shiftOctave = (base: number, delta: number) => Math.max(BASE_RANGE[0], Math.min(BASE_RANGE[1], base + 12 * delta));

/** Next step on the velocity ladder (from any value, e.g. 90 + up = 100). */
export function stepVelocity(v: number, delta: number): number {
  if (delta > 0) return VELOCITIES.find((x) => x > v) ?? VELOCITIES[VELOCITIES.length - 1];
  return [...VELOCITIES].reverse().find((x) => x < v) ?? VELOCITIES[0];
}

/** MIDI pitch for an offset at a base, or null outside 0-127. */
export function pitchAt(base: number, offset: number): number | null {
  const p = base + offset;
  return p >= 0 && p <= 127 ? p : null;
}

/** "C4–F5": the range the home row covers at `base`. */
export const rangeLabel = (base: number) => `${noteName(base)}–${noteName(base + 17)}`;

interface KeyLike {
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** While Musical Typing is on, every plain letter key (plus ; ' and Tab) belongs to it, so
 *  single-letter shortcuts (K, C, O, B...) pause. R is the exception: it plays no note, and it
 *  stays Record so you can press R and play a MIDI take. Space, Return, , . Delete and
 *  Cmd/Ctrl combos are left alone. */
export function claimsKey(e: KeyLike): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const code = e.code || (/^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : e.key);
  if (code === 'KeyR') return false;
  return /^Key[A-Z]$/.test(code) || code === 'Semicolon' || code === 'Quote' || code === 'Tab';
}

// ---- note events: the one stream a recorder subscribes to ----

/** A played note. `start`/`end` are transport seconds (the playhead), `end` is null while held. */
export interface PlayedNote {
  pitch: number;
  velocity: number;
  start: number;
  end: number | null;
}

/** Turn notes played during a take into clip notes (source-relative, like MidiNote), dropping
 *  anything before the take and closing still-held notes at `takeEnd`. */
export function takeToNotes(played: PlayedNote[], takeStart: number, takeEnd: number): MidiNote[] {
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return played
    .map((n) => ({ ...n, end: Math.min(n.end ?? takeEnd, takeEnd) }))
    .filter((n) => n.end > takeStart && n.start < takeEnd)
    .map((n) => {
      const start = Math.max(n.start, takeStart) - takeStart;
      return { pitch: n.pitch, velocity: n.velocity, start: r4(start), duration: r4(Math.max(0.01, n.end - takeStart - start)) };
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ---- the instrument: the selected audio clip as a sampler, else the piano ----

/** A sample plays at its own pitch on this note: C4, the A key at the default octave. */
export const SAMPLE_ROOT = DEFAULT_BASE;

/** What Musical Typing plays: a sample (with its label, the clip name) or null for the piano. */
export interface TypingSample {
  name: string;
  sample: SampleRef;
}

/** The instrument for the current selection: the selected clip (else the selected track's
 *  first clip). An audio clip is played as a sampler over its audible region; a MIDI clip
 *  recorded with a sample keeps that sample; anything else (or nothing) is the piano. The
 *  renderer still falls back to the piano while the sample's audio is not loaded. */
export function typingInstrument(s: Session): TypingSample | null {
  const { trackId, clipId } = s.selection;
  const clips = s.tracks.flatMap((t) => t.clips);
  const clip = clipId ? clips.find((c) => c.id === clipId) : s.tracks.find((t) => t.id === trackId)?.clips[0];
  if (!clip) return null;
  if (clip.midi) return clip.midi.sample ? { name: clip.midi.instrument, sample: clip.midi.sample } : null;
  return { name: clip.name, sample: { sourceId: clip.sourceId, offset: clip.offset, duration: clip.duration, root: SAMPLE_ROOT } };
}
