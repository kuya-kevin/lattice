// Every action on the session is a typed tool call with a JSON schema: Muse calls the
// visible ones; the UI calls the same tools (plus a few user-only ones) on the user's
// behalf, and those user calls are logged as feedback for Muse's next turn.
import * as S from './session';
import type { Sidecar } from './sidecar';
import { SYNTH_KNOBS } from './sidecar';
import type { Actor, SessionStore } from './store';
import type { FreesoundFilters, FreesoundHit } from './freesound';
import { FX_TOOLS } from '../fx/tools';
import { MIDI_TOOLS } from './midiTools'; // [S3 midi]

export type JsonSchema = {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolContext {
  store: SessionStore;
  sidecar: Sidecar;
  searchFreesound: (query: string, filters: FreesoundFilters, max: number) => Promise<{ count: number; results: FreesoundHit[] }>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** user-only tools are hidden from Muse (they need audio the renderer holds) */
  userOnly?: boolean;
  /** quiet tools (transport, selection) aren't logged as user feedback or undo history */
  quiet?: boolean;
  /** undo/redo themselves don't create history entries */
  noHistory?: boolean;
  /** readable text for the hand-edit log Muse sees (default: name + JSON args) */
  logText?: (args: any, result: any) => string;
  run(ctx: ToolContext, args: any, by?: Actor): Promise<unknown> | unknown;
}

const num = (description: string, extra: object = {}) => ({ type: 'number', description, ...extra });
const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Record<string, any>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Apply a pure session op through the store. */
function edit(ctx: ToolContext, fn: (s: S.Session) => S.Session): S.Session {
  const next = fn(ctx.store.get());
  ctx.store.set(next);
  return next;
}

function trackOfClipSource(s: S.Session, trackId: string): string {
  const t = S.getTrack(s, trackId);
  if (!t.clips.length) throw new S.SessionError(`track ${trackId} has no clips`);
  return t.clips[0].sourceId;
}

const range = (description: string) => ({
  type: 'object',
  description,
  properties: { min: { type: 'number' }, max: { type: 'number' } },
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  // ---- session / engineer tools ----
  {
    name: 'list_tracks',
    description: 'List tracks and clips in the session (ids, names, positions in seconds, gain, mute/solo).',
    parameters: obj({}),
    quiet: true,
    run: (ctx) => ({ summary: S.summarize(ctx.store.get()), tracks: ctx.store.get().tracks }),
  },
  {
    name: 'add_track',
    description: 'Add an empty track (e.g. to record onto).',
    parameters: obj({ name: str('Track name') }),
    run: (ctx, a) => {
      let track!: S.Track;
      edit(ctx, (s) => {
        const [s1, t] = S.addTrack(s, a.name);
        track = t;
        return s1;
      });
      return { track_id: track.id, name: track.name };
    },
  },
  {
    name: 'rename_track',
    description: 'Rename a track.',
    parameters: obj({ track_id: str('Track id, e.g. "t1"'), name: str('New name') }, ['track_id', 'name']),
    run: (ctx, a) => {
      const from = S.getTrack(ctx.store.get(), a.track_id).name;
      const s = edit(ctx, (s) => S.renameTrack(s, a.track_id, a.name));
      return { track_id: a.track_id, from, name: S.getTrack(s, a.track_id).name };
    },
    logText: (_a, r) => `renamed track ${r.track_id} from "${r.from}" to "${r.name}"`,
  },
  {
    name: 'delete_track',
    description: 'Delete a track and all its clips (undoable).',
    parameters: obj({ track_id: str('Track id') }, ['track_id']),
    run: (ctx, a) => {
      const t = S.getTrack(ctx.store.get(), a.track_id);
      edit(ctx, (s) => S.deleteTrack(s, a.track_id));
      return { deleted: a.track_id, name: t.name, clips: t.clips.length };
    },
    logText: (_a, r) => `deleted track ${r.deleted} "${r.name}" (${r.clips} clip${r.clips === 1 ? '' : 's'})`,
  },
  {
    name: 'trim_clip',
    description:
      'Trim a clip so it plays only from start to end (timeline seconds). The audio stays in place; ' +
      'edges are clamped to the recorded audio. Defaults to the selected clip.',
    parameters: obj(
      { clip_id: str('Clip id, e.g. "c2". Omit to use the selected clip.'), start: num('New start, timeline seconds'), end: num('New end, timeline seconds') },
      ['start', 'end'],
    ),
    run: (ctx, a) => {
      const clipId = a.clip_id ?? ctx.store.get().selection.clipId;
      if (!clipId) throw new S.SessionError('no clip_id given and no clip selected');
      const s = edit(ctx, (s) => S.trimClip(s, clipId, a.start, a.end));
      const { clip } = S.findClip(s, clipId);
      return { clip_id: clipId, start: clip.start, end: clip.start + clip.duration };
    },
  },
  {
    name: 'set_gain',
    description: 'Set a track\'s gain in dB (-60 to +12; 0 is unity).',
    parameters: obj({ track_id: str('Track id, e.g. "t1"'), gain_db: num('Gain in dB') }, ['track_id', 'gain_db']),
    run: (ctx, a) => {
      const s = edit(ctx, (s) => S.setGain(s, a.track_id, a.gain_db));
      return { track_id: a.track_id, gain_db: S.getTrack(s, a.track_id).gainDb };
    },
  },
  {
    name: 'mute',
    description: 'Mute or unmute a track.',
    parameters: obj({ track_id: str('Track id'), muted: { type: 'boolean', description: 'true to mute (default), false to unmute' } }, ['track_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.setMute(s, a.track_id, a.muted ?? true));
      return { track_id: a.track_id, muted: a.muted ?? true };
    },
  },
  {
    name: 'solo',
    description: 'Solo or unsolo a track.',
    parameters: obj({ track_id: str('Track id'), soloed: { type: 'boolean', description: 'true to solo (default), false to unsolo' } }, ['track_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.setSolo(s, a.track_id, a.soloed ?? true));
      return { track_id: a.track_id, soloed: a.soloed ?? true };
    },
  },
  {
    name: 'arm_punch_in',
    description: 'Arm a punch-in recording on a track between start and end (seconds). The user then presses record.',
    parameters: obj({ track_id: str('Track id'), start: num('Punch-in start (s)'), end: num('Punch-out end (s)') }, ['track_id', 'start', 'end']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.armPunchIn(s, a.track_id, a.start, a.end));
      return { armed: true, track_id: a.track_id, start: a.start, end: a.end, note: 'waiting for the user to press record' };
    },
  },
  {
    name: 'play',
    description: 'Start playback, optionally from a position in seconds.',
    parameters: obj({ from: num('Start position (s); omit to play from the playhead') }),
    quiet: true,
    run: (ctx, a) => {
      edit(ctx, (s) => S.setTransport(s, 'play', a.from));
      return { playing: true, from: ctx.store.get().transport.position };
    },
  },
  {
    name: 'stop',
    description: 'Stop playback; the playhead stays where it stopped.',
    parameters: obj({ at: num('Where playback stopped (s); set by the UI, omit when calling as the assistant') }),
    quiet: true,
    run: (ctx, a) => {
      edit(ctx, (s) => S.setTransport(s, 'stop', a.at));
      return { playing: false };
    },
  },
  {
    name: 'go_to',
    description: 'Move the playhead to a position in seconds (0 = beginning). Keeps playing if playing.',
    parameters: obj({ position: num('Position (s)') }, ['position']),
    quiet: true,
    run: (ctx, a) => {
      edit(ctx, (s) => S.setTransport(s, 'locate', a.position));
      return { position: ctx.store.get().transport.position };
    },
  },
  {
    name: 'move_clip',
    description:
      'Move a clip to a new timeline start (seconds), optionally onto another track (track_id). ' +
      'The clip keeps its trim and id. Use the session tempo to land on bars: bar n starts at (n-1) * beats_per_bar * 60/BPM s (for x/4).',
    parameters: obj({ clip_id: str('Clip id, e.g. "c2"'), start: num('New start, timeline seconds'), track_id: str('Destination track id; omit to stay on the same track') }, ['clip_id', 'start']),
    run: (ctx, a) => {
      const from = S.findClip(ctx.store.get(), a.clip_id);
      const s = edit(ctx, (s) => S.moveClip(s, a.clip_id, a.start, a.track_id));
      const to = S.findClip(s, a.clip_id);
      return { clip_id: a.clip_id, from_track: from.track.id, from_start: from.clip.start, track_id: to.track.id, start: to.clip.start };
    },
    logText: (a, r) =>
      r.from_track === r.track_id
        ? `moved clip ${r.clip_id} on ${r.track_id} from ${r.from_start}s to ${r.start}s`
        : `moved clip ${r.clip_id} from ${r.from_track} @${r.from_start}s to ${r.track_id} @${r.start}s`,
  },
  {
    name: 'delete_clip',
    description: 'Delete a clip from the arrangement (its audio stays available for undo).',
    parameters: obj({ clip_id: str('Clip id') }, ['clip_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.deleteClip(s, a.clip_id));
      return { deleted: a.clip_id };
    },
  },
  {
    name: 'delete_sound',
    description: 'Delete a sound (source) from the session and every clip that uses it (undoable). The user does this from the Ideas column.',
    parameters: obj({ source_id: str('Source id (a clip\'s source)') }, ['source_id']),
    run: (ctx, a) => {
      const before = ctx.store.get();
      const name = before.sources[a.source_id]?.name;
      const used = before.tracks.reduce((n, t) => n + t.clips.filter((c) => c.sourceId === a.source_id).length, 0);
      edit(ctx, (s) => S.deleteSource(s, a.source_id));
      return { deleted: a.source_id, name, clips_removed: used };
    },
    logText: (_a, r) => `deleted sound "${r.name}" (${r.deleted}) and its ${r.clips_removed} clip(s)`,
  },
  {
    name: 'duplicate_clip',
    description:
      'Copy a clip (same audio or MIDI notes, same trim) to a timeline start (seconds), optionally on another track. ' +
      'The copy gets a new id and becomes the selected clip. The user\'s copy/paste (Cmd-C, Cmd-V) uses this.',
    parameters: obj({ clip_id: str('Clip to copy, e.g. "c2"'), start: num('Start of the copy, timeline seconds'), track_id: str('Destination track id; omit for the same track') }, ['clip_id', 'start']),
    run: (ctx, a) => {
      let out!: { clip_id: string; track_id: string; start: number };
      edit(ctx, (s) => {
        const [s1, c] = S.duplicateClip(s, a.clip_id, a.start, a.track_id);
        const trackId = S.findClip(s1, c.id).track.id;
        out = { clip_id: c.id, track_id: trackId, start: c.start };
        return S.select(s1, trackId, c.id);
      });
      return { ...out, from_clip: a.clip_id };
    },
    logText: (_a, r) => `copied clip ${r.from_clip} to ${r.track_id} @${r.start}s as clip ${r.clip_id}`,
  },
  {
    name: 'set_track_height',
    description: 'Lane height of one track, relative to the global track height (view only).',
    userOnly: true,
    quiet: true,
    parameters: obj({ track_id: str('Track id'), scale: num('Height multiplier; omit to reset') }, ['track_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.setTrackHeight(s, a.track_id, a.scale ?? null));
      return { track_id: a.track_id, scale: a.scale ?? 1 };
    },
  },
  {
    name: 'arm_track',
    description: 'Record-arm a track (the next recording goes onto it) or disarm it. One track is armed at a time.',
    parameters: obj({ track_id: str('Track id'), armed: { type: 'boolean', description: 'true to arm (default), false to disarm' } }, ['track_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => S.setArm(s, a.track_id, a.armed ?? true));
      return { track_id: a.track_id, armed: a.armed ?? true };
    },
  },
  {
    name: 'set_tempo',
    description: `Set the project tempo in BPM (${S.TEMPO_RANGE[0]}-${S.TEMPO_RANGE[1]}). Drives the click, the bar/beat grid and quantize.`,
    parameters: obj({ bpm: num('Beats per minute') }, ['bpm']),
    run: (ctx, a) => ({ tempo: edit(ctx, (s) => S.setTempo(s, a.bpm)).tempo }),
  },
  {
    name: 'set_time_signature',
    description: 'Set the time signature, e.g. beats 3, unit 4 for 3/4; beats 6, unit 8 for 6/8.',
    parameters: obj({ beats: num('Beats per bar (1-16)'), unit: num('Beat unit: 2, 4, 8 or 16') }, ['beats', 'unit']),
    run: (ctx, a) => ({ time_signature: edit(ctx, (s) => S.setTimeSignature(s, a.beats, a.unit)).timeSignature.join('/') }),
  },
  {
    name: 'set_key',
    description: 'Set the project key, e.g. "G minor", "Eb major", "F#m". Empty string clears it.',
    parameters: obj({ key: str('Key name') }, ['key']),
    run: (ctx, a) => ({ key: edit(ctx, (s) => S.setKey(s, a.key)).key }),
  },
  {
    name: 'set_metronome',
    description: 'Turn the click (metronome) on/off during playback and recording, and/or the 1-bar count-in before recording.',
    parameters: obj({ on: { type: 'boolean', description: 'Click on/off' }, count_in: { type: 'boolean', description: '1-bar count-in on/off' } }),
    run: (ctx, a) => edit(ctx, (s) => S.setMetronome(s, a.on, a.count_in)).metronome,
  },
  {
    name: 'quantize_drums',
    description: 'Quantize a drum track to the project tempo: slice at onsets and snap them to a grid (no time-stretch). strength 0-1 (1 = hard snap).',
    parameters: obj(
      {
        track_id: str('Drum track id'),
        grid: str('Grid', { enum: ['1/4', '1/8', '1/16', '1/32'] }),
        strength: num('0-1, how far to move each hit toward the grid', { minimum: 0, maximum: 1 }),
      },
      ['track_id', 'grid', 'strength'],
    ),
    run: async (ctx, a) => {
      const s = ctx.store.get();
      const sourceId = trackOfClipSource(s, a.track_id);
      const r = await ctx.sidecar.quantizeDrums({ sourceId, grid: a.grid, strength: a.strength, bpm: s.tempo });
      return { track_id: a.track_id, bpm: s.tempo, ...r, stub: true };
    },
  },
  {
    name: 'cleanup_noise',
    description: 'Remove steady background noise (hiss, hum, room tone) from a track\'s audio.',
    parameters: obj({ track_id: str('Track id') }, ['track_id']),
    run: async (ctx, a) => {
      const sourceId = trackOfClipSource(ctx.store.get(), a.track_id);
      return { track_id: a.track_id, ...(await ctx.sidecar.cleanupNoise({ sourceId })), stub: true };
    },
  },

  // ---- sound tools ----
  {
    name: 'search_freesound',
    description:
      'Search Freesound (CC-licensed sounds) by text, optionally filtered by measured timbre scores ' +
      '(brightness, warmth, roughness, hardness, depth: 0-100), duration (s), bpm, pitch (Hz) or note_name. ' +
      'Returns names, tags, descriptions, licenses, timbre scores and preview URLs. You cannot hear the previews; the user can.',
    parameters: obj(
      {
        query: str('Text query, e.g. "dark analog bass"'),
        filters: {
          type: 'object',
          description: 'Optional ranges, e.g. {"brightness": {"max": 40}, "duration": {"max": 5}}',
          properties: {
            brightness: range('0-100'),
            warmth: range('0-100'),
            roughness: range('0-100'),
            hardness: range('0-100'),
            depth: range('0-100'),
            duration: range('seconds'),
            bpm: range('beats per minute'),
            pitch: range('Hz'),
            note_name: str('e.g. "A", "C#"'),
          },
          additionalProperties: false,
        },
        max_results: num('1-15, default 5'),
      },
      ['query'],
    ),
    run: async (ctx, a) => {
      const r = await ctx.searchFreesound(a.query, a.filters ?? {}, a.max_results ?? 5);
      // Freesound's text search matches words in names/tags; long queries plus tight filters often return nothing.
      return r.count ? r : { ...r, hint: 'no matches: try fewer query words (e.g. "synth bass") and move adjectives like "dark" into filters, or widen the ranges' };
    },
  },
  {
    name: 'generate_mrt2',
    description:
      'Generate audio with Magenta RT2 (local) from a style: a text description and/or a reference clip used as the style prompt. ' +
      'Good for "in the style of" textures, not exact recreation. The user judges the result by ear.',
    parameters: obj({
      style_text: str('Style description, e.g. "warm analog synth lead"'),
      reference_clip_id: str('Clip to use as the audio style prompt'),
      notes: str('What to play, e.g. "A2 for 2 beats, then C3"'),
      seconds: num('Length to generate (default 8)'),
    }),
    run: async (ctx, a) => {
      if (!a.style_text && !a.reference_clip_id) throw new S.SessionError('give style_text or reference_clip_id');
      const ref = a.reference_clip_id ? S.findClip(ctx.store.get(), a.reference_clip_id).clip.sourceId : undefined;
      return { ...(await ctx.sidecar.generateMrt2({ styleText: a.style_text, referenceSourceId: ref, notes: a.notes, seconds: a.seconds ?? 8 })), stub: true };
    },
  },
  {
    name: 'set_synth_knobs',
    description:
      'Set knobs on our 15-knob subtractive synth. Unspecified knobs keep defaults. Knobs: ' +
      Object.entries(SYNTH_KNOBS).map(([k, v]) => `${k} (${v.lo}-${v.hi} ${v.unit})`).join(', '),
    parameters: obj(
      {
        patch: {
          type: 'object',
          description: 'Knob name -> value',
          properties: Object.fromEntries(Object.entries(SYNTH_KNOBS).map(([k, v]) => [k, num(v.doc, { minimum: v.lo, maximum: v.hi })])),
          additionalProperties: false,
        },
      },
      ['patch'],
    ),
    run: async (ctx, a) => ({ ...(await ctx.sidecar.setSynthKnobs(a.patch)), stub: true }),
  },
  {
    name: 'fit_synth_to_reference',
    description: 'Fit the synth\'s knobs to a reference clip with an optimizer (CMA-ES over a spectral distance, ~30 s). Returns an editable patch.',
    parameters: obj({ clip_id: str('Reference clip id') }, ['clip_id']),
    run: async (ctx, a) => {
      const { clip } = S.findClip(ctx.store.get(), a.clip_id);
      return { ...(await ctx.sidecar.fitSynthToReference({ sourceId: clip.sourceId })), stub: true };
    },
  },

  // ---- effect chain tools (fx/tools.ts) ----
  ...FX_TOOLS,

  // ---- audio -> MIDI (core/midiTools.ts) ----
  ...MIDI_TOOLS,

  // ---- user-only (UI) tools ----
  {
    name: 'import_audio',
    description: 'Import decoded audio as a new track (the renderer holds the samples under source_id).',
    userOnly: true,
    parameters: obj(
      { source_id: str(''), name: str(''), duration: num(''), origin: str('', { enum: ['import', 'record', 'freesound', 'generated'] }) },
      ['source_id', 'name', 'duration'],
    ),
    run: (ctx, a) => {
      let out!: { track_id: string; clip_id: string };
      edit(ctx, (s) => {
        const s1 = S.addSource(s, { id: a.source_id, name: a.name, duration: a.duration, origin: a.origin ?? 'import' });
        const [s2, t] = S.addTrack(s1, a.name);
        const [s3, c] = S.addClip(s2, t.id, a.source_id, 0);
        out = { track_id: t.id, clip_id: c.id };
        return s3;
      });
      return out;
    },
  },
  {
    name: 'record_take',
    description: 'Add a recorded take to a track at a position.',
    userOnly: true,
    parameters: obj({ source_id: str(''), track_id: str(''), start: num(''), duration: num('') }, ['source_id', 'track_id', 'start', 'duration']),
    run: (ctx, a) => {
      let clipId = '';
      edit(ctx, (s) => {
        const n = s.tracks.reduce((k, t) => k + t.clips.length, 0) + 1;
        const s1 = S.addSource(s, { id: a.source_id, name: `Take ${n}`, duration: a.duration, origin: 'record' });
        const [s2, c] = S.addClip(s1, a.track_id, a.source_id, a.start);
        clipId = c.id;
        return { ...s2, punchIn: null };
      });
      return { clip_id: clipId };
    },
  },
  {
    name: 'place_audio',
    description: 'Place decoded audio (e.g. a library sound) on a track at a position; without track_id it goes on a new track.',
    userOnly: true,
    parameters: obj(
      {
        source_id: str(''),
        name: str(''),
        duration: num(''),
        origin: str('', { enum: ['import', 'record', 'freesound', 'generated'] }),
        track_id: str('Existing track; omit for a new track'),
        start: num('Timeline seconds (default 0)'),
        credit: str('Attribution text for CC-BY sounds'),
      },
      ['source_id', 'name', 'duration'],
    ),
    run: (ctx, a) => {
      let out!: { track_id: string; clip_id: string; start: number };
      edit(ctx, (s) => {
        const s1 = S.addSource(s, { id: a.source_id, name: a.name, duration: a.duration, origin: a.origin ?? 'import', ...(a.credit ? { credit: a.credit } : {}) });
        let s2 = s1;
        let trackId = a.track_id as string | undefined;
        if (!trackId) {
          const [sNew, t] = S.addTrack(s1, a.name);
          s2 = sNew;
          trackId = t.id;
        }
        const [s3, c] = S.addClip(s2, trackId, a.source_id, a.start ?? 0);
        out = { track_id: trackId, clip_id: c.id, start: c.start };
        return S.select(s3, trackId, c.id);
      });
      return out;
    },
    logText: (a, r) => `placed "${a.name}" (${a.origin ?? 'import'}) on ${a.track_id ? r.track_id : `new track ${r.track_id}`} at ${r.start}s as clip ${r.clip_id}`,
  },
  {
    name: 'undo',
    description: 'Undo the last edit.',
    userOnly: true,
    noHistory: true,
    parameters: obj({}),
    run: (ctx) => {
      const label = ctx.store.undo();
      if (!label) throw new S.SessionError('nothing to undo');
      return { undone: label };
    },
    logText: (_a, r) => `undo (${r.undone})`,
  },
  {
    name: 'redo',
    description: 'Redo the last undone edit.',
    userOnly: true,
    noHistory: true,
    parameters: obj({}),
    run: (ctx) => {
      const label = ctx.store.redo();
      if (!label) throw new S.SessionError('nothing to redo');
      return { redone: label };
    },
    logText: (_a, r) => `redo (${r.redone})`,
  },
  {
    name: 'select',
    description: 'Select a track and/or clip.',
    userOnly: true,
    quiet: true,
    parameters: obj({ track_id: str(''), clip_id: str('') }),
    run: (ctx, a) => {
      edit(ctx, (s) => S.select(s, a.track_id ?? null, a.clip_id ?? null));
      return { ok: true };
    },
  },
];

export const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Tool list in Chat Completions format (only the ones Muse may call). */
export function museToolSpecs() {
  return TOOLS.filter((t) => !t.userOnly).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Minimal check of required keys and primitive types; enough to give Muse a useful error. */
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be a JSON object';
  const a = args as Record<string, unknown>;
  for (const key of schema.required ?? []) if (a[key] === undefined) return `missing required argument "${key}"`;
  for (const [key, value] of Object.entries(a)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument "${key}"`;
      continue;
    }
    if (value === null || value === undefined) continue;
    const t = prop.type;
    const ok =
      t === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      t === 'string' ? typeof value === 'string' :
      t === 'boolean' ? typeof value === 'boolean' :
      t === 'object' ? typeof value === 'object' && !Array.isArray(value) : true;
    if (!ok) return `argument "${key}" must be a ${t}`;
    if (prop.enum && !prop.enum.includes(value)) return `argument "${key}" must be one of ${prop.enum.join(', ')}`;
  }
  return null;
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Run a tool by name for an actor. Errors come back as data (so Muse can recover). */
export async function runTool(ctx: ToolContext, name: string, args: unknown, by: Actor): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) return { ok: false, error: `unknown tool "${name}"` };
  if (by === 'muse' && tool.userOnly) return { ok: false, error: `tool "${name}" is not available to the assistant` };
  const problem = validateArgs(tool.parameters, args);
  if (problem) return { ok: false, error: problem };
  try {
    const before = ctx.store.get();
    const result = await tool.run(ctx, args, by);
    const text = tool.logText ? tool.logText(args, result) : `${name} ${JSON.stringify(args)}`;
    const after = ctx.store.get();
    const changed = after !== before && JSON.stringify(after) !== JSON.stringify(before); // sessions are small
    if (!tool.quiet && !tool.noHistory && changed) ctx.store.pushHistory(before, by === 'muse' ? `Muse: ${text}` : text);
    if (by === 'user' && !tool.quiet) ctx.store.logUserEdit(text);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
