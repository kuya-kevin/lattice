// Session model: the single source of truth that both the user (via the UI) and Muse
// (via tools) edit. Plain JSON, times in seconds, no audio data (audio lives in the
// renderer's audio store, keyed by source id). Every op is pure: (session, ...) -> session.

export type SourceOrigin = 'import' | 'record' | 'freesound' | 'generated';

export interface Source {
  id: string;
  name: string;
  duration: number; // seconds
  origin: SourceOrigin;
}

export interface Clip {
  id: string;
  sourceId: string;
  name: string;
  start: number; // timeline position (s)
  offset: number; // trim-start point inside the source (s)
  duration: number; // audible length (s)
}

export interface Track {
  id: string;
  name: string;
  gainDb: number;
  muted: boolean;
  soloed: boolean;
  clips: Clip[];
}

export interface Session {
  tracks: Track[];
  sources: Record<string, Source>;
  selection: { trackId: string | null; clipId: string | null };
  /** `command` + `rev` let the UI replay a transport request even when the values repeat. */
  transport: { playing: boolean; position: number; command: 'play' | 'stop' | 'locate'; rev: number };
  tempo: number; // BPM (quarter notes)
  timeSignature: [number, number]; // e.g. [4, 4], [6, 8]
  key: string | null; // e.g. "G minor"
  metronome: { on: boolean; countIn: boolean }; // click during play/record; 1-bar count-in before recording
  punchIn: { trackId: string; start: number; end: number } | null;
  seq: number; // id counter, keeps ids short and deterministic (t1, c2, ...)
}

export class SessionError extends Error {}

export function emptySession(): Session {
  return {
    tracks: [],
    sources: {},
    selection: { trackId: null, clipId: null },
    transport: { playing: false, position: 0, command: 'stop', rev: 0 },
    tempo: 120,
    timeSignature: [4, 4],
    key: null,
    metronome: { on: false, countIn: false },
    punchIn: null,
    seq: 0,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function nextId(s: Session, prefix: string): [Session, string] {
  const seq = s.seq + 1;
  return [{ ...s, seq }, `${prefix}${seq}`];
}

export function getTrack(s: Session, trackId: string): Track {
  const t = s.tracks.find((t) => t.id === trackId);
  if (!t) throw new SessionError(`no track "${trackId}" (tracks: ${s.tracks.map((t) => t.id).join(', ') || 'none'})`);
  return t;
}

export function findClip(s: Session, clipId: string): { track: Track; clip: Clip } {
  for (const track of s.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new SessionError(`no clip "${clipId}"`);
}

function mapTrack(s: Session, trackId: string, fn: (t: Track) => Track): Session {
  getTrack(s, trackId);
  return { ...s, tracks: s.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

function mapClip(s: Session, clipId: string, fn: (c: Clip) => Clip): Session {
  const { track } = findClip(s, clipId);
  return mapTrack(s, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }));
}

export function addTrack(s: Session, name?: string): [Session, Track] {
  const [s1, id] = nextId(s, 't');
  const track: Track = { id, name: name || `Track ${s1.tracks.length + 1}`, gainDb: 0, muted: false, soloed: false, clips: [] };
  return [{ ...s1, tracks: [...s1.tracks, track] }, track];
}

export function addSource(s: Session, src: Source): Session {
  if (!(src.duration > 0)) throw new SessionError('source duration must be > 0');
  return { ...s, sources: { ...s.sources, [src.id]: src } };
}

export function addClip(s: Session, trackId: string, sourceId: string, start = 0): [Session, Clip] {
  const src = s.sources[sourceId];
  if (!src) throw new SessionError(`no source "${sourceId}"`);
  getTrack(s, trackId);
  const [s1, id] = nextId(s, 'c');
  const clip: Clip = { id, sourceId, name: src.name, start: round(Math.max(0, start)), offset: 0, duration: src.duration };
  return [mapTrack(s1, trackId, (t) => ({ ...t, clips: [...t.clips, clip] })), clip];
}

/** Set a clip's audible region to [start, end] on the timeline. The audio stays put:
 *  moving the left edge also moves the trim point inside the source. */
export function trimClip(s: Session, clipId: string, start: number, end: number): Session {
  const { clip } = findClip(s, clipId);
  const src = s.sources[clip.sourceId];
  const sourceStart = clip.start - clip.offset; // where source time 0 sits on the timeline
  const sourceEnd = sourceStart + (src?.duration ?? clip.offset + clip.duration);
  const a = Math.max(start, sourceStart, 0);
  const b = Math.min(end, sourceEnd);
  if (!(b - a > 0.01)) {
    throw new SessionError(`trim [${start}, ${end}] leaves nothing of clip ${clipId} (audio spans ${round(sourceStart)}-${round(sourceEnd)} s)`);
  }
  return mapClip(s, clipId, (c) => ({ ...c, start: round(a), offset: round(a - sourceStart), duration: round(b - a) }));
}

export function moveClip(s: Session, clipId: string, start: number): Session {
  return mapClip(s, clipId, (c) => ({ ...c, start: round(Math.max(0, start)) }));
}

export function setGain(s: Session, trackId: string, gainDb: number): Session {
  const g = Math.max(-60, Math.min(12, gainDb));
  return mapTrack(s, trackId, (t) => ({ ...t, gainDb: round(g) }));
}

export function setMute(s: Session, trackId: string, muted: boolean): Session {
  return mapTrack(s, trackId, (t) => ({ ...t, muted }));
}

export function setSolo(s: Session, trackId: string, soloed: boolean): Session {
  return mapTrack(s, trackId, (t) => ({ ...t, soloed }));
}

export function armPunchIn(s: Session, trackId: string, start: number, end: number): Session {
  getTrack(s, trackId);
  if (!(end > start) || start < 0) throw new SessionError('punch-in needs 0 <= start < end');
  return { ...s, punchIn: { trackId, start: round(start), end: round(end) } };
}

export function setTransport(s: Session, command: 'play' | 'stop' | 'locate', position?: number): Session {
  const t = s.transport;
  const playing = command === 'locate' ? t.playing : command === 'play';
  const pos = position == null ? t.position : round(Math.max(0, position));
  return { ...s, transport: { playing, position: pos, command, rev: t.rev + 1 } };
}

export const TEMPO_RANGE = [40, 240] as const;
export const TIME_SIGNATURES: [number, number][] = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [7, 8], [12, 8]];

export function setTempo(s: Session, bpm: number): Session {
  if (!(bpm >= TEMPO_RANGE[0] && bpm <= TEMPO_RANGE[1])) throw new SessionError(`tempo must be ${TEMPO_RANGE[0]}-${TEMPO_RANGE[1]} BPM`);
  return { ...s, tempo: Math.round(bpm * 100) / 100 };
}

export function setTimeSignature(s: Session, beats: number, unit: number): Session {
  if (!Number.isInteger(beats) || beats < 1 || beats > 16 || ![2, 4, 8, 16].includes(unit)) {
    throw new SessionError('time signature needs 1-16 beats over 2, 4, 8 or 16');
  }
  return { ...s, timeSignature: [beats, unit] };
}

const TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** All 24 keys, e.g. "C major", "C minor", "C# major", ... */
export const KEYS = TONICS.flatMap((t) => [`${t} major`, `${t} minor`]);

/** Normalizes "Gm", "g minor", "F# maj", "Bb", "D♭ minor" -> canonical "G minor" etc.; null if unparseable. */
export function parseKey(text: string): string | null {
  const m = text.trim().match(/^([A-Ga-g])\s*(#|♯|b|♭)?\s*(major|maj|minor|min|m)?$/i);
  if (!m) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  const pc = (LETTER[m[1].toUpperCase()] + acc + 12) % 12;
  const minor = m[3] === 'm' || /^min/i.test(m[3] ?? '');
  return `${TONICS[pc]} ${minor ? 'minor' : 'major'}`;
}

export function setKey(s: Session, key: string | null): Session {
  if (key == null || key === '') return { ...s, key: null };
  const k = parseKey(key);
  if (!k) throw new SessionError(`unknown key "${key}" (try e.g. "G minor", "Eb major", "F#m")`);
  return { ...s, key: k };
}

export function setMetronome(s: Session, on?: boolean, countIn?: boolean): Session {
  return { ...s, metronome: { on: on ?? s.metronome.on, countIn: countIn ?? s.metronome.countIn } };
}

export function select(s: Session, trackId: string | null, clipId: string | null): Session {
  return { ...s, selection: { trackId, clipId } };
}

export function sessionEnd(s: Session): number {
  return s.tracks.reduce((m, t) => t.clips.reduce((m2, c) => Math.max(m2, c.start + c.duration), m), 0);
}

/** Compact text view of the session for Muse (it can't see the screen or hear audio). */
export function summarize(s: Session): string {
  const click = s.metronome.on ? `click on${s.metronome.countIn ? ', 1-bar count-in' : ''}` : 'click off';
  const header = `Tempo ${s.tempo} BPM, ${s.timeSignature.join('/')}, key ${s.key ?? 'not set'}, ${click}.`;
  if (!s.tracks.length) return `${header}\nSession is empty (no tracks).`;
  const lines = s.tracks.map((t) => {
    const flags = [t.muted && 'muted', t.soloed && 'soloed'].filter(Boolean).join(', ');
    const clips = t.clips
      .map((c) => `${c.id} "${c.name}" ${round(c.start)}-${round(c.start + c.duration)}s`)
      .join('; ');
    return `- ${t.id} "${t.name}" gain ${t.gainDb} dB${flags ? ` (${flags})` : ''}: ${clips || 'no clips'}`;
  });
  const sel = s.selection.clipId ? `selected clip ${s.selection.clipId}` : s.selection.trackId ? `selected track ${s.selection.trackId}` : 'nothing selected';
  const punch = s.punchIn ? `; punch-in armed on ${s.punchIn.trackId} ${s.punchIn.start}-${s.punchIn.end}s` : '';
  return `${header}\n${lines.join('\n')}\n(${sel}; ${s.transport.playing ? 'playing' : 'stopped'} at ${round(s.transport.position)}s${punch})`;
}
