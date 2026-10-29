// Pure session ops on a track's insert chain. Values are always bounded by the catalog
// (min/max, enum options); callers may pass a narrower range (Muse gets the agentRange).
import { coerce, getDevice, getParam, normalizeParams, nudge, type ParamValue } from './catalog';
import { getTrack, mapTrack, nextId, SessionError, type DeviceInstance, type Session } from '../core/session';

export const MAX_DEVICES_PER_TRACK = 16;

export function findDevice(s: Session, trackId: string, deviceId: string): DeviceInstance {
  const t = getTrack(s, trackId);
  const d = (t.devices ?? []).find((d) => d.id === deviceId);
  if (!d) {
    const have = (t.devices ?? []).map((d) => `${d.id} ${d.kind}`).join(', ') || 'none';
    throw new SessionError(`track ${trackId} has no device "${deviceId}" (devices: ${have})`);
  }
  return d;
}

/** Resolve a device reference: an instance id ("d4") or a kind ("comp") if exactly one exists. */
export function resolveDevice(s: Session, trackId: string, ref: string): DeviceInstance {
  const t = getTrack(s, trackId);
  const byId = (t.devices ?? []).find((d) => d.id === ref);
  if (byId) return byId;
  const byKind = (t.devices ?? []).filter((d) => d.kind === ref);
  if (byKind.length === 1) return byKind[0];
  if (byKind.length > 1) throw new SessionError(`track ${trackId} has ${byKind.length} "${ref}" devices; use the device id (${byKind.map((d) => d.id).join(', ')})`);
  return findDevice(s, trackId, ref);
}

export function insertDevice(s: Session, trackId: string, kind: string, index?: number, params: Record<string, unknown> = {}): [Session, DeviceInstance] {
  getDevice(kind);
  const t = getTrack(s, trackId);
  const chain = t.devices ?? [];
  if (chain.length >= MAX_DEVICES_PER_TRACK) throw new SessionError(`track ${trackId} already has ${MAX_DEVICES_PER_TRACK} devices`);
  let values;
  try {
    values = normalizeParams(kind, applyPresetFirst(kind, params));
  } catch (e) {
    throw new SessionError((e as Error).message);
  }
  const [s1, id] = nextId(s, 'd');
  const dev: DeviceInstance = { id, kind, on: true, params: values };
  const at = index == null ? chain.length : Math.max(0, Math.min(chain.length, Math.round(index)));
  const next = [...chain.slice(0, at), dev, ...chain.slice(at)];
  return [mapTrack(s1, trackId, (t) => ({ ...t, devices: next })), dev];
}

/** If params select a preset (e.g. comp style), the preset's values go first and explicit ones win. */
function applyPresetFirst(kind: string, params: Record<string, unknown>): Record<string, unknown> {
  const d = getDevice(kind);
  if (!d.presetParam || params[d.presetParam] === undefined) return params;
  return { ...(d.presets?.[String(params[d.presetParam])] ?? {}), ...params };
}

export function removeDevice(s: Session, trackId: string, deviceId: string): Session {
  findDevice(s, trackId, deviceId);
  return mapTrack(s, trackId, (t) => ({ ...t, devices: t.devices.filter((d) => d.id !== deviceId) }));
}

export function moveDevice(s: Session, trackId: string, deviceId: string, index: number): Session {
  const dev = findDevice(s, trackId, deviceId);
  return mapTrack(s, trackId, (t) => {
    const rest = t.devices.filter((d) => d.id !== deviceId);
    const at = Math.max(0, Math.min(rest.length, Math.round(index)));
    return { ...t, devices: [...rest.slice(0, at), dev, ...rest.slice(at)] };
  });
}

export function setDeviceOn(s: Session, trackId: string, deviceId: string, on: boolean): Session {
  findDevice(s, trackId, deviceId);
  return mapTrack(s, trackId, (t) => ({ ...t, devices: t.devices.map((d) => (d.id === deviceId ? { ...d, on } : d)) }));
}

export interface ParamChange {
  param: string;
  value: ParamValue;
  previous: ParamValue;
  clamped: boolean;
  /** other params changed as a side effect (preset selection) */
  also?: Record<string, ParamValue>;
}

/** Set one param. `op`: set (default), add, mul, or nudge (value = number of nudge steps, may be negative). */
export function setDeviceParam(
  s: Session,
  trackId: string,
  deviceId: string,
  param: string,
  raw: unknown,
  opts: { op?: 'set' | 'add' | 'mul' | 'nudge'; range?: 'full' | 'agent' } = {},
): [Session, ParamChange] {
  const dev = findDevice(s, trackId, deviceId);
  const def = getDevice(dev.kind);
  let p;
  try {
    p = getParam(def, param);
  } catch (e) {
    throw new SessionError((e as Error).message);
  }
  const prev = dev.params[param];
  let target: unknown = raw;
  const op = opts.op ?? 'set';
  if (op !== 'set') {
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) raw = Number(raw); // Muse sends "-1"
    if (typeof prev !== 'number' || typeof raw !== 'number') throw new SessionError(`op "${op}" needs a numeric param and value`);
    target = op === 'add' ? prev + raw : op === 'mul' ? prev * raw : nudge(p, prev, raw);
  }
  let res;
  try {
    res = coerce(p, target, opts.range === 'agent' ? p.agentRange : undefined);
  } catch (e) {
    throw new SessionError((e as Error).message);
  }
  let also: Record<string, ParamValue> | undefined;
  let params = { ...dev.params, [param]: res.value };
  if (def.presetParam === param && def.presets?.[String(res.value)]) {
    also = normalizeParams(dev.kind, def.presets[String(res.value)]);
    also = Object.fromEntries(Object.keys(def.presets[String(res.value)]).map((k) => [k, also![k]]));
    params = { ...params, ...also };
  }
  const s1 = mapTrack(s, trackId, (t) => ({ ...t, devices: t.devices.map((d) => (d.id === deviceId ? { ...d, params } : d)) }));
  return [s1, { param, value: res.value, previous: prev, clamped: res.clamped, ...(also ? { also } : {}) }];
}
