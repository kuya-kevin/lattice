// B12 sample pad tools: make a kit, put sounds on its pads, rename, clear, delete. The user does
// these from the Ideas column and the pad view; Muse can too. B12b: Muse also searches the sound
// library and fills a kit from it (fill_kit), bringing each sound into the session first.
import * as K from './kit';
import { categoryLabel, filterLibrary, phraseBpm, soundName, type ProjectFit } from './library';
import { barLength } from './metronome';
import { recordMidiTake } from './midiTools';
import * as S from './session';
import { library, librarySources } from './shelfTools';
import type { ToolContext, ToolDef } from './tools';

const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description, minimum: 0, maximum: K.PAD_COUNT - 1 });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const PAD_HELP = `Pad index 0-${K.PAD_COUNT - 1}, top row first (keys ${K.PAD_KEYS.map((_, i) => K.padKeyLabel(i)).join(' ')}; ` +
  `defaults ${K.DEFAULT_PADS.map((p, i) => `${i} ${p.label.toLowerCase()}`).join(', ')})`;

function edit(ctx: ToolContext, fn: (s: S.Session) => S.Session) {
  ctx.store.set(fn(ctx.store.get()));
}

const r2 = (x: number) => Math.round(x * 100) / 100;

type PadFill = { pad: number; library_id?: string; source_id?: string; label?: string };

export const KIT_TOOLS: ToolDef[] = [
  {
    name: 'find_library_sounds',
    description:
      'Search the sound library (curated Freesound one-shots and phrases, CC0 / CC-BY, plus the user\'s voice notes) by words in the name, tags, ' +
      'category, author or note, and/or a category. Drum categories: kick, snare, clap, closed_hat, open_hat, percussion; also noise_vinyl, riser, ' +
      'synth_lead, synth_bass, pad, pluck, piano_note, bell_mallet, brass_stab, organ, strings_note. Every word must match; for a mood ' +
      '("dusty", "punchy") search by category and judge the names, tags and descriptions. Then fill_kit or set_pad with library_id. ' +
      'To answer "what pads (kicks, ...) do we have", give just the category: it lists them all; name every one in your reply. ' +
      'Write sound names exactly as given (no shortening or renaming): the chat turns them into links that open and play the sound. ' +
      'fits_project (or key) keeps pitched sounds whose note is in the key, and phrases near the tempo; drums and textures always pass.',
    quiet: true,
    parameters: obj({
      query: str('Words to match, e.g. "808" or "vinyl"; omit to list a category'),
      category: str('One category, e.g. "kick"'),
      fits_project: { type: 'boolean', description: "Only sounds that fit the project's key (and tempo, for phrases)" },
      key: str('Only sounds that fit this key instead, e.g. "D minor"'),
      max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Default: all of a category, else 8' },
    }),
    run: async (ctx, a) => {
      if (!a.query && !a.category) throw new S.SessionError('give query or category');
      const s = ctx.store.get();
      let fits: ProjectFit | null = null;
      if (a.key) {
        const key = S.parseKey(a.key);
        if (!key) throw new S.SessionError(`unknown key "${a.key}" (try e.g. "G minor", "Eb major", "F#m")`);
        fits = { key, tempo: a.fits_project ? s.tempo : null };
      } else if (a.fits_project) {
        if (!s.key) throw new S.SessionError('the project has no key yet: set_key (or detect it) first, or pass key');
        fits = { key: s.key, tempo: s.tempo };
      }
      const found = filterLibrary(await library(ctx), { text: a.query, category: a.category ?? null, fits });
      const max = a.max_results ?? (a.query ? 8 : 50);
      return {
        count: found.length,
        ...(fits ? { fits: `${fits.key}${fits.tempo ? `, ${fits.tempo} BPM` : ''}` } : {}),
        ...(found.length > max ? { more: `${found.length - max} more not listed; narrow the search or raise max_results` } : {}),
        sounds: found.slice(0, max).map((i) => ({
          library_id: i.id,
          name: soundName(i.name),
          category: categoryLabel(i.category),
          tags: i.tags.slice(0, 8),
          duration: r2(i.duration),
          license: i.license,
          ...(i.note ? { note: i.note } : {}),
          ...(phraseBpm(i) ? { bpm: Math.round(phraseBpm(i)!) } : {}),
          ...(i.description ? { description: i.description.slice(0, 140) } : {}),
        })),
      };
    },
  },
  {
    name: 'fill_kit',
    description:
      'Fill a sample pad in one step (one undo): put sounds on several pads, from the library (library_id, from find_library_sounds) or the session ' +
      '(source_id). Without kit_id it makes a new kit called name. Library sounds are loaded into the session. Pick by what each pad is for (kick on 6, snare on 7, ' +
      'hat on 2, open hat on 1, clap on 3, ...) and the mood asked for; give label to rename a pad.',
    parameters: obj(
      {
        kit_id: str('Kit to fill; omit to make a new one'),
        name: str('Name for a new kit, e.g. "Dusty lo-fi"'),
        pads: {
          type: 'array',
          minItems: 1,
          maxItems: K.PAD_COUNT,
          items: obj({ pad: int(PAD_HELP), library_id: str('Library sound id'), source_id: str('Or: a session source id'), label: str('Pad name (optional)') }, ['pad']),
        },
      },
      ['pads'],
    ),
    run: async (ctx, a) => {
      const fills = a.pads as PadFill[];
      if (!fills.length) throw new S.SessionError('give at least one pad');
      for (const f of fills) if (!f.source_id === !f.library_id) throw new S.SessionError(`pad ${f.pad}: give source_id or library_id (one of them)`);
      if (new Set(fills.map((f) => f.pad)).size !== fills.length) throw new S.SessionError('each pad once');
      let s = ctx.store.get();
      if (a.kit_id) K.getKit(s, a.kit_id);
      for (const f of fills) if (f.source_id && !s.sources[f.source_id]) throw new S.SessionError(`no source "${f.source_id}"`);
      const r = await librarySources(ctx, s, fills.flatMap((f) => (f.library_id ? [f.library_id] : [])));
      s = r.session;
      let kitId: string = a.kit_id;
      if (!kitId) [s, { id: kitId }] = K.createKit(s, a.name);
      for (const f of fills) s = K.setPad(s, kitId, f.pad, f.source_id ?? r.sourceOf.get(f.library_id!)!, f.label);
      ctx.store.set(s);
      const kit = K.getKit(s, kitId);
      return {
        kit_id: kitId,
        name: kit.name,
        ...(a.kit_id ? {} : { created: true }),
        pads: fills.map((f) => `${f.pad} ${K.padKeyLabel(f.pad)} ${kit.pads[f.pad].label} = ${s.sources[kit.pads[f.pad].sample!.sourceId].name}`),
        credits_needed: [...new Set(fills.map((f) => s.sources[kit.pads[f.pad].sample!.sourceId].credit).filter(Boolean))].length,
      };
    },
    logText: (_a, r) => `${r.created ? 'made and filled' : 'filled'} sample pad ${r.kit_id} "${r.name}": ${r.pads.join(', ')}`,
  },
  {
    name: 'create_kit',
    description: `Make a new sample pad (kit): ${K.PAD_COUNT} empty pads for any sounds (drums, chops, one-shots, FX), each on a General MIDI drum note, shown in the Ideas column. Fill it with set_pad.`,
    parameters: obj({ name: str('Kit name, e.g. "Lo-fi kit" (default "Sample pad N")') }),
    run: (ctx, a) => {
      let kit!: K.Kit;
      edit(ctx, (s) => {
        const [s1, k] = K.createKit(s, a.name);
        kit = k;
        return s1;
      });
      return { kit_id: kit.id, name: kit.name, pads: kit.pads.map((p, i) => `${i} ${p.label} (${p.note})`) };
    },
    logText: (_a, r) => `made sample pad ${r.kit_id} "${r.name}"`,
  },
  {
    name: 'set_pad',
    description:
      'Put a sound on a pad of a sample pad: a source in the session (e.g. an Ideas sound), or a library sound by library_id (find_library_sounds), ' +
      'which is loaded into the session first. It plays once through, unpitched, on the pad\'s note. The pad takes the sound\'s name unless you give a label or it was renamed.',
    parameters: obj(
      { kit_id: str('Kit id, e.g. "k3"'), pad: int(PAD_HELP), source_id: str('Source id of the sound'), library_id: str('Or: a library sound id, e.g. "fs:858950"'), label: str('New pad name (optional)') },
      ['kit_id', 'pad'],
    ),
    run: async (ctx, a) => {
      if (!a.source_id === !a.library_id) throw new S.SessionError('give source_id or library_id (one of them)');
      let s = ctx.store.get();
      K.getKit(s, a.kit_id); // fail before loading audio
      let sourceId: string = a.source_id;
      if (a.library_id) {
        const r = await librarySources(ctx, s, [a.library_id]);
        s = r.session;
        sourceId = r.sourceOf.get(a.library_id)!;
      }
      ctx.store.set(K.setPad(s, a.kit_id, a.pad, sourceId, a.label));
      s = ctx.store.get();
      return { kit_id: a.kit_id, pad: a.pad, label: K.getKit(s, a.kit_id).pads[a.pad].label, sound: s.sources[sourceId].name, source_id: sourceId };
    },
    logText: (a, r) => `put "${r.sound}" on pad ${a.pad} (${r.label}) of ${a.kit_id}`,
  },
  {
    name: 'clear_pad',
    description: 'Take the sound off a pad (it plays the built-in drum sound again).',
    parameters: obj({ kit_id: str('Kit id'), pad: int(PAD_HELP) }, ['kit_id', 'pad']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.clearPad(s, a.kit_id, a.pad));
      return { kit_id: a.kit_id, pad: a.pad };
    },
    logText: (a) => `cleared pad ${a.pad} of ${a.kit_id}`,
  },
  {
    name: 'place_kit',
    description:
      'Put an empty region played by a sample pad (kit) on a track, to draw its hits in the Piano Roll (one row per pad) or record over. ' +
      'Without track_id it goes on a new track named after the kit. The user does this by dragging a kit card onto the arrangement.',
    parameters: obj(
      { kit_id: str('Kit id'), track_id: str('Existing track id; omit for a new track'), start: { type: 'number', description: 'Timeline seconds (default 0)' }, bars: { type: 'integer', minimum: 1, maximum: 64, description: 'Length in bars (default 2)' } },
      ['kit_id'],
    ),
    run: (ctx, a) => {
      let out!: { track_id: string; clip_id: string; start: number; duration: number };
      edit(ctx, (s) => {
        const kit = K.getKit(s, a.kit_id);
        let s1 = s;
        let trackId = a.track_id as string | undefined;
        if (trackId) S.getTrack(s, trackId);
        else [s1, { id: trackId }] = S.addTrack(s, kit.name);
        const duration = barLength(s1) * Math.max(1, Math.min(64, Math.round(a.bars ?? 2)));
        const r = recordMidiTake(s1, trackId!, a.start ?? 0, duration, [], { kit: kit.id });
        const clip = { ...r.clip, name: kit.name };
        out = { track_id: trackId!, clip_id: clip.id, start: clip.start, duration: Math.round(duration * 1000) / 1000 };
        return S.mapTrack(r.session, trackId!, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? clip : c)) }));
      });
      return out;
    },
    logText: (a, r) => `placed sample pad ${a.kit_id} on ${a.track_id ? r.track_id : `new track ${r.track_id}`} at ${r.start}s as empty clip ${r.clip_id}`,
  },
  {
    name: 'rename_pad',
    description: 'Rename one pad of a sample pad (kit), e.g. "Vox chop".',
    parameters: obj({ kit_id: str('Kit id'), pad: int(PAD_HELP), label: str('New pad name') }, ['kit_id', 'pad', 'label']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.renamePad(s, a.kit_id, a.pad, a.label));
      return { kit_id: a.kit_id, pad: a.pad, label: K.getKit(ctx.store.get(), a.kit_id).pads[a.pad].label };
    },
    logText: (a, r) => `renamed pad ${a.pad} of ${a.kit_id} to "${r.label}"`,
  },
  {
    name: 'rename_kit',
    description: 'Rename a sample pad (kit).',
    parameters: obj({ kit_id: str('Kit id'), name: str('New name') }, ['kit_id', 'name']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.renameKit(s, a.kit_id, a.name));
      return { kit_id: a.kit_id, name: K.getKit(ctx.store.get(), a.kit_id).name };
    },
    logText: (a, r) => `renamed sample pad ${a.kit_id} to "${r.name}"`,
  },
  {
    name: 'delete_kit',
    description: 'Delete a sample pad (kit). Takes recorded on it stay and play the built-in drum sounds; undoable.',
    parameters: obj({ kit_id: str('Kit id') }, ['kit_id']),
    run: (ctx, a) => {
      const name = K.getKit(ctx.store.get(), a.kit_id).name;
      edit(ctx, (s) => K.deleteKit(s, a.kit_id));
      return { deleted: a.kit_id, name };
    },
    logText: (_a, r) => `deleted sample pad ${r.deleted} "${r.name}"`,
  },
];
