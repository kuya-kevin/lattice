// Effect-chain tools. Muse and the UI call the same tools; values are bounded by the
// catalog, and Muse is additionally held to each knob's agentRange (the "sane without
// asking" range). User calls are logged as hand edits by runTool, like the other tools.
import { DEVICE_IDS, describeCatalog, describeSettings, getDevice, latencySeconds } from './catalog';
import * as C from './chain';
import * as S from '../core/session';
import { chainLibrary } from './savedChains';
import { compare } from '../core/ears';
import { AMOUNTS, devicesForWord, lookupWord, scaledMoves, SOURCE_TYPES, sourceTypeOf, type Amount } from './vocab';
import type { ToolDef } from '../core/tools';

const str = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const num = (description: string, extra: object = {}) => ({ type: 'number', description, ...extra });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

function chainView(s: S.Session, trackId: string) {
  const t = S.getTrack(s, trackId);
  return {
    track_id: trackId,
    chain: t.devices.map((d) => ({ device_id: d.id, device: d.kind, on: d.on, settings: describeSettings(d.kind, d.params) })),
    latency_ms: Math.round(t.devices.filter((d) => d.on).reduce((a, d) => a + latencySeconds(d.kind, d.params), 0) * 1e4) / 10,
  };
}

export const FX_TOOLS: ToolDef[] = [
  {
    name: 'list_devices',
    description:
      'Effect devices you can insert on a track, with the words they fix. Pass device (e.g. "comp") to get its knobs: ids, ranges, units, defaults and usual ranges.',
    parameters: obj({ device: str('Device id for details', { enum: DEVICE_IDS }) }),
    quiet: true,
    run: (_ctx, a) => ({ catalog: describeCatalog(a.device) }),
  },
  {
    name: 'suggest_moves',
    description:
      'For sound words ("muddy", "punchy", "stand out", "wider", "telephone"), the knob moves that usually fix them: which devices, which knobs, ' +
      'how far, tuned per source type (a warm bass differs from a warm vocal). ' +
      'Give track_id so the source type comes from the track name, and the result lists the devices the track already has (adjust those with set_param instead of inserting duplicates). ' +
      'B16: no longer offered to Muse (it acts on concrete instructions); kept for the vocab tests and a later UI.',
    parameters: obj(
      {
        words: { type: 'array', items: { type: 'string' }, description: 'The sound words, one per item, e.g. ["wider", "spacious"]' },
        track_id: str('Track the words are about'),
        source_type: str('What the track is, if the name does not say', { enum: [...SOURCE_TYPES] }),
        amount: str('How strong: "a bit", "normal" (default), "a lot"', { enum: AMOUNTS }),
      },
      ['words'],
    ),
    userOnly: true, // B16
    quiet: true,
    run: (ctx, a) => {
      const words: string[] = (Array.isArray(a.words) ? a.words : [a.words]).map(String).filter((w: string) => w.trim());
      if (!words.length) throw new S.SessionError('give at least one word');
      const track = a.track_id ? S.getTrack(ctx.store.get(), a.track_id) : undefined;
      const source: string | undefined = a.source_type ?? (track && sourceTypeOf(track.name));
      const amount: Amount = AMOUNTS.includes(a.amount) ? a.amount : 'normal';
      const suggestions = words.map((word) => {
        const e = lookupWord(word, source);
        if (!e) return { word, no_match: true, devices_with_this_word: devicesForWord(word) };
        return { word, matched: e.word, for: e.sourceTypes.join('/'), moves: scaledMoves(e, amount), ...(e.note ? { note: e.note } : {}) };
      });
      return {
        source_type: source ?? 'unknown (pass source_type)',
        amount,
        suggestions,
        ...(track ? { track_devices: track.devices.map((d) => ({ device_id: d.id, device: d.kind, on: d.on })) } : {}),
        how: 'Insert each device once with insert_device, putting the "set" moves in params; apply "add"/"mul" moves with set_param op add/mul. ' +
          'Moves for the same device across words go on one device. For "a bit more/less" later, use set_param op nudge.',
      };
    },
  },
  {
    name: 'measure_track',
    description:
      'Measure a track as heard (with its effects) and without its effects: level, peak, crest (lower = more compressed), loud-quiet spread, ' +
      'brightness (spectral centroid), level per band (sub, low, low_mid, mid, presence, sibilance, air) and stereo width. ' +
      '"what_the_fx_do" lists the changes, largest first. You cannot hear: after effect moves, call this once to check they went the way the words ask, ' +
      'and tell the user the measured change in plain words.',
    parameters: obj({ track_id: str('Track id') }, ['track_id']),
    quiet: true,
    run: async (ctx, a) => {
      const s = ctx.store.get();
      const t = S.getTrack(s, a.track_id);
      if (!t.clips.length) throw new S.SessionError(`track ${a.track_id} has no clips to measure`);
      if (!ctx.measureTrack) throw new S.SessionError('measuring needs the app with the audio loaded (not available here)');
      const { wet, dry } = await ctx.measureTrack(s, a.track_id);
      const on = t.devices.filter((d) => d.on);
      return {
        track_id: a.track_id,
        as_heard: wet,
        ...(on.length ? { without_fx: dry, what_the_fx_do: compare(dry, wet), chain: on.map((d) => d.kind) } : { what_the_fx_do: ['no effects on this track'] }),
      };
    },
  },
  {
    name: 'insert_device',
    description:
      'Insert an effect device on a track\'s chain (signal flows in list order). Optionally give a position (0 = first) and starting knob values, ' +
      'e.g. {"device":"eq","params":{"b3_gain":3}}. Returns the device_id for set_param. exact: true when the user named these values (see set_param).',
    parameters: obj(
      {
        track_id: str('Track id, e.g. "t1"'),
        device: str('Device id', { enum: DEVICE_IDS }),
        position: num('Index in the chain; omit to append'),
        params: { type: 'object', description: 'Knob id -> value (see list_devices)' },
        exact: { type: 'boolean', description: 'true when the user named these exact values: the full knob range applies' },
      },
      ['track_id', 'device'],
    ),
    run: (ctx, a, by) => {
      const s0 = ctx.store.get();
      const [s1, dev] = C.insertDevice(s0, a.track_id, a.device, a.position);
      let s = s1;
      const clamped: string[] = [];
      // starting values go through set_param's checks so Muse is held to the agent range too
      // a preset knob (comp "style") resets others, so it goes first and the explicit values win
      const preset = getDevice(dev.kind).presetParam;
      const entries = Object.entries(a.params ?? {}).sort(([x], [y]) => Number(y === preset) - Number(x === preset));
      for (const [k, v] of entries) {
        const [s2, ch] = C.setDeviceParam(s, a.track_id, dev.id, k, v, { range: by === 'muse' && !a.exact ? 'agent' : 'full' });
        if (ch.clamped) clamped.push(`${k}=${ch.value}`);
        s = s2;
      }
      ctx.store.set(s);
      return { device_id: dev.id, device: dev.kind, ...(clamped.length ? { clamped } : {}), ...chainView(s, a.track_id) };
    },
  },
  {
    name: 'set_param',
    description:
      'Set one knob on a device. device_id is the id from insert_device (or the device name if the track has only one). ' +
      'op: "set" (default), "add" (e.g. +3 dB), "mul", or "nudge" (value = steps, 1 = "a bit more", -1 = "a bit less"). Values are clamped to the knob range. ' +
      'Your own values are held to the knob\'s usual range; when the user names the value ("set the threshold to -50 dB"), pass exact: true and it is set as asked.',
    parameters: obj(
      {
        track_id: str('Track id'),
        device_id: str('Device id, e.g. "d3", or device name'),
        param: str('Knob id, e.g. "thresh"'),
        value: { description: 'Number, enum option string, or boolean' },
        op: str('How to apply value', { enum: ['set', 'add', 'mul', 'nudge'] }),
        exact: { type: 'boolean', description: 'true when the user named this exact value: the full knob range applies' },
      },
      ['track_id', 'device_id', 'param', 'value'],
    ),
    run: (ctx, a, by) => {
      const s0 = ctx.store.get();
      const dev = C.resolveDevice(s0, a.track_id, a.device_id);
      const held = by === 'muse' && !a.exact;
      const [s1, ch] = C.setDeviceParam(s0, a.track_id, dev.id, a.param, a.value, { op: a.op, range: held ? 'agent' : 'full' });
      ctx.store.set(s1);
      const p = getDevice(dev.kind).params.find((p) => p.id === a.param)!;
      const note = ch.clamped
        ? held && p.agentRange
          ? `clamped to the usual range ${p.agentRange[0]}..${p.agentRange[1]}; ask the user before going further`
          : `clamped to ${p.min}..${p.max}`
        : undefined;
      return { device_id: dev.id, param: ch.param, value: ch.value, previous: ch.previous, ...(ch.also ? { also_set: ch.also } : {}), ...(note ? { note } : {}) };
    },
  },
  {
    name: 'remove_device',
    description: 'Remove a device from a track\'s chain.',
    parameters: obj({ track_id: str('Track id'), device_id: str('Device id or name') }, ['track_id', 'device_id']),
    run: (ctx, a) => {
      const dev = C.resolveDevice(ctx.store.get(), a.track_id, a.device_id);
      const s = C.removeDevice(ctx.store.get(), a.track_id, dev.id);
      ctx.store.set(s);
      return { removed: dev.id, ...chainView(s, a.track_id) };
    },
  },
  {
    name: 'bypass_device',
    description: 'Bypass (on=false) or re-enable (on=true) a device without losing its settings.',
    parameters: obj({ track_id: str('Track id'), device_id: str('Device id or name'), on: { type: 'boolean', description: 'false = bypassed' } }, ['track_id', 'device_id', 'on']),
    run: (ctx, a) => {
      const dev = C.resolveDevice(ctx.store.get(), a.track_id, a.device_id);
      ctx.store.set(C.setDeviceOn(ctx.store.get(), a.track_id, dev.id, a.on));
      return { device_id: dev.id, on: a.on };
    },
  },
  {
    name: 'move_device',
    description: 'Move a device to another position in the chain (0 = first).',
    parameters: obj({ track_id: str('Track id'), device_id: str('Device id or name'), position: num('New index') }, ['track_id', 'device_id', 'position']),
    run: (ctx, a) => {
      const dev = C.resolveDevice(ctx.store.get(), a.track_id, a.device_id);
      const s = C.moveDevice(ctx.store.get(), a.track_id, dev.id, a.position);
      ctx.store.set(s);
      return chainView(s, a.track_id);
    },
  },
  {
    name: 'save_chain',
    description:
      'Save a track\'s whole device chain (devices, order, knob values, bypass) under a name, to load onto any track later with load_chain. ' +
      'Saving under an existing name overwrites it. Saved names are listed in the session summary.',
    parameters: obj({ track_id: str('Track id'), name: str('Name, e.g. "dark vocal"') }, ['track_id', 'name']),
    run: (ctx, a) => {
      const name = String(a.name).trim();
      if (!name) throw new S.SessionError('give the chain a name');
      const t = S.getTrack(ctx.store.get(), a.track_id);
      if (!t.devices.length) throw new S.SessionError(`track ${a.track_id} has no devices to save`);
      const devices = t.devices.map((d) => ({ kind: d.kind, on: d.on, params: { ...d.params } }));
      const replaced = chainLibrary(ctx).save({ name, devices, savedAt: new Date().toISOString() });
      return { name, devices: devices.map((d) => d.kind), replaced };
    },
  },
  {
    name: 'load_chain',
    description:
      'Load a saved chain onto a track, with its saved knob values. Appends after the track\'s current devices; replace=true clears them first.',
    parameters: obj(
      { track_id: str('Track id'), name: str('Saved chain name'), replace: { type: 'boolean', description: 'true = remove the current devices first' } },
      ['track_id', 'name'],
    ),
    run: (ctx, a) => {
      const saved = chainLibrary(ctx).get(String(a.name).trim());
      if (!saved) {
        const names = chainLibrary(ctx).list().map((c) => `"${c.name}"`);
        throw new S.SessionError(`no saved chain "${a.name}"${names.length ? ` (saved: ${names.join(', ')})` : ' (none saved yet)'}`);
      }
      let s = ctx.store.get();
      if (a.replace) s = S.mapTrack(s, a.track_id, (t) => ({ ...t, devices: [] }));
      const have = S.getTrack(s, a.track_id).devices.length;
      if (have + saved.devices.length > C.MAX_DEVICES_PER_TRACK)
        throw new S.SessionError(`track ${a.track_id} has ${have} devices; "${saved.name}" adds ${saved.devices.length}, over the limit of ${C.MAX_DEVICES_PER_TRACK} devices`);
      for (const d of saved.devices) {
        const [s1, dev] = C.insertDevice(s, a.track_id, d.kind, undefined, d.params);
        s = d.on ? s1 : C.setDeviceOn(s1, a.track_id, dev.id, false);
      }
      ctx.store.set(s); // one store update, so one undo step
      return { loaded: saved.name, ...chainView(s, a.track_id) };
    },
  },
  {
    name: 'list_chains',
    description: 'List saved device chains with their devices.',
    parameters: obj({}),
    quiet: true,
    run: (ctx) => ({ chains: chainLibrary(ctx).list().map((c) => ({ name: c.name, devices: c.devices.map((d) => d.kind), saved_at: c.savedAt })) }),
  },
];
