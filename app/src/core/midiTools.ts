// [S3 midi] Audio -> MIDI tools: extract_midi (runs the source-prep sidecar on an audio clip and
// adds one MIDI track per stem, lined up with the audio) and quantize_midi (at the session tempo).
// Also record_midi: a take played on the Musical Typing keyboard becomes a MIDI clip.
import { GRIDS, quantizeNotes, stemToMidi, type MidiData, type MidiNote, type PrepManifest, type SampleRef } from './midi';
import { getKit } from './kit';
import { detectKey, type KeyGuess } from './key';
import { SAMPLE_ROOT } from './musicalTyping';
import * as S from './session';
import { librarySources } from './shelfTools';
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
  // Starting from a voice note: take its tempo and key when the session has nothing else yet
  // and the sidecar was sure enough to quantize (otherwise the grid would not match anyway).
  // A real tempo change (changeTempo): other regions keep their bars; the recording itself, and
  // so its stems, stays where it was heard.
  const otherAudio = s.tracks.some((t) => t.clips.some((c) => c.id !== clipId));
  const applied: string[] = [];
  if ((setTempo ?? !otherAudio) && m.tempo?.quantized) {
    const bpm = Math.round(m.tempo.bpm * 100) / 100;
    if (bpm >= S.TEMPO_RANGE[0] && bpm <= S.TEMPO_RANGE[1]) {
      const { track } = S.findClip(next, clipId);
      next = S.mapTrack(S.changeTempo(next, bpm), track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? clip : c)) }));
      applied.push(`tempo ${bpm}`);
    }
    if (m.key && !next.key && S.parseKey(m.key.name.replace(/\s+/, ' '))) {
      next = S.setKey(next, m.key.name);
      applied.push(`key ${next.key}`);
    }
  }
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
  instrument?: { name?: string; sample: SampleRef } | { kit: string },
) {
  if (!(duration > 0)) throw new S.SessionError('a MIDI take needs a duration > 0');
  const kit = instrument && 'kit' in instrument ? getKit(s, instrument.kit) : undefined; // B12
  const sample = instrument && 'sample' in instrument ? checkSample(s, instrument.sample) : undefined;
  const kept = notes
    .filter((n) => Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 && n.start >= 0 && n.start < duration && n.duration > 0)
    .map((n) => ({ ...n, velocity: Math.min(127, Math.max(1, Math.round(n.velocity))), duration: Math.min(n.duration, duration - n.start) }));
  const takes = s.tracks.reduce((k, t) => k + t.clips.filter((c) => c.midi).length, 0) + 1;
  const name = `MIDI take ${takes}`;
  const midi: MidiData = kit
    ? { instrument: kit.name, drum: true, kit: kit.id, notes: kept }
    : sample
      ? { instrument: (instrument as { name?: string }).name?.trim() || s.sources[sample.sourceId].name, sample, notes: kept }
      : { instrument: 'piano', notes: kept };
  const [s1, clip] = S.addMidiClip(s, trackId, { name, midi, sourceDuration: duration, start: Math.max(0, start) });
  return { session: { ...S.select(s1, trackId, clip.id), punchIn: null }, clip, notes: kept.length };
}

/** B20: the notes a clip's key is read from, in the part of the source the clip plays. A MIDI
 *  clip's own (not drums); an audio clip's extracted stems (extract_midi names them
 *  "<clip> <stem>" and lines them up under it). */
function keyNotes(s: S.Session, clip: S.Clip): { notes: MidiNote[]; from: string[] } {
  const inside = (c: S.Clip) => c.midi!.notes.filter((n) => n.start + n.duration > c.offset && n.start < c.offset + c.duration);
  if (clip.midi) {
    if (clip.midi.drum) throw new S.SessionError(`clip ${clip.id} is drums; drums have no key`);
    return { notes: inside(clip), from: [clip.id] };
  }
  const end = clip.start + clip.duration;
  const stems = s.tracks.flatMap((t) => t.clips).filter((c) => c.midi && !c.midi.drum && c.name.startsWith(`${clip.name} `) && c.start < end && c.start + c.duration > clip.start);
  if (!stems.length) throw new S.SessionError(`audio clip ${clip.id} has no notes yet: run extract_midi on it first`);
  return { notes: stems.flatMap(inside), from: stems.map((c) => c.id) };
}

/** Pure: detect a clip's key and keep it on the clip; with `adopt`, also make it the session key
 *  (set_key). Exported for tests (detect_key wraps it). */
export function detectClipKey(s: S.Session, clipId: string, adopt = false): { session: S.Session; guess: KeyGuess; from: string[] } {
  const { track, clip } = S.findClip(s, clipId);
  const { notes, from } = keyNotes(s, clip);
  const guess = detectKey(notes);
  if (!guess) throw new S.SessionError(`clip ${clip.id} has too few different notes to tell a key (needs 3 or more)`);
  let next = S.mapTrack(s, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, key: guess.key } : c)) }));
  if (adopt) next = S.setKey(next, guess.key);
  return { session: next, guess, from };
}

export const MIDI_TOOLS: ToolDef[] = [
  {
    name: 'detect_key',
    description:
      "Detect a clip's key from its notes (a MIDI clip, or an audio clip that extract_midi has turned into notes) and note it on the clip. " +
      'set_session_key=true also makes it the session key ("match the project key to this clip"). Drums have no key.',
    parameters: obj({
      clip_id: str('Clip id; omit to use the selected clip'),
      set_session_key: bool('Also set the session key to it (default false)'),
    }),
    logText: (_a, r) => `detected ${r.key} in ${r.clip_id}${r.session_key_set ? ` and made it the session key` : ''}`,
    run: (ctx: ToolContext, a) => {
      const s = ctx.store.get();
      const clipId = a.clip_id ?? s.selection.clipId;
      if (!clipId) throw new S.SessionError('no clip_id given and no clip selected');
      const r = detectClipKey(s, clipId, a.set_session_key);
      ctx.store.set(r.session);
      return {
        clip_id: clipId,
        key: r.guess.key,
        certainty: r.guess.certainty,
        fit: r.guess.r,
        ...(r.guess.runnerUp ? { close_second: r.guess.runnerUp.key } : {}),
        from_clips: r.from,
        session_key: r.session.key,
        ...(a.set_session_key ? { session_key_set: true } : {}),
      };
    },
  },
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
        kit_id: str('Sample pad (kit) the take was played on (B12); instead of sample'),
      },
      ['track_id', 'start', 'duration', 'notes'],
    ),
    logText: (_a, r) => `recorded a MIDI take (${r.notes} notes) on ${r.track_id} @${r.start}s as clip ${r.clip_id}`,
    run: (ctx: ToolContext, a) => {
      const smp = a.sample
        ? { name: a.instrument, sample: { sourceId: a.sample.source_id, offset: a.sample.offset, duration: a.sample.duration, root: a.sample.root } }
        : undefined;
      if (a.instrument !== undefined && !a.sample) throw new S.SessionError('instrument needs a sample');
      if (a.kit_id && a.sample) throw new S.SessionError('a take is on a sample or a kit, not both');
      const r = recordMidiTake(ctx.store.get(), a.track_id, a.start, a.duration, a.notes, a.kit_id ? { kit: a.kit_id } : smp);
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
      set_tempo: bool('Set the session tempo/key from the recording; other regions keep their bars (default: only when the session has nothing else)'),
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
    description: 'Quantize a MIDI clip (or every MIDI clip on a track) to the session tempo and bars. strength 0-1 (1 = hard snap). notes: indexes of the notes to quantize (default all; the selected notes are listed in the summary).',
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        track_id: str('Or: a track id (all its MIDI clips)'),
        grid: str('Grid', { enum: Object.keys(GRIDS) }),
        strength: num('0-1, default 1', { minimum: 0, maximum: 1 }),
        notes: { type: 'array', items: num('note index'), description: 'Only these notes (indexes in start order); default all' },
      },
      ['grid'],
    ),
    run: (ctx: ToolContext, a) => {
      let s = ctx.store.get();
      const clipId = a.clip_id ?? (a.notes ? s.selection.clipId : undefined); // notes: in the selected clip
      const clips = clipId
        ? [S.findClip(s, clipId).clip]
        : S.getTrack(s, a.track_id ?? s.selection.trackId ?? '').clips.filter((c) => c.midi);
      if (!clips.length || clips.some((c) => !c.midi)) throw new S.SessionError('no MIDI clip to quantize');
      const which = a.notes && clipId ? new Set<number>(a.notes) : null;
      for (const c of clips) {
        // notes are source-relative; put beat 1 of the grid at timeline 0
        const q = (ns: MidiNote[]) => quantizeNotes(ns, s.tempo, a.grid, a.strength ?? 1, c.offset - c.start);
        const all = c.midi!.notes;
        // one note at a time keeps their order, so the selection follows them through the sort
        const notes = all.map((n, i) => (!which || which.has(i) ? q([n])[0] : n));
        s = S.setClipNotes(s, c.id, notes);
      }
      ctx.store.set(s);
      return { clips: clips.map((c) => c.id), grid: a.grid, bpm: s.tempo, strength: a.strength ?? 1, ...(which ? { quantized: which.size } : {}) };
    },
  },
  {
    name: 'edit_midi_notes',
    description: "Replace a MIDI clip's notes (Piano Roll edits: move, resize, add, delete, velocity). Times are seconds from the clip's source start.",
    userOnly: true,
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        notes: { type: 'array', items: obj({ pitch: num(''), velocity: num(''), start: num(''), duration: num('') }, ['pitch', 'velocity', 'start', 'duration']) },
        selected: { type: 'array', items: num(''), description: 'Indexes into notes to leave selected' },
      },
      ['clip_id', 'notes'],
    ),
    logText: (_a, r) => `edited notes in the Piano Roll on ${r.clip_id}: ${r.before} -> ${r.notes} notes`,
    run: (ctx: ToolContext, a) => {
      const s = ctx.store.get();
      const { clip } = S.findClip(s, a.clip_id);
      if (!clip.midi) throw new S.SessionError(`clip ${clip.id} is audio, not MIDI`);
      const notes = checkNotes(a.notes, false);
      ctx.store.set(S.setClipNotes(s, clip.id, notes, a.selected ?? []));
      return { clip_id: clip.id, before: clip.midi.notes.length, notes: notes.length };
    },
  },
  {
    name: 'transpose_midi',
    description: 'Transpose a MIDI clip by semitones (12 = an octave up). notes: indexes of the notes to move (default all).',
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        semitones: num('Semitones, e.g. -12, -1, 1, 12'),
        notes: { type: 'array', items: num('note index'), description: 'Only these notes (indexes in start order); default all' },
      },
      ['clip_id', 'semitones'],
    ),
    logText: (_a, r) => `transposed ${r.moved} note(s) on ${r.clip_id} by ${r.semitones}`,
    run: (ctx: ToolContext, a) => {
      const s = ctx.store.get();
      const { clip } = S.findClip(s, a.clip_id);
      if (!clip.midi) throw new S.SessionError(`clip ${clip.id} is audio, not MIDI`);
      if (!Number.isInteger(a.semitones)) throw new S.SessionError('semitones must be a whole number');
      const which = a.notes ? new Set<number>(a.notes) : null;
      const notes = clip.midi.notes.map((n, i) => (!which || which.has(i) ? { ...n, pitch: n.pitch + a.semitones } : n));
      if (notes.some((n) => n.pitch < 0 || n.pitch > 127)) throw new S.SessionError('that would move notes outside MIDI 0-127');
      ctx.store.set(S.setClipNotes(s, clip.id, notes));
      return { clip_id: clip.id, semitones: a.semitones, moved: which ? which.size : notes.length };
    },
  },
  {
    name: 'set_note_length',
    description:
      'Change how long MIDI notes are held (Oct 30: "make each note a full bar"). Give one of: beats (each note this many beats long, e.g. 4 = a bar in 4/4, 0.5 = an eighth), ' +
      'scale (multiply each length, e.g. 2 = twice as long), or legato (each note held until the next one starts). ' +
      'clip_id, or track_id for all its MIDI clips; default the selected region, else the selected track. notes: indexes (default all). ' +
      'A note held past its region\'s end is cut off there; the result counts them (extend the region to hear them).',
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        track_id: str('Or: a track id (all its MIDI clips)'),
        beats: num('New length in beats (quarter notes in 4/4)', { exclusiveMinimum: 0 }),
        scale: num('Or: multiply each length by this', { exclusiveMinimum: 0 }),
        legato: bool('Or: hold each note until the next note starts (the last keeps its length)'),
        notes: { type: 'array', items: num('note index'), description: 'Only these notes (indexes in start order); default all' },
      },
    ),
    logText: (_a, r) => `changed the length of ${r.changed} note(s) on ${r.clips.join(', ')}`,
    run: (ctx: ToolContext, a) => {
      let s = ctx.store.get();
      if ([a.beats, a.scale, a.legato || undefined].filter((x) => x != null).length !== 1) throw new S.SessionError('give one of beats, scale or legato');
      const clipId = a.clip_id ?? (a.track_id ? undefined : s.selection.clipId ?? undefined);
      const clips = clipId
        ? [S.findClip(s, clipId).clip]
        : S.getTrack(s, a.track_id ?? s.selection.trackId ?? '').clips.filter((c) => c.midi);
      if (!clips.length || clips.some((c) => !c.midi)) throw new S.SessionError('no MIDI clip to change');
      const which = a.notes && clips.length === 1 ? new Set<number>(a.notes) : null;
      const beat = (60 / s.tempo) * (4 / s.timeSignature[1]);
      let changed = 0;
      let pastEnd = 0;
      for (const c of clips) {
        const all = c.midi!.notes;
        const next = (i: number) => all.slice(i + 1).find((m) => m.start > all[i].start + 1e-6)?.start; // notes are in start order
        const notes = all.map((n, i) => {
          if (which && !which.has(i)) return n;
          const duration = a.beats != null ? a.beats * beat : a.scale != null ? n.duration * a.scale : (next(i) ?? n.start + n.duration) - n.start;
          changed++;
          if (n.start + duration > c.offset + c.duration + 1e-6) pastEnd++;
          return { ...n, duration: Math.max(0.01, Math.round(duration * 1e4) / 1e4) };
        });
        s = S.setClipNotes(s, c.id, notes);
      }
      ctx.store.set(s);
      return { clips: clips.map((c) => c.id), changed, ...(a.beats != null ? { seconds: Math.round(a.beats * beat * 1e4) / 1e4 } : {}), ...(pastEnd ? { cut_off_by_region_end: pastEnd } : {}) };
    },
  },
  {
    name: 'set_region_instrument',
    description:
      'Play a MIDI region on another sound (Oct 30): its notes stay, only the instrument changes. Give one of: instrument "piano" or "drums" (the built-in ones), ' +
      'source_id (a session sound, e.g. an Ideas sound, played as a sampler: C4 plays it at its own pitch), library_id (a library sound, loaded into the session first; ' +
      'find_library_sounds), or kit_id (a sample pad: each note plays the pad on that note). Default: the selected region. Undoable.',
    parameters: obj({
      clip_id: str('MIDI clip id; omit for the selected region'),
      instrument: str('A built-in instrument', { enum: ['piano', 'drums'] }),
      source_id: str('Or: a session sound to play as a sampler'),
      library_id: str('Or: a library sound id, e.g. "fs:858950"'),
      kit_id: str('Or: a sample pad (kit) id'),
    }),
    logText: (_a, r) => `${r.clip_id} now plays on ${r.instrument} (was ${r.was})`,
    run: async (ctx: ToolContext, a) => {
      if ([a.instrument, a.source_id, a.library_id, a.kit_id].filter((x) => x != null).length !== 1) {
        throw new S.SessionError('give one of instrument, source_id, library_id or kit_id');
      }
      let s = ctx.store.get();
      const clipId = a.clip_id ?? s.selection.clipId;
      if (!clipId) throw new S.SessionError('no clip_id given and no region selected');
      const { clip } = S.findClip(s, clipId);
      if (!clip.midi) throw new S.SessionError(`clip ${clip.id} is audio; only a MIDI region changes instrument`);
      const was = clip.midi.instrument;
      let voice: Omit<MidiData, 'notes'>;
      if (a.instrument) voice = a.instrument === 'drums' ? { instrument: 'drums', drum: true } : { instrument: 'piano' };
      else if (a.kit_id) {
        const kit = getKit(s, a.kit_id);
        voice = { instrument: kit.name, drum: true, kit: kit.id };
      } else {
        let sourceId: string = a.source_id;
        if (a.library_id) {
          const r = await librarySources(ctx, s, [a.library_id]);
          s = r.session;
          sourceId = r.sourceOf.get(a.library_id)!;
        }
        const src = s.sources[sourceId];
        if (!src) throw new S.SessionError(`no source "${sourceId}"`);
        voice = { instrument: src.name, sample: checkSample(s, { sourceId, offset: 0, duration: src.duration, root: SAMPLE_ROOT }) };
      }
      ctx.store.set(S.setClipVoice(s, clip.id, voice));
      const kit = voice.kit ? getKit(s, voice.kit) : undefined;
      const offPads = kit ? clip.midi.notes.filter((n) => !kit.pads.some((p) => p.note === n.pitch)).length : 0;
      return {
        clip_id: clip.id,
        instrument: voice.instrument,
        was,
        ...(voice.sample ? { source_id: voice.sample.sourceId } : {}),
        ...(offPads ? { notes_not_on_a_pad: offPads } : {}),
        ...(clip.midi.drum && !voice.drum ? { note: 'drum notes now play as pitches (C2-C#3)' } : {}),
      };
    },
  },
  {
    name: 'set_note_velocity',
    description: 'Set or change the velocity (loudness, 1-127) of MIDI notes: velocity sets it, change adds to it (e.g. -20 = softer). notes: indexes (default all).',
    parameters: obj(
      {
        clip_id: str('MIDI clip id'),
        velocity: num('New velocity 1-127', { minimum: 1, maximum: 127 }),
        change: num('Or: add this to each velocity, e.g. -20'),
        notes: { type: 'array', items: num('note index'), description: 'Only these notes (indexes in start order); default all' },
      },
      ['clip_id'],
    ),
    logText: (_a, r) => `set the velocity of ${r.changed} note(s) on ${r.clip_id}`,
    run: (ctx: ToolContext, a) => {
      const s = ctx.store.get();
      const { clip } = S.findClip(s, a.clip_id);
      if (!clip.midi) throw new S.SessionError(`clip ${clip.id} is audio, not MIDI`);
      if ((a.velocity == null) === (a.change == null)) throw new S.SessionError('give either velocity or change');
      const which = a.notes ? new Set<number>(a.notes) : null;
      const v = (x: number) => Math.min(127, Math.max(1, Math.round(a.velocity ?? x + a.change)));
      const notes = clip.midi.notes.map((n, i) => (!which || which.has(i) ? { ...n, velocity: v(n.velocity) } : n));
      ctx.store.set(S.setClipNotes(s, clip.id, notes));
      return { clip_id: clip.id, changed: which ? which.size : notes.length };
    },
  },
  {
    name: 'delete_midi_notes',
    description: 'Delete MIDI notes from a clip by index (start order), e.g. the selected notes.',
    parameters: obj({ clip_id: str('MIDI clip id'), notes: { type: 'array', items: num('note index') } }, ['clip_id', 'notes']),
    logText: (_a, r) => `deleted ${r.deleted} note(s) from ${r.clip_id}`,
    run: (ctx: ToolContext, a) => {
      const s = ctx.store.get();
      const { clip } = S.findClip(s, a.clip_id);
      if (!clip.midi) throw new S.SessionError(`clip ${clip.id} is audio, not MIDI`);
      const gone = new Set<number>(a.notes);
      const notes = clip.midi.notes.filter((_, i) => !gone.has(i));
      ctx.store.set(S.setClipNotes(s, clip.id, notes, []));
      return { clip_id: clip.id, deleted: clip.midi.notes.length - notes.length, left: notes.length };
    },
  },
  {
    name: 'select_notes',
    description: 'Select notes in the Piano Roll (indexes into the clip\'s notes, start order).',
    userOnly: true,
    quiet: true,
    parameters: obj({ clip_id: str('MIDI clip id'), notes: { type: 'array', items: num('note index') } }, ['clip_id', 'notes']),
    run: (ctx: ToolContext, a) => {
      ctx.store.set(S.selectNotes(ctx.store.get(), a.clip_id, a.notes));
      return { ok: true };
    },
  },
];

/** Validate Piano Roll notes and sort them by start (then pitch); `sort` false keeps their order
 *  (setClipNotes sorts them, keeping the selection). */
export function checkNotes(notes: MidiNote[], sort = true): MidiNote[] {
  for (const n of notes) {
    if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) throw new S.SessionError(`pitch ${n.pitch} is not a MIDI note 0-127`);
    if (!(n.start >= 0)) throw new S.SessionError(`note start ${n.start} is before the clip`);
    if (!(n.duration > 0)) throw new S.SessionError('notes need a duration > 0');
    if (!(n.velocity >= 1 && n.velocity <= 127)) throw new S.SessionError(`velocity ${n.velocity} is outside 1-127`);
  }
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const out = notes.map((n) => ({ pitch: n.pitch, start: r4(n.start), duration: r4(n.duration), velocity: Math.round(n.velocity) }));
  return sort ? out.sort((a, b) => a.start - b.start || a.pitch - b.pitch) : out;
}
