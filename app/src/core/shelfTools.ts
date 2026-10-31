// B17 sound shelf tools: star a sound (library, Ideas, a pad), export a track or region through
// its effects as a sound in My Sounds, find a sound on the shelves, bring one into the session
// (Ideas, a pad, a track), and reopen an export with its source and chain. The shelves span
// projects; the renderer does the rendering (ctx.render), as measure_track does.
import * as C from '../fx/chain';
import * as K from './kit';
import { attribution, needsAttribution, type LibraryEntry } from './library';
import { findOnShelf, soundShelf, SHELF_LABELS, type ShelfItem, type ShelfName } from './shelf';
import * as S from './session';
import type { ToolContext, ToolDef } from './tools';

const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const num = (description: string, extra: object = {}) => ({ type: 'number', description, ...extra });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const view = (i: ShelfItem) => ({
  shelf_id: i.id,
  shelf: SHELF_LABELS[i.shelf],
  name: i.name,
  duration: r3(i.duration),
  from: i.from,
  ...(i.recipe ? { reopenable: true, chain: i.recipe.devices.map((d) => d.kind) } : {}),
  ...(i.kit ? { sample_pad: true, pads: i.kit.pads.filter((p) => p.sound).length } : {}),
  ...(i.credit ? { credit: i.credit } : {}),
});

function renderer(ctx: ToolContext) {
  if (!ctx.render) throw new S.SessionError('no audio here to render (the app window renders sounds)');
  return ctx.render;
}

function shelfItem(ctx: ToolContext, id: string): ShelfItem {
  const item = soundShelf(ctx).get(id);
  if (!item) throw new S.SessionError(`no sound "${id}" on the shelves (find_sound_in_shelf lists them)`);
  return item;
}

/** Hand a shelf sound's audio to the session side under a new source id (the renderer loads it
 *  like a restored source, B11). Returns the new source id. */
export async function adopt(ctx: ToolContext, ref: { bytes: Uint8Array } | { library: string }): Promise<string> {
  if (!ctx.adoptAudio) throw new S.SessionError('shelf sounds cannot be loaded here');
  const id = `src-${Math.random().toString(36).slice(2, 10)}`;
  await ctx.adoptAudio(id, ref);
  return id;
}

export async function library(ctx: ToolContext): Promise<LibraryEntry[]> {
  if (!ctx.listLibrary) throw new S.SessionError('the sound library is not available here');
  return ctx.listLibrary();
}

/** B12b: bring library items into the session as sources (Ideas), the way the user's + does:
 *  the renderer loads each one's audio (adoptAudio), CC-BY items keep their credit. Returns a
 *  session with the sources added (not yet stored) and the new source id per library id. */
export async function librarySources(ctx: ToolContext, s: S.Session, ids: string[]): Promise<{ session: S.Session; sourceOf: Map<string, string> }> {
  const items = await library(ctx);
  const sourceOf = new Map<string, string>();
  let next = s;
  for (const id of new Set(ids)) {
    const item = items.find((i) => i.id === id);
    if (!item) throw new S.SessionError(`no library sound "${id}" (find_library_sounds lists them)`);
    const sourceId = await adopt(ctx, { library: item.id });
    next = S.addSource(next, {
      id: sourceId,
      name: item.name,
      duration: item.duration,
      origin: item.set === 'voice_notes' ? 'record' : 'freesound',
      ...(needsAttribution(item) ? { credit: attribution(item) } : {}),
    });
    sourceOf.set(id, sourceId);
  }
  return { session: next, sourceOf };
}

function addSource(ctx: ToolContext, item: ShelfItem, sourceId: string, name = item.name) {
  const origin: S.SourceOrigin = item.library ? 'freesound' : item.from === 'recording' ? 'record' : 'import';
  ctx.store.set(S.addSource(ctx.store.get(), { id: sourceId, name, duration: item.duration, origin, ...(item.credit ? { credit: item.credit } : {}) }));
}

/** A saved sample pad comes back as a new kit: each pad's sound is loaded as a source and put on
 *  its pad, with the pad's name. */
async function useKit(ctx: ToolContext, item: ShelfItem, a: Record<string, any>) {
  if (a.kit_id !== undefined || a.pad !== undefined || a.place || a.track_id) {
    throw new S.SessionError(`"${item.name}" is a whole sample pad: it comes back as a new one (drag it onto the arrangement, or place_kit, for a region)`);
  }
  const pads = item.kit!.pads;
  const sources: (string | undefined)[] = [];
  for (const [i, p] of pads.entries()) {
    const bytes = p.sound && soundShelf(ctx).padAudio(item.id, i);
    if (!p.sound) continue;
    if (!bytes) throw new S.SessionError(`the audio of pad ${i} ("${p.sound.name}") of "${item.name}" is missing`);
    sources[i] = await adopt(ctx, { bytes });
  }
  let [s, kit] = K.createKit(ctx.store.get(), item.name);
  for (const [i, p] of pads.entries()) {
    const id = sources[i];
    if (id) {
      s = S.addSource(s, { id, name: p.sound!.name, duration: p.sound!.duration, origin: 'import', ...(p.sound!.credit ? { credit: p.sound!.credit } : {}) });
      s = K.setPad(s, kit.id, i, id, p.label);
    } else if (i < K.PAD_COUNT && p.label !== kit.pads[i].label) s = K.renamePad(s, kit.id, i, p.label);
  }
  ctx.store.set(s);
  kit = K.getKit(s, kit.id);
  return { shelf_id: item.id, name: item.name, kit_id: kit.id, pads: kit.pads.flatMap((p, i) => (p.sample ? [`${i} ${K.padKeyLabel(i)} ${p.label}`] : [])) };
}

export const SHELF_TOOLS: ToolDef[] = [
  {
    name: 'star_sound',
    description:
      'Star a sound so it is kept on the Starred shelf across projects: a library item (library_id), a sound in the session (source_id: Ideas, a recording) ' +
      'or the sound on a sample pad (kit_id + pad). Starring the same sound again does nothing.',
    parameters: obj({
      library_id: str('Library item id, e.g. "fs:858950"'),
      source_id: str('Source id of a session sound'),
      kit_id: str('Kit id, with pad'),
      pad: { type: 'integer', minimum: 0, maximum: K.PAD_COUNT - 1, description: 'Pad index, with kit_id' },
      name: str('Name on the shelf (default: the sound\'s name)'),
    }),
    run: async (ctx, a) => {
      const shelf = soundShelf(ctx);
      const starred = shelf.list('starred');
      if (a.library_id) {
        const have = starred.find((i) => i.library === a.library_id);
        if (have) return { ...view(have), already: true };
        const entry = await ctx.findLibrary?.(a.library_id);
        if (!entry) throw new S.SessionError(`no library item "${a.library_id}"`);
        const credit = /^CC-BY/i.test(entry.license) ? `"${entry.name}"${entry.author ? ` by ${entry.author}` : ''}${entry.url ? ` (${entry.url})` : ''}, ${entry.license}` : undefined;
        return view(shelf.add({ shelf: 'starred', name: a.name ?? entry.name, duration: entry.duration, from: 'library', library: entry.id, ...(credit ? { credit } : {}) }));
      }
      let sourceId: string | undefined = a.source_id;
      let from: ShelfItem['from'] = 'idea';
      const s = ctx.store.get();
      if (a.kit_id !== undefined || a.pad !== undefined) {
        if (a.kit_id === undefined || a.pad === undefined) throw new S.SessionError('give kit_id and pad together');
        sourceId = K.getKit(s, a.kit_id).pads[a.pad]?.sample?.sourceId;
        if (!sourceId) throw new S.SessionError(`pad ${a.pad} of ${a.kit_id} has no sound on it (built-in drum sounds can't be starred)`);
        from = 'pad';
      }
      if (!sourceId) throw new S.SessionError('give library_id, source_id, or kit_id and pad');
      const src = s.sources[sourceId];
      if (!src) throw new S.SessionError(`no source "${sourceId}"`);
      if (src.origin === 'generated') throw new S.SessionError(`"${src.name}" is a MIDI region; export_sound renders it as audio`);
      const have = starred.find((i) => i.sourceId === sourceId);
      if (have) return { ...view(have), already: true };
      const r = await renderer(ctx)(s, { kind: 'source', sourceId });
      const item = shelf.add({ shelf: 'starred', name: a.name ?? src.name, duration: r.duration, from, sourceId, ...(src.credit ? { credit: src.credit } : {}) }, r.wav);
      return view(item);
    },
    logText: (_a, r) => (r.already ? `"${r.name}" was already starred (${r.shelf_id})` : `starred "${r.name}" (${r.shelf_id})`),
  },
  {
    name: 'unstar_sound',
    description: 'Take a sound off its shelf (Starred or My Sounds) by shelf_id.',
    parameters: obj({ shelf_id: str('Shelf id, e.g. "sh-3k2j9x1a"') }, ['shelf_id']),
    run: (ctx, a) => {
      const item = shelfItem(ctx, a.shelf_id);
      soundShelf(ctx).remove(item.id);
      return { removed: item.id, name: item.name, shelf: SHELF_LABELS[item.shelf] };
    },
    logText: (_a, r) => `took "${r.name}" off ${r.shelf}`,
  },
  {
    name: 'rename_shelf_sound',
    description: 'Rename a sound on a shelf (Starred or My Sounds) by shelf_id, e.g. "call that export Lofi Pluck".',
    parameters: obj({ shelf_id: str('Shelf id, e.g. "sh-3k2j9x1a"'), name: str('The new name') }, ['shelf_id', 'name']),
    run: (ctx, a) => {
      const item = shelfItem(ctx, a.shelf_id);
      const name = String(a.name ?? '').trim();
      if (!name) throw new S.SessionError('a name cannot be empty');
      return { ...view(soundShelf(ctx).rename(item.id, name)!), was: item.name };
    },
    logText: (_a, r) => `renamed "${r.was}" to "${r.name}" in ${r.shelf}`,
  },
  {
    name: 'export_sound',
    description:
      'Export a region (clip_id) or a whole track (track_id) as a sound in My Sounds, rendered through the track\'s effects: the reverb/delay tail is kept and ' +
      'trailing silence trimmed. It remembers how it was made (the audio before the effects and the chain), so reopen_sound can change it later. ' +
      'With source_id it keeps a session sound (e.g. a recording) as it is. Defaults to the selected clip, else the selected track.',
    parameters: obj({ clip_id: str('Region (clip) id'), track_id: str('Track id (the whole track)'), source_id: str('A session sound to keep as it is'), name: str('Name in My Sounds') }),
    run: async (ctx, a) => {
      const s = ctx.store.get();
      const shelf = soundShelf(ctx);
      if (a.source_id) {
        const src = s.sources[a.source_id];
        if (!src) throw new S.SessionError(`no source "${a.source_id}"`);
        const r = await renderer(ctx)(s, { kind: 'source', sourceId: a.source_id });
        const item = shelf.add({ shelf: 'mine', name: a.name ?? src.name, duration: r.duration, from: src.origin === 'record' ? 'recording' : 'export', sourceId: a.source_id, ...(src.credit ? { credit: src.credit } : {}) }, r.wav);
        return view(item);
      }
      let trackId: string | undefined = a.track_id;
      let clipIds: string[] | undefined;
      const clipId = a.clip_id ?? (a.track_id ? undefined : s.selection.clipId ?? undefined);
      if (clipId) {
        const f = S.findClip(s, clipId);
        trackId = f.track.id;
        clipIds = [clipId];
      }
      trackId ??= s.selection.trackId ?? undefined;
      if (!trackId) throw new S.SessionError('give clip_id or track_id (nothing is selected)');
      const t = S.getTrack(s, trackId);
      if (!t.clips.length) throw new S.SessionError(`track ${trackId} has no regions`);
      const r = await renderer(ctx)(s, { kind: 'sound', trackId, ...(clipIds ? { clipIds } : {}) });
      const clipName = clipIds ? S.findClip(s, clipIds[0]).clip.name : null;
      const name = String(a.name ?? '').trim() || (clipName && clipName !== t.name ? `${t.name} ${clipName}` : t.name);
      const devices = t.devices.map((d) => ({ kind: d.kind, on: d.on, params: { ...d.params } }));
      const item = shelf.add({ shelf: 'mine', name, duration: r.duration, from: 'export', recipe: { trackName: t.name, devices, sourceDuration: r.dryDuration } }, r.wav, r.dry);
      return { ...view(item), from_track: trackId, ...(clipIds ? { from_clip: clipIds[0] } : {}), effect_tail_s: r3(r.tail) };
    },
    logText: (_a, r) => `exported "${r.name}" to My Sounds (${r.shelf_id}, ${r.duration}s)`,
  },
  {
    name: 'save_kit',
    description:
      'Save a whole sample pad (kit) to My Sounds, kept across projects like a sound: its pads\' names and sounds. use_shelf_sound brings it back as a new sample pad.',
    parameters: obj({ kit_id: str('Kit id, e.g. "k3"'), name: str('Name in My Sounds (default: the kit\'s name)') }, ['kit_id']),
    run: async (ctx, a) => {
      const s = ctx.store.get();
      const kit = K.getKit(s, a.kit_id);
      if (!kit.pads.some((p) => p.sample)) throw new S.SessionError(`sample pad "${kit.name}" has no sounds on it yet`);
      const audio: (Uint8Array | undefined)[] = [];
      const pads: NonNullable<ShelfItem['kit']>['pads'] = [];
      for (const [i, p] of kit.pads.entries()) {
        const src = p.sample && s.sources[p.sample.sourceId];
        if (!src) {
          pads.push({ label: p.label, note: p.note });
          continue;
        }
        const r = await renderer(ctx)(s, { kind: 'source', sourceId: src.id });
        audio[i] = r.wav;
        pads.push({ label: p.label, note: p.note, sound: { name: src.name, duration: r.duration, ...(src.credit ? { credit: src.credit } : {}) } });
      }
      const credits = [...new Set(pads.flatMap((p) => (p.sound?.credit ? [p.sound.credit] : [])))];
      const name = String(a.name ?? '').trim() || kit.name;
      const duration = Math.max(...pads.map((p) => p.sound?.duration ?? 0));
      const item = soundShelf(ctx).add({ shelf: 'mine', name, duration, from: 'kit', kit: { pads }, ...(credits.length ? { credit: credits.join('; ') } : {}) }, undefined, undefined, audio);
      return { ...view(item), kit_id: kit.id };
    },
    logText: (_a, r) => `saved sample pad ${r.kit_id} to My Sounds as "${r.name}" (${r.shelf_id}, ${r.pads} sounds)`,
  },
  {
    name: 'find_sound_in_shelf',
    description:
      'Find sounds on the user\'s shelves, kept across projects: Starred (starred from the library, Ideas or pads) and My Sounds (recordings and exports). ' +
      'Every query word must match the name or where it came from; no query lists everything. Then use_shelf_sound brings one into the session.',
    parameters: obj({ query: str('Words to match, e.g. "kick"'), shelf: str('Only this shelf', { enum: ['starred', 'mine'] }) }),
    quiet: true,
    run: (ctx, a) => {
      const items = findOnShelf(soundShelf(ctx).list(a.shelf as ShelfName | undefined), a.query);
      return { count: items.length, sounds: items.slice(0, 30).map(view) };
    },
  },
  {
    name: 'use_shelf_sound',
    description:
      'Bring a shelf sound into this project: it joins the Ideas column, and with kit_id + pad goes on that sample pad (e.g. "put my starred kick on pad Q"), ' +
      'or with place=true / track_id goes on a track at start (seconds). A saved sample pad (sample_pad: true) comes back as a new sample pad with its sounds.',
    parameters: obj(
      {
        shelf_id: str('Shelf id'),
        kit_id: str('Sample pad (kit) id, with pad'),
        pad: { type: 'integer', minimum: 0, maximum: K.PAD_COUNT - 1, description: `Pad index 0-${K.PAD_COUNT - 1} (keys ${K.PAD_KEYS.map((_, i) => K.padKeyLabel(i)).join(' ')})` },
        place: { type: 'boolean', description: 'true = put it on a new track (or track_id)' },
        track_id: str('Existing track to put it on'),
        start: num('Timeline seconds (default 0)'),
      },
      ['shelf_id'],
    ),
    run: async (ctx, a) => {
      const item = shelfItem(ctx, a.shelf_id);
      if (item.kit) return useKit(ctx, item, a);
      if ((a.kit_id === undefined) !== (a.pad === undefined)) throw new S.SessionError('give kit_id and pad together');
      if (a.kit_id) K.getKit(ctx.store.get(), a.kit_id); // fail before adopting audio
      if (a.track_id) S.getTrack(ctx.store.get(), a.track_id);
      const bytes = item.library ? null : soundShelf(ctx).audio(item.id);
      if (!item.library && !bytes) throw new S.SessionError(`the audio of "${item.name}" is missing`);
      const sourceId = await adopt(ctx, item.library ? { library: item.library } : { bytes: bytes! });
      addSource(ctx, item, sourceId);
      let out: Record<string, unknown> = { shelf_id: item.id, name: item.name, source_id: sourceId };
      if (a.kit_id) {
        ctx.store.set(K.setPad(ctx.store.get(), a.kit_id, a.pad, sourceId));
        out = { ...out, kit_id: a.kit_id, pad: a.pad, pad_label: K.getKit(ctx.store.get(), a.kit_id).pads[a.pad].label };
      }
      if (a.place || a.track_id) {
        let s = ctx.store.get();
        let trackId = a.track_id as string | undefined;
        if (!trackId) [s, { id: trackId }] = S.addTrack(s, item.name);
        const [s2, c] = S.addClip(s, trackId!, sourceId, a.start ?? 0);
        ctx.store.set(S.select(s2, trackId!, c.id));
        out = { ...out, track_id: trackId, clip_id: c.id, start: c.start };
      }
      return out;
    },
    logText: (_a, r) => r.kit_id && !r.source_id ? `brought sample pad "${r.name}" from the shelf as ${r.kit_id}` : `brought "${r.name}" from the shelf as ${r.source_id}${r.kit_id ? ` onto pad ${r.pad} of ${r.kit_id}` : ''}${r.clip_id ? ` onto ${r.track_id} as clip ${r.clip_id}` : ''}`,
  },
  {
    name: 'reopen_sound',
    description:
      'Reopen an exported sound the way it was made: its audio before the effects goes on a new track with the original device chain loaded, so it can be changed and exported again.',
    parameters: obj({ shelf_id: str('Shelf id of an export (reopenable: true)') }, ['shelf_id']),
    run: async (ctx, a) => {
      const item = shelfItem(ctx, a.shelf_id);
      const bytes = soundShelf(ctx).recipeAudio(item.id);
      if (!item.recipe || !bytes) throw new S.SessionError(`"${item.name}" does not remember how it was made (only exports do); use_shelf_sound brings in the sound itself`);
      const sourceId = await adopt(ctx, { bytes });
      addSource(ctx, { ...item, credit: undefined, duration: item.recipe.sourceDuration ?? item.duration }, sourceId, `${item.name} (source)`);
      let [s, t] = S.addTrack(ctx.store.get(), item.name);
      const [s1, c] = S.addClip(s, t.id, sourceId, 0);
      s = s1;
      for (const d of item.recipe.devices) {
        const [s2, dev] = C.insertDevice(s, t.id, d.kind, undefined, d.params);
        s = d.on ? s2 : C.setDeviceOn(s2, t.id, dev.id, false);
      }
      ctx.store.set(S.select(s, t.id, c.id));
      t = S.getTrack(ctx.store.get(), t.id);
      return { shelf_id: item.id, name: item.name, track_id: t.id, clip_id: c.id, source_id: sourceId, devices: t.devices.map((d) => `${d.id} ${d.kind}`) };
    },
    logText: (_a, r) => `reopened "${r.name}" on new track ${r.track_id} with its chain (${r.devices.join(', ') || 'no devices'})`,
  },
];
