// B12 sample pad tools: make a kit, put sounds on its pads, rename, clear, delete. The user does
// these from the Ideas column and the pad view; Muse can too (sounds already in the session).
import * as K from './kit';
import { barLength } from './metronome';
import { recordMidiTake } from './midiTools';
import * as S from './session';
import type { ToolContext, ToolDef } from './tools';

const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description, minimum: 0, maximum: K.PAD_COUNT - 1 });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const PAD_HELP = `Pad index 0-${K.PAD_COUNT - 1}, top row first (keys ${K.PAD_KEYS.map((_, i) => K.padKeyLabel(i)).join(' ')}; ` +
  `defaults ${K.DEFAULT_PADS.map((p, i) => `${i} ${p.label.toLowerCase()}`).join(', ')})`;

function edit(ctx: ToolContext, fn: (s: S.Session) => S.Session) {
  ctx.store.set(fn(ctx.store.get()));
}

export const KIT_TOOLS: ToolDef[] = [
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
    description: 'Put a sound (a source in the session, e.g. an Ideas sound) on a pad of a sample pad; it plays once through, unpitched, on the pad\'s note. The pad takes the sound\'s name unless you give a label or it was renamed.',
    parameters: obj({ kit_id: str('Kit id, e.g. "k3"'), pad: int(PAD_HELP), source_id: str('Source id of the sound'), label: str('New pad name (optional)') }, ['kit_id', 'pad', 'source_id']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.setPad(s, a.kit_id, a.pad, a.source_id, a.label));
      const s = ctx.store.get();
      return { kit_id: a.kit_id, pad: a.pad, label: K.getKit(s, a.kit_id).pads[a.pad].label, sound: s.sources[a.source_id].name };
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
