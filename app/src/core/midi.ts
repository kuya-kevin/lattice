// MIDI clips: notes on a clip (times in seconds from the clip's source start, like audio),
// plus what the source-prep sidecar (spikes/k_source_prep) returns. Pure functions only.

export interface MidiNote {
  pitch: number; // MIDI note number
  start: number; // s, from the source start
  duration: number; // s
  velocity: number; // 1-127
}

/** A clip's notes and the sound that plays them. Playback is one built-in piano-like voice for
 *  pitched parts and a small synthesized kit for drums (the user swaps sounds later). */
export interface MidiData {
  instrument: string; // label, e.g. "piano", "drums"
  drum?: boolean; // GM drum notes: 36 kick, 38 snare, 42 hat
  notes: MidiNote[];
}

/** One stem in the sidecar manifest (prep.py, version 1). */
export interface PrepStem {
  name: string;
  role: string; // melody | bass | keys | drums
  instrument: string;
  is_drum: boolean;
  transcriber: string;
  raw_notes: number;
  notes_count: number;
  range: [string, string] | null;
  confidence: number;
  midi: string;
  notes: { pitch: number; start: number; end: number; velocity: number }[];
  drum_classes?: Record<string, number>;
}

export interface PrepManifest {
  version: number;
  input: string;
  duration: number;
  content: string;
  tempo: { bpm: number; confidence?: number; offset?: number; quantized?: boolean; source?: string } | null;
  key: { name: string; r?: number } | null;
  warnings: string[];
  stems: PrepStem[];
  /** absolute folder of the run (added by the node side; .mid files live under it) */
  dir?: string;
}

export const GRIDS: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125 };

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p: number) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function stemToMidi(stem: PrepStem): MidiData {
  return {
    instrument: stem.is_drum ? 'drums' : 'piano',
    ...(stem.is_drum ? { drum: true } : {}),
    notes: stem.notes
      .filter((n) => n.end > n.start)
      .map((n) => ({ pitch: n.pitch, start: r4(n.start), duration: r4(n.end - n.start), velocity: Math.max(1, Math.min(127, Math.round(n.velocity))) })),
  };
}

/** Snap note starts (and ends) to a grid at `bpm`. `origin` is where beat 1 sits, in the
 *  same time base as the notes (for a clip: its timeline start minus its trim offset, so the
 *  grid matches the session's bars). strength 0-1. Notes keep a minimum length of half a step. */
export function quantizeNotes(notes: MidiNote[], bpm: number, grid: string, strength = 1, origin = 0, ends = true): MidiNote[] {
  const beats = GRIDS[grid];
  if (!beats) throw new Error(`unknown grid "${grid}" (try ${Object.keys(GRIDS).join(', ')})`);
  if (!(bpm > 0)) throw new Error('bpm must be > 0');
  const k = Math.max(0, Math.min(1, strength));
  const step = (60 / bpm) * beats;
  const snap = (t: number) => origin + Math.round((t - origin) / step) * step;
  return notes
    .map((n) => {
      const s = n.start + k * (snap(n.start) - n.start);
      let e = s + n.duration;
      if (ends) e = e + k * (snap(e) - e);
      const minLen = step * (k >= 1 ? 1 : 0.5);
      if (e - s < minLen) e = s + minLen;
      return { ...n, start: r4(Math.max(0, s)), duration: r4(e - Math.max(0, s)) };
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

export function describeMidi(m: MidiData): string {
  if (!m.notes.length) return `MIDI ${m.instrument}, empty`;
  if (m.drum) {
    const count = (p: number) => m.notes.filter((n) => n.pitch === p).length;
    return `MIDI drums, ${m.notes.length} hits (kick ${count(36)}, snare ${count(38)}, hat ${count(42)})`;
  }
  const ps = m.notes.map((n) => n.pitch);
  return `MIDI ${m.instrument}, ${m.notes.length} notes ${noteName(Math.min(...ps))}-${noteName(Math.max(...ps))}`;
}

/** Short stable signature of a clip's MIDI (to know when a playback render is stale). */
export function midiSignature(m: MidiData, duration: number): string {
  let h = 2166136261;
  const s = `${m.instrument}|${m.drum ? 1 : 0}|${duration}|` + m.notes.map((n) => `${n.pitch},${n.start},${n.duration},${n.velocity}`).join(';');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
