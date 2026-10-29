// B12 drum pad tools: make a kit, put sounds on its pads, rename, clear, delete. The user does
// these from the Ideas column and the pad view; Muse can too (sounds already in the session).
import * as K from './kit';
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
    description: `Make a new drum pad (kit): ${K.PAD_COUNT} empty pads on General MIDI drum notes, shown in the Ideas column. Fill it with set_pad.`,
    parameters: obj({ name: str('Kit name, e.g. "Lo-fi kit" (default "Drum pad N")') }),
    run: (ctx, a) => {
      let kit!: K.Kit;
      edit(ctx, (s) => {
        const [s1, k] = K.createKit(s, a.name);
        kit = k;
        return s1;
      });
      return { kit_id: kit.id, name: kit.name, pads: kit.pads.map((p, i) => `${i} ${p.label} (${p.note})`) };
    },
    logText: (_a, r) => `made drum pad ${r.kit_id} "${r.name}"`,
  },
  {
    name: 'set_pad',
    description: 'Put a sound (a source in the session, e.g. an Ideas sound) on a drum pad; it plays once through, unpitched, on the pad\'s note.',
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
    description: 'Take the sound off a drum pad (it plays the built-in drum sound again).',
    parameters: obj({ kit_id: str('Kit id'), pad: int(PAD_HELP) }, ['kit_id', 'pad']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.clearPad(s, a.kit_id, a.pad));
      return { kit_id: a.kit_id, pad: a.pad };
    },
    logText: (a) => `cleared pad ${a.pad} of ${a.kit_id}`,
  },
  {
    name: 'rename_kit',
    description: 'Rename a drum pad (kit).',
    parameters: obj({ kit_id: str('Kit id'), name: str('New name') }, ['kit_id', 'name']),
    run: (ctx, a) => {
      edit(ctx, (s) => K.renameKit(s, a.kit_id, a.name));
      return { kit_id: a.kit_id, name: K.getKit(ctx.store.get(), a.kit_id).name };
    },
    logText: (a, r) => `renamed drum pad ${a.kit_id} to "${r.name}"`,
  },
  {
    name: 'delete_kit',
    description: 'Delete a drum pad (kit). Takes recorded on it stay and play the built-in drum sounds; undoable.',
    parameters: obj({ kit_id: str('Kit id') }, ['kit_id']),
    run: (ctx, a) => {
      const name = K.getKit(ctx.store.get(), a.kit_id).name;
      edit(ctx, (s) => K.deleteKit(s, a.kit_id));
      return { deleted: a.kit_id, name };
    },
    logText: (_a, r) => `deleted drum pad ${r.deleted} "${r.name}"`,
  },
];
