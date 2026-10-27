// Effect-chain tools. Muse and the UI call the same tools; values are bounded by the
// catalog, and Muse is additionally held to each knob's agentRange (the "sane without
// asking" range). User calls are logged as hand edits by runTool, like the other tools.
import { DEVICE_IDS, describeCatalog, describeSettings, getDevice, latencySeconds } from './catalog';
import * as C from './chain';
import * as S from '../core/session';
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
    name: 'insert_device',
    description:
      'Insert an effect device on a track\'s chain (signal flows in list order). Optionally give a position (0 = first) and starting knob values, ' +
      'e.g. {"device":"eq","params":{"b3_gain":3}}. Returns the device_id for set_param.',
    parameters: obj(
      {
        track_id: str('Track id, e.g. "t1"'),
        device: str('Device id', { enum: DEVICE_IDS }),
        position: num('Index in the chain; omit to append'),
        params: { type: 'object', description: 'Knob id -> value (see list_devices)' },
      },
      ['track_id', 'device'],
    ),
    run: (ctx, a, by) => {
      const s0 = ctx.store.get();
      const [s1, dev] = C.insertDevice(s0, a.track_id, a.device, a.position);
      let s = s1;
      const clamped: string[] = [];
      // starting values go through set_param's checks so Muse is held to the agent range too
      for (const [k, v] of Object.entries(a.params ?? {})) {
        const [s2, ch] = C.setDeviceParam(s, a.track_id, dev.id, k, v, { range: by === 'muse' ? 'agent' : 'full' });
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
      'op: "set" (default), "add" (e.g. +3 dB), "mul", or "nudge" (value = steps, 1 = "a bit more", -1 = "a bit less"). Values are clamped to the knob range.',
    parameters: obj(
      {
        track_id: str('Track id'),
        device_id: str('Device id, e.g. "d3", or device name'),
        param: str('Knob id, e.g. "thresh"'),
        value: { description: 'Number, enum option string, or boolean' },
        op: str('How to apply value', { enum: ['set', 'add', 'mul', 'nudge'] }),
      },
      ['track_id', 'device_id', 'param', 'value'],
    ),
    run: (ctx, a, by) => {
      const s0 = ctx.store.get();
      const dev = C.resolveDevice(s0, a.track_id, a.device_id);
      const [s1, ch] = C.setDeviceParam(s0, a.track_id, dev.id, a.param, a.value, { op: a.op, range: by === 'muse' ? 'agent' : 'full' });
      ctx.store.set(s1);
      const p = getDevice(dev.kind).params.find((p) => p.id === a.param)!;
      const note = ch.clamped
        ? by === 'muse' && p.agentRange
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
];
