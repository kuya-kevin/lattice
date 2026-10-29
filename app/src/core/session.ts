// Session model: the single source of truth that both the user (via the UI) and Muse
// (via tools) edit. Plain JSON, times in seconds, no audio data (audio lives in the
// renderer's audio store, keyed by source id). Every op is pure: (session, ...) -> session.

import { describeSettings, type ParamValues } from '../fx/catalog';
import { describeMidi, type MidiData } from './midi'; // [S3 midi]
import { describeKits, type Kit } from './kit'; // B12 drum pads

export type SourceOrigin = 'import' | 'record' | 'freesound' | 'generated' | 'processed';

export interface Source {
  id: string;
  name: string;
  duration: number; // seconds
  origin: SourceOrigin;
  /** Attribution for library sounds (CC-BY needs it), e.g. '"Kick" by x (url), CC-BY-4.0'. */
  credit?: string;
  /** B3: audio made by the sidecar from another source (origin 'processed'): which one, and
   *  what was done, e.g. "noise cleaned (Mel-RoFormer denoise)". Shown to Muse on the clip. */
  derivedFrom?: string;
  processed?: string;
}

export interface Clip {
  id: string;
  sourceId: string;
  name: string;
  start: number; // timeline position (s)
  offset: number; // trim-start point inside the source (s)
  duration: number; // audible length (s)
  /** [S3 midi] A MIDI clip: notes (source-relative seconds) instead of audio. Its source only
   *  carries the length; the renderer synthesizes the sound from the notes. Keeping the notes
   *  on the clip (not the source) lets undo restore them. */
  midi?: MidiData;
}

/** One effect device on a track's insert chain (kind = catalog device id, e.g. "eq"). */
export interface DeviceInstance {
  id: string;
  kind: string;
  on: boolean;
  params: ParamValues; // every catalog param, defaults filled in
}

export interface Track {
  id: string;
  name: string;
  gainDb: number;
  muted: boolean;
  soloed: boolean;
  /** Record-armed (Logic's R button): the next take goes here. Optional for older sessions. */
  armed?: boolean;
  /** Lane height relative to the global track height (Height −/+), set by dragging the lane's
   *  bottom edge. Absent = 1. A view setting: no undo, not shown to Muse. */
  heightScale?: number;
  clips: Clip[];
  devices: DeviceInstance[]; // insert chain, in signal order (fx/chain.ts edits it)
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
  /** B12: drum pads (kits), by id. Optional for older sessions. */
  kits?: Record<string, Kit>;
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

export function nextId(s: Session, prefix: string): [Session, string] {
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

export function mapTrack(s: Session, trackId: string, fn: (t: Track) => Track): Session {
  getTrack(s, trackId);
  return { ...s, tracks: s.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

function mapClip(s: Session, clipId: string, fn: (c: Clip) => Clip): Session {
  const { track } = findClip(s, clipId);
  return mapTrack(s, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }));
}

export function addTrack(s: Session, name?: string): [Session, Track] {
  const [s1, id] = nextId(s, 't');
  const track: Track = { id, name: name || `Track ${s1.tracks.length + 1}`, gainDb: 0, muted: false, soloed: false, clips: [], devices: [] };
  return [{ ...s1, tracks: [...s1.tracks, track] }, track];
}

/** Rename a track (surrounding whitespace trimmed; an empty name is refused). */
export function renameTrack(s: Session, trackId: string, name: string): Session {
  const n = name.trim();
  if (!n) throw new SessionError('track name cannot be empty');
  return mapTrack(s, trackId, (t) => ({ ...t, name: n }));
}

/** Per-track lane height (px per channel) limits. */
export const LANE_HEIGHT = [24, 384] as const;

/** Lane height for a track: the global height times the track's own scale, or undefined to
 *  use the global one. */
export function laneHeight(scale: number | undefined, waveHeight: number): number | undefined {
  if (!scale || scale === 1) return undefined;
  return Math.round(Math.min(LANE_HEIGHT[1], Math.max(LANE_HEIGHT[0], waveHeight * scale)));
}

/** Scale a track's lane height (relative to the global track height); null resets it. */
export function setTrackHeight(s: Session, trackId: string, scale: number | null): Session {
  if (scale !== null && !(scale > 0 && Number.isFinite(scale))) throw new SessionError('height scale must be > 0');
  return mapTrack(s, trackId, (t) => {
    const { heightScale: _, ...rest } = t;
    return scale === null || Math.abs(scale - 1) < 0.01 ? rest : { ...rest, heightScale: Math.round(scale * 1000) / 1000 };
  });
}

/** Remove a track and its clips. Sources stay (undo brings the clips back with their audio);
 *  a selection or punch-in on the track is cleared. */
export function deleteTrack(s: Session, trackId: string): Session {
  const track = getTrack(s, trackId);
  const onTrack = s.selection.trackId === trackId || track.clips.some((c) => c.id === s.selection.clipId);
  return {
    ...s,
    tracks: s.tracks.filter((t) => t.id !== trackId),
    selection: onTrack ? { trackId: null, clipId: null } : s.selection,
    punchIn: s.punchIn?.trackId === trackId ? null : s.punchIn,
  };
}

export function addSource(s: Session, src: Source): Session {
  if (!(src.duration > 0)) throw new SessionError('source duration must be > 0');
  return { ...s, sources: { ...s.sources, [src.id]: src } };
}

/** B3: a track's clips of one source now play a processed version of it (cleanup, quantize).
 *  Timing is untouched: the processed audio has the source's length. Undo brings the original back. */
export function replaceTrackSource(s: Session, trackId: string, fromId: string, src: Source): Session {
  const t = getTrack(s, trackId);
  if (!t.clips.some((c) => c.sourceId === fromId && !c.midi)) throw new SessionError(`track ${trackId} has no audio clips of source "${fromId}"`);
  return mapTrack(addSource(s, src), trackId, (tr) => ({ ...tr, clips: tr.clips.map((c) => (c.sourceId === fromId && !c.midi ? { ...c, sourceId: src.id } : c)) }));
}

/** The original a source was processed from (itself if it was not processed, or if the
 *  original is gone). */
export function rootSource(s: Session, sourceId: string): string {
  let id = sourceId;
  for (let i = 0; i < 64; i++) {
    const up = s.sources[id]?.derivedFrom;
    if (!up || !s.sources[up]) return id;
    id = up;
  }
  return id;
}

/** Every version of a sound: its original, then each processed version, oldest first. */
export function sourceVersions(s: Session, sourceId: string): Source[] {
  const root = rootSource(s, sourceId);
  return Object.values(s.sources).filter((src) => rootSource(s, src.id) === root);
}

/** Switch the audio clips playing any version of a sound to `sourceId` (one of its versions),
 *  on one track or on every track. Timing is untouched: versions have the original's length. */
export function useSourceVersion(s: Session, sourceId: string, trackId?: string): { session: Session; clips: string[] } {
  if (!s.sources[sourceId]) throw new SessionError(`no source "${sourceId}"`);
  if (trackId) getTrack(s, trackId);
  const family = new Set(sourceVersions(s, sourceId).map((x) => x.id));
  const clips: string[] = [];
  const tracks = s.tracks.map((t) => {
    if (trackId && t.id !== trackId) return t;
    if (!t.clips.some((c) => !c.midi && family.has(c.sourceId) && c.sourceId !== sourceId)) return t;
    return {
      ...t,
      clips: t.clips.map((c) => {
        if (c.midi || !family.has(c.sourceId) || c.sourceId === sourceId) return c;
        clips.push(c.id);
        return { ...c, sourceId };
      }),
    };
  });
  if (!clips.length) throw new SessionError(`no clips play another version of "${s.sources[sourceId].name}"${trackId ? ` on ${trackId}` : ''}`);
  return { session: { ...s, tracks }, clips };
}

/** Remove a sound and every clip that plays it (the Ideas card's delete). Undo restores both;
 *  the renderer keeps the audio buffer, so the clips come back with their sound. */
export function deleteSource(s: Session, sourceId: string): Session {
  if (!s.sources[sourceId]) throw new SessionError(`no source "${sourceId}"`);
  const { [sourceId]: _, ...sources } = s.sources;
  const gone = new Set(s.tracks.flatMap((t) => t.clips.filter((c) => c.sourceId === sourceId).map((c) => c.id)));
  // pads that played it go empty (B12)
  const kits = s.kits && Object.fromEntries(Object.entries(s.kits).map(([id, k]) => [id, k.pads.some((p) => p.sample?.sourceId === sourceId)
    ? { ...k, pads: k.pads.map((p) => (p.sample?.sourceId === sourceId ? { label: p.label, note: p.note } : p)) }
    : k]));
  return {
    ...s,
    sources,
    ...(kits ? { kits } : {}),
    tracks: s.tracks.map((t) => (t.clips.some((c) => gone.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !gone.has(c.id)) } : t)),
    selection: s.selection.clipId && gone.has(s.selection.clipId) ? { ...s.selection, clipId: null } : s.selection,
  };
}

export function addClip(s: Session, trackId: string, sourceId: string, start = 0): [Session, Clip] {
  const src = s.sources[sourceId];
  if (!src) throw new SessionError(`no source "${sourceId}"`);
  getTrack(s, trackId);
  const [s1, id] = nextId(s, 'c');
  const clip: Clip = { id, sourceId, name: src.name, start: round(Math.max(0, start)), offset: 0, duration: src.duration };
  return [mapTrack(s1, trackId, (t) => ({ ...t, clips: [...t.clips, clip] })), clip];
}

// ─── [S3 midi] MIDI clips ───

/** Add a MIDI clip on a track. `offset`/`duration` let it line up exactly with the audio clip
 *  it was extracted from (same source length); by default it spans the whole source. */
export function addMidiClip(
  s: Session,
  trackId: string,
  a: { name: string; midi: MidiData; sourceDuration: number; start?: number; offset?: number; duration?: number },
): [Session, Clip] {
  getTrack(s, trackId);
  const [s1, srcId] = nextId(s, 'm');
  const s2 = addSource(s1, { id: srcId, name: a.name, duration: Math.max(a.sourceDuration, 0.01), origin: 'generated' });
  const [s3, clip] = addClip(s2, trackId, srcId, a.start ?? 0);
  const offset = round(Math.min(Math.max(0, a.offset ?? 0), clip.duration - 0.01));
  const duration = round(Math.min(a.duration ?? clip.duration, clip.duration - offset));
  const out = { ...clip, offset, duration, midi: a.midi };
  return [mapClip(s3, clip.id, () => out), out];
}

export function setClipMidi(s: Session, clipId: string, midi: MidiData): Session {
  const { clip } = findClip(s, clipId);
  if (!clip.midi) throw new SessionError(`clip ${clipId} is audio, not MIDI`);
  return mapClip(s, clipId, (c) => ({ ...c, midi }));
}
// ─── end [S3 midi] ───

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

/** Move a clip in time and, with `trackId`, onto another track (it keeps its id). */
export function moveClip(s: Session, clipId: string, start: number, trackId?: string): Session {
  const { track, clip } = findClip(s, clipId);
  const moved = { ...clip, start: round(Math.max(0, start)) };
  if (!trackId || trackId === track.id) return mapClip(s, clipId, () => moved);
  getTrack(s, trackId);
  return {
    ...s,
    tracks: s.tracks.map((t) =>
      t.id === track.id ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t.id === trackId ? { ...t, clips: [...t.clips, moved] } : t,
    ),
    selection: s.selection.clipId === clipId ? { trackId, clipId } : s.selection,
  };
}

/** Copy a clip (same source, trim and MIDI notes, so it sounds the same) to `start` on a
 *  track, by default the clip's own track. The copy gets a new id. */
export function duplicateClip(s: Session, clipId: string, start: number, trackId?: string): [Session, Clip] {
  const { track, clip } = findClip(s, clipId);
  const to = trackId ?? track.id;
  getTrack(s, to);
  const [s1, id] = nextId(s, 'c');
  const copy: Clip = { ...clip, id, start: round(Math.max(0, start)) };
  return [mapTrack(s1, to, (t) => ({ ...t, clips: [...t.clips, copy] })), copy];
}

/** Record-arm one track (or none). Like a single-input setup in Logic, one track is armed at a time. */
export function setArm(s: Session, trackId: string, armed: boolean): Session {
  getTrack(s, trackId);
  return { ...s, tracks: s.tracks.map((t) => ({ ...t, armed: t.id === trackId ? armed : armed ? false : t.armed })) };
}

export function deleteClip(s: Session, clipId: string): Session {
  const { track } = findClip(s, clipId);
  return {
    ...mapTrack(s, track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })),
    selection: s.selection.clipId === clipId ? { trackId: track.id, clipId: null } : s.selection,
  };
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

/** A tempo change the way Logic and GarageBand make one: regions keep their bar positions
 *  (starts scale), MIDI stretches with the bars (notes, length, trim and its source length),
 *  and audio plays as recorded (no time-stretch). The punch-in range and a stopped playhead
 *  move with the bars too.
 *  setTempo alone only relabels the grid (for adopting a detected tempo). */
export function changeTempo(s: Session, bpm: number): Session {
  const s1 = setTempo(s, bpm);
  const k = s.tempo / s1.tempo;
  if (k === 1) return s1;
  const r6 = (x: number) => Math.round(x * k * 1e6) / 1e6;
  const midiSources = new Set(s.tracks.flatMap((t) => t.clips.filter((c) => c.midi).map((c) => c.sourceId)));
  const sources = { ...s1.sources };
  for (const id of midiSources) if (sources[id]) sources[id] = { ...sources[id], duration: r6(sources[id].duration) };
  return {
    ...s1,
    sources,
    tracks: s1.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        c.midi
          ? { ...c, start: r6(c.start), offset: r6(c.offset), duration: r6(c.duration), midi: { ...c.midi, notes: c.midi.notes.map((n) => ({ ...n, start: r6(n.start), duration: r6(n.duration) })) } }
          : { ...c, start: r6(c.start) },
      ),
    })),
    punchIn: s1.punchIn && { ...s1.punchIn, start: r6(s1.punchIn.start), end: r6(s1.punchIn.end) },
    // while playing, the session's position is stale; the renderer moves the live playhead
    transport: s.transport.playing ? s1.transport : setTransport(s1, 'locate', s.transport.position * k).transport,
  };
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
export function summarize(s: Session, opts: { savedChains?: string[]; versions?: string } = {}): string {
  const saved = opts.savedChains?.length ? `\nSaved chains: ${opts.savedChains.map((n) => JSON.stringify(n)).join(', ')} (load_chain puts one on a track).` : '';
  const versions = opts.versions ? `\nVersions: ${opts.versions}` : '';
  const kits = describeKits(s);
  return summarizeSession(s) + (kits ? `\n${kits}` : '') + saved + versions;
}

function summarizeSession(s: Session): string {
  const click = s.metronome.on ? `click on${s.metronome.countIn ? ', 1-bar count-in' : ''}` : 'click off';
  const header = `Tempo ${s.tempo} BPM, ${s.timeSignature.join('/')}, key ${s.key ?? 'not set'}, ${click}.`;
  if (!s.tracks.length) return `${header}\nSession is empty (no tracks).`;
  const lines = s.tracks.map((t) => {
    const flags = [t.muted && 'muted', t.soloed && 'soloed', t.armed && 'record-armed'].filter(Boolean).join(', ');
    const clips = t.clips
      .map((c) => {
        const done = s.sources[c.sourceId]?.processed; // B3
        const orig = done ? rootSource(s, c.sourceId) : null; // use_audio_version brings it back
        return `${c.id} "${c.name}" ${round(c.start)}-${round(c.start + c.duration)}s${c.midi ? ` [${describeMidi(c.midi)}]` : ''}${done ? ` [audio: ${done}${orig !== c.sourceId ? `; original ${orig}` : ''}]` : ''}`;
      })
      .join('; ');
    const fx = describeChain(t);
    return `- ${t.id} "${t.name}" gain ${t.gainDb} dB${flags ? ` (${flags})` : ''}: ${clips || 'no clips'}${fx ? `\n  fx: ${fx}` : ''}`;
  });
  const sel = s.selection.clipId ? `selected clip ${s.selection.clipId}` : s.selection.trackId ? `selected track ${s.selection.trackId}` : 'nothing selected';
  const punch = s.punchIn ? `; punch-in armed on ${s.punchIn.trackId} ${s.punchIn.start}-${s.punchIn.end}s` : '';
  return `${header}\n${lines.join('\n')}\n(${sel}; ${s.transport.playing ? 'playing' : 'stopped'} at ${round(s.transport.position)}s${punch})`;
}

/** Text view of a track's insert chain for Muse, e.g. `d3 eq(b3_gain=3 dB) -> d4 comp[off](defaults)`. */
export function describeChain(t: Track): string {
  return (t.devices ?? []).map((d) => `${d.id} ${d.kind}${d.on ? '' : '[bypassed]'}(${describeSettings(d.kind, d.params)})`).join(' -> ');
}
