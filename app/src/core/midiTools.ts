// [S3 midi] Audio -> MIDI tools: extract_midi (runs the source-prep sidecar on an audio clip and
// adds one MIDI track per stem, lined up with the audio) and quantize_midi (at the session tempo).
// Also record_midi: a take played on the Musical Typing keyboard becomes a MIDI clip.
import { GRIDS, quantizeNotes, stemToMidi, type MidiData, type MidiNote, type PrepManifest, type SampleRef } from './midi';
import * as S from './session';
import type { ExtractMode } from './sidecar';
import type { ToolContext, ToolDef } from './tools';

const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const num = (description: string, extra: object = {}) => ({ type: 'number', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const MODES: ExtractMode[] = ['auto', 'hum', 'keys', 'bass', 'drums', 'layered'];
const GRID_ENUM = ['off', ...Object.keys(GRIDS)];

function targetClip(s: S.Session, clipId?: string): { track: S.Track; clip: S.Clip } {
  if (clipId) return S.findClip(s, clipId);
  if (s.selection.clipId) return S.findClip(s, s.selection.clipId);
  const t = s.selection.trackId ? s.tracks.find((t) => t.id === s.selection.trackId) : undefined;
  const audio = (t ? [t] : s.tracks).flatMap((tr) => tr.clips.filter((c) => !c.midi).map((clip) => ({ track: tr, clip })));
  if (audio.length === 1 || (t && audio.length)) return audio[0];
  throw new S.SessionError('no clip_id given and no clip selected');
}

/** Pure: add the manifest's stems to the session as MIDI tracks aligned with `clipId`.
 *  Exported for tests (the tool below wraps it). */
export function importManifest(s: S.Session, clipId: string, m: PrepManifest, setTempo: boolean | undefined) {
  const { clip } = S.findClip(s, clipId);
  const src = s.sources[clip.sourceId];
  const added: { track_id: string; clip_id: string; stem: string; transcriber: string; notes: number; range: string | null }[] = [];
  const skipped: string[] = [];
  let next = s;
  for (const stem of m.stems) {
    if (!stem.notes.length) {
      skipped.push(`${stem.name} (no notes)`);
      continue;
    }
    const name = `${clip.name} ${stem.name}`;
    const [s1, t] = S.addTrack(next, name);
    const [s2, c] = S.addMidiClip(s1, t.id, {
      name,
      midi: stemToMidi(stem),
      sourceDuration: src?.duration ?? m.duration,
      start: clip.start,
      offset: clip.offset,
      duration: clip.duration,
    });
    next = s2;
    added.push({ track_id: t.id, clip_id: c.id, stem: stem.name, transcriber: stem.transcriber, notes: stem.notes.length, range: stem.range ? stem.range.join('-') : null });
  }
  // Starting from a voice note: take its tempo and key when the session has nothing else yet
  // and the sidecar was sure enough to quantize (otherwise the grid would not match anyway).
  const otherAudio = s.tracks.some((t) => t.clips.some((c) => c.id !== clipId));
  const applied: string[] = [];
  if ((setTempo ?? !otherAudio) && m.tempo?.quantized) {
    const bpm = Math.round(m.tempo.bpm * 100) / 100;
    if (bpm >= S.TEMPO_RANGE[0] && bpm <= S.TEMPO_RANGE[1]) {
      next = S.setTempo(next, bpm);
      applied.push(`tempo ${bpm}`);
    }
    if (m.key && !next.key && S.parseKey(m.key.name.replace(/\s+/, ' '))) {
      next = S.setKey(next, m.key.name);
      applied.push(`key ${next.key}`);
    }
  }
  if (added.length) next = S.select(next, added[0].track_id, added[0].clip_id);
  return { session: next, added, skipped, applied };
}

/** Check a sampler instrument against the session: a region inside a real (audio) source. */
export function checkSample(s: S.Session, x: SampleRef): SampleRef {
  const src = s.sources[x.sourceId];
  if (!src) throw new S.SessionError(`sample source ${x.sourceId} not found`);
  if (s.tracks.some((t) => t.clips.some((c) => c.midi && c.sourceId === x.sourceId))) {
    throw new S.SessionError(`sample source ${x.sourceId} is a MIDI clip, not audio`);
  }
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(x.offset) || !ok(x.duration) || !ok(x.root)) throw new S.SessionError('sample needs numeric offset, duration and root');
  if (x.offset < 0 || !(x.duration > 0) || x.offset + x.duration > src.duration + 0.01) {
    throw new S.SessionError(`sample region ${x.offset}+${x.duration}s is outside source ${x.sourceId} (${src.duration}s)`);
  }
  if (!Number.isInteger(x.root) || x.root < 0 || x.root > 127) throw new S.SessionError('sample root must be a MIDI note 0-127');
  return { sourceId: x.sourceId, offset: x.offset, duration: x.duration, root: x.root };
}

/** Pure: add a recorded MIDI take (notes relative to the take start) to a track as a new
 *  clip, select it and clear any punch-in. Notes outside the take are dropped or clipped.
 *  With `instrument.sample`, the take plays back with that sample (as it was played live).
 *  Exported for tests (record_midi wraps it). */
export function recordMidiTake(
  s: S.Session,
  trackId: string,
  start: number,
  duration: number,
  notes: MidiNote[],
  instrument?: { name?: string; sample: SampleRef },
) {
  if (!(duration > 0)) throw new S.SessionError('a MIDI take needs a duration > 0');
  const sample = instrument ? checkSample(s, instrument.sample) : undefined;
  const kept = notes
    .filter((n) => Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 && n.start >= 0 && n.start < duration && n.duration > 0)
    .map((n) => ({ ...n, velocity: Math.min(127, Math.max(1, Math.round(n.velocity))), duration: Math.min(n.duration, duration - n.start) }));
  const takes = s.tracks.reduce((k, t) => k + t.clips.filter((c) => c.midi).length, 0) + 1;
  const name = `MIDI take ${takes}`;
  const midi: MidiData = sample
    ? { instrument: instrument!.name?.trim() || s.sources[sample.sourceId].name, sample, notes: kept }
    : { instrument: 'piano', notes: kept };
  const [s1, clip] = S.addMidiClip(s, trackId, { name, midi, sourceDuration: duration, start: Math.max(0, start) });
  return { session: { ...S.select(s1, trackId, clip.id), punchIn: null }, clip, notes: kept.length };
}

export const MIDI_TOOLS: ToolDef[] = [
  {
    name: 'record_midi',
    description: 'Add a MIDI take played on the Musical Typing keyboard to a track: notes are relative to the take start.',
    userOnly: true,
    parameters: obj(
      {
        track_id: str(''),
        start: num('Take start, timeline seconds'),
        duration: num('Take length, seconds'),
        notes: { type: 'array', items: obj({ pitch: num(''), velocity: num(''), start: num(''), duration: num('') }, ['pitch', 'velocity', 'start', 'duration']) },
        instrument: str('Label for the sampled sound (the clip name); with sample'),
        sample: obj(
          { source_id: str('Audio source played as the instrument'), offset: num('s into the source'), duration: num('s'), root: num('MIDI note that plays it unpitched') },
          ['source_id', 'offset', 'duration', 'root'],
        ),
      },
      ['track_id', 'start', 'duration', 'notes'],
    ),
    logText: (_a, r) => `recorded a MIDI take (${r.notes} notes) on ${r.track_id} @${r.start}s as clip ${r.clip_id}`,
    run: (ctx: ToolContext, a) => {
      const smp = a.sample
        ? { name: a.instrument, sample: { sourceId: a.sample.source_id, offset: a.sample.offset, duration: a.sample.duration, root: a.sample.root } }
        : undefined;
      if (a.instrument !== undefined && !a.sample) throw new S.SessionError('instrument needs a sample');
      const r = recordMidiTake(ctx.store.get(), a.track_id, a.start, a.duration, a.notes, smp);
      ctx.store.set(r.session);
      return { clip_id: r.clip.id, track_id: a.track_id, start: r.clip.start, notes: r.notes, instrument: r.clip.midi!.instrument };
    },
  },
  {
    name: 'extract_midi',
    description:
      'Turn an audio clip (e.g. a phone voice note: a hum, an instrument, or layers) into MIDI: optional separation into stems ' +
      '(Mel-RoFormer vocals, htdemucs bass/piano/drums), a transcriber per stem, then cleanup (blips, repeats, octave slips, key snap, ' +
      'quantize when the tempo is clear). Adds one MIDI track per stem under the audio, aligned with it. Takes 10-60 s. ' +
      'mode "auto" decides hum/keys/bass/drums/layered from the audio; set it when the user says what it is.',
    parameters: obj({
      clip_id: str('Audio clip id; omit to use the selected clip'),
      mode: str('What the recording is', { enum: MODES }),
      grid: str('Quantize grid (default 1/16; "off" keeps the timing as played)', { enum: GRID_ENUM }),
      separate: str('auto (default), none, vocals (Mel-RoFormer only), full (+ htdemucs_6s)', { enum: ['auto', 'none', 'vocals', 'full'] }),
      key_snap: bool('Snap rare out-of-key notes to the detected key (default true)'),
      use_session_tempo: bool('Quantize at the session tempo instead of the detected one (default false)'),
      set_tempo: bool('Set the session tempo/key from the recording (default: only when the session has nothing else)'),
    }),
    logText: (_a, r) => `extracted MIDI from ${r.from_clip}: ${r.tracks.map((t: any) => `${t.stem} (${t.notes} notes) -> ${t.track_id}`).join(', ') || 'nothing'}`,
    run: async (ctx: ToolContext, a) => {
      const s0 = ctx.store.get();
      const { clip } = targetClip(s0, a.clip_id);
      if (clip.midi) throw new S.SessionError(`clip ${clip.id} is already MIDI`);
      const m = await ctx.sidecar.extractMidi({
        sourceId: clip.sourceId,
        mode: a.mode ?? 'auto',
        grid: a.grid ?? '1/16',
        separate: a.separate ?? 'auto',
        keySnap: a.key_snap ?? true,
        ...(a.use_session_tempo ? { bpm: s0.tempo } : {}),
      });
      // the session may have changed while the sidecar ran: apply to the current one
      const r = importManifest(ctx.store.get(), clip.id, m, a.set_tempo);
      ctx.store.set(r.session);
      return {
        from_clip: clip.id,
        content: m.content,
        tempo: m.tempo ? { bpm: m.tempo.bpm, confidence: m.tempo.confidence, quantized: m.tempo.quantized } : null,
        key: m.key?.name ?? null,
        tracks: r.added,
        skipped: r.skipped,
        applied_to_session: r.applied,
        warnings: m.warnings,
      };
    },
  },
  {
    name: 'quantize_midi',
    description: 'Quantize a MIDI clip (or every MIDI clip on a track) to the session tempo and bars. strength 0-1 (1 = hard snap).',
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        track_id: str('Or: a track id (all its MIDI clips)'),
        grid: str('Grid', { enum: Object.keys(GRIDS) }),
        strength: num('0-1, default 1', { minimum: 0, maximum: 1 }),
      },
      ['grid'],
    ),
    run: (ctx: ToolContext, a) => {
      let s = ctx.store.get();
      const clips = a.clip_id
        ? [S.findClip(s, a.clip_id).clip]
        : S.getTrack(s, a.track_id ?? s.selection.trackId ?? '').clips.filter((c) => c.midi);
      if (!clips.length || clips.some((c) => !c.midi)) throw new S.SessionError('no MIDI clip to quantize');
      for (const c of clips) {
        // notes are source-relative; put beat 1 of the grid at timeline 0
        const notes = quantizeNotes(c.midi!.notes, s.tempo, a.grid, a.strength ?? 1, c.offset - c.start);
        s = S.setClipMidi(s, c.id, { ...c.midi!, notes });
      }
      ctx.store.set(s);
      return { clips: clips.map((c) => c.id), grid: a.grid, bpm: s.tempo, strength: a.strength ?? 1 };
    },
  },
];
