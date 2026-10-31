// Session model: the single source of truth that both the user (via the UI) and Muse
// (via tools) edit. Plain JSON, times in seconds, no audio data (audio lives in the
// renderer's audio store, keyed by source id). Every op is pure: (session, ...) -> session.

import { describeSettings, type ParamValues } from '../fx/catalog';
import { describeMidi, noteName, type MidiData, type MidiNote } from './midi'; // [S3 midi]
import { describeKits, emptyPad, type Kit } from './kit'; // B12 sample pads
import { barLength } from './metronome';
import { colorName } from './trackColors'; // B16
import { mixViewLine, type MixView } from './mixView'; // B18 dry / wet listening
import { framesLine, type FrameLayout } from './frames'; // movable frames (set_layout)
import { voiceLine } from './voiceTools'; // B14 spoken replies

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
  /** B16: fade-in / fade-out length (s) at the clip's edges. Absent = none. */
  fadeIn?: number;
  fadeOut?: number;
  /** B20: the key detect_key found in its notes (or its extracted stems'), e.g. "A minor".
   *  Dropped when the notes change. */
  key?: string;
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
  /** Palette slot for the track's colour, given when it is made so a moved track keeps its
   *  colour (Logic). Absent (older sessions) = its position. A view setting, not shown to Muse. */
  color?: number;
  clips: Clip[];
  devices: DeviceInstance[]; // insert chain, in signal order (fx/chain.ts edits it)
}

export interface Session {
  tracks: Track[];
  sources: Record<string, Source>;
  /** `clipIds` lists every selected clip when more than one is (shift/cmd-click or a marquee);
   *  `clipId` is then the one clicked last. Absent = just `clipId`. `notes`: the notes selected in
   *  the Piano Roll, as indexes into `clipId`'s notes (start order); read it with selectedNotes(). */
  selection: { trackId: string | null; clipId: string | null; clipIds?: string[]; notes?: number[] };
  /** `command` + `rev` let the UI replay a transport request even when the values repeat. */
  transport: { playing: boolean; position: number; command: 'play' | 'stop' | 'locate'; rev: number };
  tempo: number; // BPM (quarter notes)
  timeSignature: [number, number]; // e.g. [4, 4], [6, 8]
  key: string | null; // e.g. "G minor"
  metronome: { on: boolean; countIn: boolean }; // click during play/record; 1-bar count-in before recording
  punchIn: { trackId: string; start: number; end: number } | null;
  /** Cycle (loop) area in seconds, Logic's Cycle: playback and recording loop start..end while
   *  `on`. A transport setting: undo keeps it. Absent (older sessions) = off. */
  cycle?: Cycle;
  /** B12: drum pads (kits), by id. Optional for older sessions. */
  kits?: Record<string, Kit>;
  /** B18: listening dry (every effect bypassed) or wet. A view setting: undo keeps it. Absent = wet. */
  mixView?: MixView;
  /** B14: read Muse's replies aloud (core/voiceTools.ts). Absent = off. A preference: undo keeps it. */
  voiceReply?: boolean;
  /** Where the Ideas, Arrangement and editor frames sit on screen (core/frames.ts). App-wide: the
   *  renderer keeps it and mirrors it here so Muse sees it. A view setting: undo keeps it. */
  frames?: FrameLayout;
  seq: number; // id counter, keeps ids short and deterministic (t1, c2, ...)
}

export interface Cycle {
  on: boolean;
  start: number;
  end: number;
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
  const color = s1.tracks.length ? Math.max(...s1.tracks.map((t, i) => t.color ?? i)) + 1 : 0;
  const track: Track = { id, name: name || `Track ${s1.tracks.length + 1}`, gainDb: 0, muted: false, soloed: false, color, clips: [], devices: [] };
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
    ? { ...k, pads: k.pads.map((p, i) => (p.sample?.sourceId === sourceId ? emptyPad(s, p, i) : p)) }
    : k]));
  return {
    ...s,
    sources,
    ...(kits ? { kits } : {}),
    // MIDI takes played with it keep their notes and go back to the piano
    tracks: s.tracks.map((t) => (t.clips.some((c) => gone.has(c.id) || c.midi?.sample?.sourceId === sourceId)
      ? { ...t, clips: t.clips.filter((c) => !gone.has(c.id)).map((c) => (c.midi?.sample?.sourceId === sourceId ? { ...c, midi: { notes: c.midi.notes, instrument: 'piano' } } : c)) }
      : t)),
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
  return mapClip(s, clipId, ({ key: _stale, ...c }) => ({ ...c, midi })); // B20: new notes, key unknown
}

/** Play a MIDI clip's notes on another instrument: its notes (and key) stay, the sound changes. */
export function setClipVoice(s: Session, clipId: string, voice: Omit<MidiData, 'notes'>): Session {
  const { clip } = findClip(s, clipId);
  if (!clip.midi) throw new SessionError(`clip ${clipId} is audio, not MIDI`);
  return mapClip(s, clipId, (c) => ({ ...c, midi: { ...voice, notes: clip.midi!.notes } }));
}

/** A MIDI clip's new notes, sorted by start (then pitch), with the Piano Roll's note selection
 *  following its notes through the sort. `selected` indexes `notes`; absent, a selection on this
 *  clip is kept when `notes` lines up with the old notes (same count), else cleared. */
export function setClipNotes(s: Session, clipId: string, notes: MidiNote[], selected?: Iterable<number>): Session {
  const { clip } = findClip(s, clipId);
  if (!clip.midi) throw new SessionError(`clip ${clipId} is audio, not MIDI`);
  const ours = s.selection.clipId === clipId;
  const sel = new Set(selected ?? (ours && notes.length === clip.midi.notes.length ? selectedNotes(s) : []));
  const tagged = notes.map((n, i) => ({ n, sel: sel.has(i) })).sort((a, b) => a.n.start - b.n.start || a.n.pitch - b.n.pitch);
  const out = setClipMidi(s, clipId, { ...clip.midi, notes: tagged.map((t) => t.n) });
  if (!ours) return out;
  const { notes: _old, ...rest } = out.selection;
  const idx = tagged.flatMap((t, i) => (t.sel ? [i] : []));
  return { ...out, selection: idx.length ? { ...rest, notes: idx } : rest };
}

/** Select notes of a MIDI clip (Piano Roll), which also selects the clip. Indexes past the
 *  last note are dropped; none = no notes selected. */
export function selectNotes(s: Session, clipId: string, indexes: number[]): Session {
  const { track, clip } = findClip(s, clipId);
  if (!clip.midi) throw new SessionError(`clip ${clipId} is audio, not MIDI`);
  const n = clip.midi.notes.length;
  const idx = [...new Set(indexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);
  return { ...s, selection: { trackId: track.id, clipId, ...(idx.length ? { notes: idx } : {}) } };
}

/** The selected clip's selected notes (indexes, start order); [] when none or out of date. */
export function selectedNotes(s: Session): number[] {
  const { clipId, notes } = s.selection;
  if (!clipId || !notes?.length) return [];
  const clip = s.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  const n = clip?.midi?.notes.length ?? 0;
  return notes.filter((i) => i < n);
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
  // a MIDI region's end can go past its notes (Logic): the source grows, the render pads with silence
  const b = clip.midi ? end : Math.min(end, sourceEnd);
  if (!(b - a > 0.01)) {
    throw new SessionError(`trim [${start}, ${end}] leaves nothing of clip ${clipId} (audio spans ${round(sourceStart)}-${round(sourceEnd)} s)`);
  }
  const s1 = clip.midi && src && b > sourceEnd + 1e-6 ? { ...s, sources: { ...s.sources, [clip.sourceId]: { ...src, duration: round(b - sourceStart) } } } : s;
  return mapClip(s1, clipId, (c) => ({ ...c, start: round(a), offset: round(a - sourceStart), duration: round(b - a) }));
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

/** B13: cut an audio clip at drum hits (source seconds, each with a drum `kind`) and move each
 *  slice to a new track for its drum, right after the clip's track and with its gain and effects,
 *  so the slices sound as the clip did. Slices abut: the first runs from the clip's left edge
 *  (with the drum ringing there), each ends at the next hit, so together they play the clip
 *  exactly. Tracks come in `order` (kinds not in it last); the clip itself goes. */
export function sliceClipByDrum(
  s: Session,
  clipId: string,
  hits: { time: number; kind: string }[],
  order: string[] = [],
): { session: Session; tracks: { track: Track; kind: string }[] } {
  const { track, clip } = findClip(s, clipId);
  if (clip.midi) throw new SessionError(`clip ${clipId} is MIDI; slicing by drum needs audio`);
  const end = clip.offset + clip.duration;
  const sorted = [...hits].sort((a, b) => a.time - b.time);
  const cuts: { time: number; kind: string }[] = [];
  for (const h of sorted) {
    const last = cuts.length ? cuts[cuts.length - 1].time : clip.offset;
    if (h.time > last + 0.01 && h.time < end - 0.01) cuts.push(h);
  }
  if (!cuts.length) throw new SessionError(`no drum hits found inside clip ${clipId}`);
  // what plays at the left edge: the last hit at or before it, else the first one after
  const first = sorted.filter((h) => h.time <= clip.offset + 0.01).pop() ?? cuts[0];
  const edges = [clip.offset, ...cuts.map((c) => c.time), end].map(round);
  const kinds = [first.kind, ...cuts.map((c) => c.kind)];
  if (first === cuts[0]) edges.splice(1, 1), kinds.splice(1, 1); // the first hit's slice starts at the edge
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const used = [...new Set(kinds)].sort((a, b) => rank(a) - rank(b));
  let out = s;
  const made: { track: Track; kind: string }[] = [];
  for (const kind of used) {
    const [s1, id] = nextId(out, 't');
    out = s1;
    const devices: DeviceInstance[] = [];
    for (const d of track.devices) {
      const [s2, did] = nextId(out, 'd');
      out = s2;
      devices.push({ ...d, id: did, params: { ...d.params } });
    }
    const t: Track = { id, name: `${track.name} ${kind[0].toUpperCase()}${kind.slice(1)}`, gainDb: track.gainDb, muted: track.muted, soloed: track.soloed, clips: [], devices };
    let n = 0;
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== kind) continue;
      const [s3, cid] = nextId(out, 'c');
      out = s3;
      t.clips.push({ id: cid, sourceId: clip.sourceId, name: `${t.name.slice(track.name.length + 1)} ${++n}`, start: round(clip.start + edges[i] - clip.offset), offset: edges[i], duration: round(edges[i + 1] - edges[i]) });
    }
    made.push({ track: t, kind });
  }
  const at = out.tracks.findIndex((t) => t.id === track.id);
  const tracks = out.tracks.map((t) => (t.id === track.id ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t));
  tracks.splice(at + 1, 0, ...made.map((m) => m.track));
  const selection = s.selection.clipId === clipId ? { trackId: made[0].track.id, clipId: null } : s.selection;
  return { session: { ...out, tracks, selection }, tracks: made };
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
    selection: s.selection.clipIds?.includes(clipId)
      ? select(s, s.selection.trackId, s.selection.clipId === clipId ? null : s.selection.clipId, s.selection.clipIds.filter((c) => c !== clipId)).selection
      : s.selection.clipId === clipId ? { trackId: track.id, clipId: null } : s.selection,
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

/** Turn the cycle on or off and/or move it. A new area must have end > start; turning it on with
 *  no area yet uses bars 1-4 (the UI's default). */
export function setCycle(s: Session, c: { on?: boolean; start?: number; end?: number }): Session {
  const cur = s.cycle ?? { on: false, start: 0, end: 0 };
  let start = c.start ?? cur.start;
  let end = c.end ?? cur.end;
  if (c.start != null || c.end != null) {
    if (!(start >= 0) || !(end > start)) throw new SessionError('a cycle needs 0 <= start < end');
  } else if (c.on && !(end > start)) [start, end] = [0, 4 * barLength(s)];
  return { ...s, cycle: { on: c.on ?? cur.on, start: round(start), end: round(end) } };
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
    ...(s1.cycle ? { cycle: { ...s1.cycle, start: r6(s1.cycle.start), end: r6(s1.cycle.end) } } : {}),
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

export function select(s: Session, trackId: string | null, clipId: string | null, clipIds?: string[]): Session {
  const ids = [...new Set([...(clipIds ?? []), ...(clipId ? [clipId] : [])])];
  const primary = clipId ?? ids[ids.length - 1] ?? null;
  const notes = ids.length <= 1 && primary && primary === s.selection.clipId ? s.selection.notes : undefined; // same region: notes stay selected
  return { ...s, selection: ids.length > 1 ? { trackId, clipId: primary, clipIds: ids } : { trackId, clipId: primary, ...(notes ? { notes } : {}) } };
}

/** Every selected clip id (one or none unless several are selected). */
export function selectedClipIds(s: Session): string[] {
  return s.selection.clipIds ?? (s.selection.clipId ? [s.selection.clipId] : []);
}

/** Move several clips together: each by `delta` seconds and `trackOffset` lanes (down is +),
 *  as when a multi-selection is dragged, keeping the group's shape. Clamped so every clip stays
 *  on the timeline and below the first track; past the last track it makes new ones. The
 *  selection follows. */
export function moveClips(s: Session, clipIds: string[], delta: number, trackOffset = 0): Session {
  const found = clipIds.map((id) => findClip(s, id));
  if (!found.length) return s;
  const minStart = Math.min(...found.map((f) => f.clip.start));
  const d = Math.max(delta, -minStart);
  const idx = found.map((f) => s.tracks.indexOf(f.track));
  // not above the top; below the bottom at most until the top clip reaches the first new track
  const n = s.tracks.length;
  const k = Math.max(-Math.min(...idx), Math.min(n - Math.min(...idx), Math.round(trackOffset)));
  // past the last track: new tracks below, each named after where its clips came from (as one
  // region dragged below the tracks makes one)
  let s0 = s;
  for (let row = n; row <= Math.max(...idx) + k; row++) [s0] = addTrack(s0, `${s.tracks[row - k].name} 2`);
  const ids = new Set(clipIds);
  const moved = new Map(found.map((f, i) => [f.clip.id, { clip: { ...f.clip, start: round(f.clip.start + d) }, to: s0.tracks[idx[i] + k].id }]));
  const tracks = s0.tracks.map((t) => ({
    ...t,
    clips: [...t.clips.filter((c) => !ids.has(c.id)), ...[...moved.values()].filter((m) => m.to === t.id).map((m) => m.clip)],
  }));
  const primary = s.selection.clipId ? moved.get(s.selection.clipId) : undefined;
  return { ...s0, tracks, selection: primary ? { ...s.selection, trackId: primary.to } : s.selection };
}

/** Put a track at `index` in the track list (0 = top), as when its header is dragged. */
export function moveTrack(s: Session, trackId: string, index: number): Session {
  getTrack(s, trackId);
  // pin every colour to its current slot first, so tracks of older sessions keep theirs too
  const pinned = s.tracks.map((x, i) => (x.color === undefined ? { ...x, color: i } : x));
  const t = pinned.find((x) => x.id === trackId)!;
  const rest = pinned.filter((x) => x !== t);
  const i = Math.max(0, Math.min(rest.length, Math.round(index)));
  return { ...s, tracks: [...rest.slice(0, i), t, ...rest.slice(i)] };
}

export function sessionEnd(s: Session): number {
  return s.tracks.reduce((m, t) => t.clips.reduce((m2, c) => Math.max(m2, c.start + c.duration), m), 0);
}

/** Compact text view of the session for Muse (it can't see the screen or hear audio). */
export function summarize(s: Session, opts: { savedChains?: string[]; versions?: string; shelves?: string; project?: string; setups?: string } = {}): string {
  const extra = [mixViewLine(s), opts.shelves ?? '', opts.setups ?? '', framesLine(s.frames)].filter(Boolean).map((l) => `\n${l}`).join(''); // B18, B17
  const saved = opts.savedChains?.length ? `\nSaved chains: ${opts.savedChains.map((n) => JSON.stringify(n)).join(', ')} (load_chain puts one on a track).` : '';
  const versions = opts.versions ? `\nVersions: ${opts.versions}` : '';
  const kits = describeKits(s);
  const voice = voiceLine(s) ? `\n${voiceLine(s)}` : ''; // B14
  const project = opts.project ? `\n${opts.project}` : ''; // Oct 30
  return summarizeSession(s) + (kits ? `\n${kits}` : '') + project + saved + versions + extra + voice;
}

function summarizeSession(s: Session): string {
  const click = s.metronome.on ? `click on${s.metronome.countIn ? ', 1-bar count-in' : ''}` : 'click off';
  const header = `Tempo ${s.tempo} BPM, ${s.timeSignature.join('/')}, key ${s.key ?? 'not set'}, ${click}.`;
  if (!s.tracks.length) return `${header}\nSession is empty (no tracks).`;
  const lines = s.tracks.map((t, i) => {
    const flags = [t.muted && 'muted', t.soloed && 'soloed', t.armed && 'record-armed'].filter(Boolean).join(', ');
    const clips = t.clips
      .map((c) => {
        const done = s.sources[c.sourceId]?.processed; // B3
        const orig = done ? rootSource(s, c.sourceId) : null; // use_audio_version brings it back
        const fades = [c.fadeIn && `fade in ${c.fadeIn}s`, c.fadeOut && `fade out ${c.fadeOut}s`].filter(Boolean).join(', '); // B16
        return `${c.id} "${c.name}" ${round(c.start)}-${round(c.start + c.duration)}s${c.midi ? ` [${describeMidi(c.midi)}]` : ''}${done ? ` [audio: ${done}${orig !== c.sourceId ? `; original ${orig}` : ''}]` : ''}${c.key ? ` [key ${c.key}, detected]` : ''}` +
          ` (bar ${barOf(s, c.start)} to ${barOf(s, c.start + c.duration)}${fades ? `; ${fades}` : ''})`;
      })
      .join('; ');
    const fx = describeChain(t);
    return `- (${colorName(t.color, i)}) ${t.id} "${t.name}" gain ${t.gainDb} dB${flags ? ` (${flags})` : ''}: ${clips || 'no clips'}${fx ? `\n  fx: ${fx}` : ''}`;
  });
  const multi = s.selection.clipIds;
  // B16: name what is selected, so "this" resolves without looking ids up
  const clipRef = (id: string) => {
    const f = s.tracks.flatMap((t) => t.clips.map((c) => ({ t, c }))).find((x) => x.c.id === id);
    return f ? `${id} ("${f.c.name}" on ${f.t.id} "${f.t.name}")` : id;
  };
  const selTrack = s.tracks.find((t) => t.id === s.selection.trackId);
  const sel = multi ? `selected clips ${multi.join(', ')}` : s.selection.clipId ? `selected clip ${clipRef(s.selection.clipId)}${describeSelectedNotes(s)}` : selTrack ? `selected track ${selTrack.id} "${selTrack.name}"` : 'nothing selected';
  const punch = s.punchIn ? `; punch-in armed on ${s.punchIn.trackId} ${s.punchIn.start}-${s.punchIn.end}s` : '';
  const cyc = s.cycle?.on ? `; cycle on, bars ${barOf(s, s.cycle.start)}-${round(barOf(s, s.cycle.end) - 1)} (play starts at bar ${barOf(s, s.cycle.start)})` : '';
  const bars = `Bars are 1-based: bar n starts at ${round(barLength(s))} * (n-1) s; "bar 5.5" is halfway through bar 5, and a clip "bar 1 to 5" fills bars 1-4.`;
  return `${header}\n${bars}\n${lines.join('\n')}\n(${sel}; ${s.transport.playing ? 'playing' : 'stopped'} at ${round(s.transport.position)}s, bar ${barOf(s, s.transport.position)}${cyc}${punch})`;
}

/** The Piano Roll's note selection for Muse: which notes (name, bar) and their indexes, so
 *  "these notes" become a tool's `notes` argument. */
function describeSelectedNotes(s: Session): string {
  const idx = selectedNotes(s);
  if (!idx.length) return '';
  const clip = s.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selection.clipId)!;
  const ns = clip.midi!.notes;
  const show = idx.slice(0, 8).map((i) => `${noteName(ns[i].pitch)} bar ${barOf(s, clip.start - clip.offset + ns[i].start)}`);
  const more = idx.length > show.length ? `, +${idx.length - show.length} more` : '';
  return `, with ${idx.length} of its ${ns.length} notes selected in the Piano Roll (${show.join(', ')}${more}; "these notes" = notes [${idx.join(',')}])`;
}

/** B16: timeline seconds -> 1-based bar position (decimals inside a bar), for Muse. */
export const barOf = (s: Session, seconds: number) => Math.round((seconds / barLength(s) + 1) * 100) / 100;
/** B16: 1-based bar position -> timeline seconds. */
export const barToSeconds = (s: Session, bar: number) => round((bar - 1) * barLength(s));

/** Text view of a track's insert chain for Muse, e.g. `d3 eq(b3_gain=3 dB) -> d4 comp[off](defaults)`. */
export function describeChain(t: Track): string {
  return (t.devices ?? []).map((d) => `${d.id} ${d.kind}${d.on ? '' : '[bypassed]'}(${describeSettings(d.kind, d.params)})`).join(' -> ');
}
