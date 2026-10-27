// Knob catalog: one JSON (catalog.json) that the UI, the agent tools and the renderer all
// read. This module is pure (no Web Audio) so it runs in the Electron main process, the
// renderer and vitest alike. See docs/plugin-catalog.md section 6.
import catalogJson from './catalog.json';
import vocabJson from './vocab.json';

export type ParamType = 'float' | 'int' | 'enum' | 'bool';
export type Curve = 'lin' | 'log' | 'db';
export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export interface ParamDef {
  id: string;
  label: string;
  type: ParamType;
  unit?: string;
  min?: number;
  max?: number;
  default: ParamValue;
  curve?: Curve;
  step?: number;
  options?: (string | number)[];
  agentRange?: [number, number];
  nudge?: number;
  group?: string;
  target?: string;
  rebuild?: boolean;
  smoothingMs?: number;
  tempoSync?: boolean;
  words?: string[];
  help?: string;
}

export type ImplKind = 'native' | 'tone' | 'faust' | 'worklet' | 'signalsmith' | 'wam';

export interface DeviceDef {
  id: string;
  label: string;
  category: string;
  logicRef?: string;
  impl: { kind: ImplKind; module: string; license?: string; latencyParam?: string };
  params: ParamDef[];
  meters?: string[];
  words?: string[];
  presetParam?: string;
  presets?: Record<string, ParamValues>;
}

export interface Catalog {
  version: number;
  devices: DeviceDef[];
}

export interface VocabMove {
  device: string;
  param: string;
  op: 'set' | 'add' | 'mul';
  value: ParamValue;
}
export interface VocabEntry {
  word: string;
  sourceTypes: string[];
  moves: VocabMove[];
}

export const CATALOG = catalogJson as unknown as Catalog;
export const VOCAB = (vocabJson as unknown as { entries: VocabEntry[] }).entries;
export const DEVICE_IDS = CATALOG.devices.map((d) => d.id);
const BY_ID = new Map(CATALOG.devices.map((d) => [d.id, d]));

export class CatalogError extends Error {}

export function getDevice(kind: string): DeviceDef {
  const d = BY_ID.get(kind);
  if (!d) throw new CatalogError(`unknown device "${kind}" (devices: ${DEVICE_IDS.join(', ')})`);
  return d;
}

export function getParam(dev: DeviceDef, id: string): ParamDef {
  const p = dev.params.find((p) => p.id === id);
  if (!p) throw new CatalogError(`device ${dev.id} has no param "${id}" (params: ${dev.params.map((p) => p.id).join(', ')})`);
  return p;
}

export function defaults(kind: string): ParamValues {
  return Object.fromEntries(getDevice(kind).params.map((p) => [p.id, p.default]));
}

const clampTo = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Coerce and bound a value for a param. Returns the value actually used and whether it was clamped.
 *  `range` narrows the bounds (e.g. the agentRange) but never widens them past min/max. */
export function coerce(p: ParamDef, raw: unknown, range?: [number, number]): { value: ParamValue; clamped: boolean } {
  switch (p.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { value: raw, clamped: false };
      if (raw === 'true' || raw === 1 || raw === 'on') return { value: true, clamped: false };
      if (raw === 'false' || raw === 0 || raw === 'off') return { value: false, clamped: false };
      throw new CatalogError(`${p.id} must be true or false`);
    }
    case 'enum': {
      const opts = p.options ?? [];
      const hit = opts.find((o) => o === raw || String(o) === String(raw));
      if (hit === undefined) throw new CatalogError(`${p.id} must be one of ${opts.join(', ')}`);
      return { value: hit, clamped: false };
    }
    default: {
      const x = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new CatalogError(`${p.id} must be a number`);
      let lo = p.min ?? -Infinity;
      let hi = p.max ?? Infinity;
      if (range) {
        lo = Math.max(lo, range[0]);
        hi = Math.min(hi, range[1]);
      }
      let v = clampTo(x, lo, hi);
      if (p.type === 'int') v = Math.round(v);
      else v = Math.round(v * 1e4) / 1e4;
      return { value: v, clamped: Math.abs(v - x) > 1e-9 };
    }
  }
}

/** Fill defaults and coerce every value of a device; unknown keys are an error. */
export function normalizeParams(kind: string, values: Record<string, unknown> = {}): ParamValues {
  const dev = getDevice(kind);
  for (const k of Object.keys(values)) getParam(dev, k);
  const out: ParamValues = {};
  for (const p of dev.params) out[p.id] = has(values, p.id) ? coerce(p, values[p.id]).value : p.default;
  return out;
}
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key) && (o as Record<string, unknown>)[key] !== undefined;

/** Knob position 0..1 <-> value, following the param's curve (lin and db are linear in value). */
export function toNorm(p: ParamDef, v: number): number {
  const lo = p.min ?? 0;
  const hi = p.max ?? 1;
  if (p.curve === 'log' && lo > 0) return clampTo(Math.log(v / lo) / Math.log(hi / lo), 0, 1);
  return clampTo((v - lo) / (hi - lo || 1), 0, 1);
}

export function fromNorm(p: ParamDef, n: number): number {
  const lo = p.min ?? 0;
  const hi = p.max ?? 1;
  const t = clampTo(n, 0, 1);
  const v = p.curve === 'log' && lo > 0 ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo);
  if (p.type === 'int') return Math.round(v);
  const step = p.step ?? 0;
  return step ? Math.round(v / step) * step : v;
}

/** "a bit more/less": one nudge step in curve space (octaves for log curves). */
export function nudge(p: ParamDef, v: number, steps: number): number {
  const n = (p.nudge ?? (p.curve === 'log' ? 0.333 : ((p.max ?? 1) - (p.min ?? 0)) / 20)) * steps;
  return p.curve === 'log' ? v * Math.pow(2, n) : v + n;
}

export function formatValue(p: ParamDef, v: ParamValue): string {
  if (typeof v !== 'number') return String(v);
  const u = p.unit ?? '';
  const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
  const num = trim(Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (u === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz`;
  return u ? (u === ':1' ? `${num}:1` : `${num} ${u}`) : num;
}

/** Latency in seconds a device adds at these settings (for the session summary / PDC). */
export function latencySeconds(kind: string, values: ParamValues): number {
  const d = getDevice(kind);
  if (d.impl.latencyParam) return Number(values[d.impl.latencyParam] ?? 0) / 1000;
  return 0;
}

/** One-line description of a device's non-default settings, for Muse's text view. */
export function describeSettings(kind: string, values: ParamValues): string {
  const dev = getDevice(kind);
  const parts = dev.params.filter((p) => values[p.id] !== undefined && values[p.id] !== p.default).map((p) => `${p.id}=${formatValue(p, values[p.id])}`);
  return parts.length ? parts.join(', ') : 'defaults';
}

/** Compact catalog text for the agent: devices, params with ranges, units and words. */
export function describeCatalog(kind?: string): string {
  const devs = kind ? [getDevice(kind)] : CATALOG.devices;
  return devs
    .map((d) => {
      const head = `${d.id} (${d.label}; like Logic ${d.logicRef ?? d.label}) words: ${(d.words ?? []).join(', ')}`;
      if (!kind) return head;
      const ps = d.params.map((p) => {
        const r = p.type === 'enum' ? `one of ${p.options!.join('/')}` : p.type === 'bool' ? 'true/false' : `${p.min}..${p.max} ${p.unit ?? ''}`.trim();
        const ar = p.agentRange ? `, usual ${p.agentRange[0]}..${p.agentRange[1]}` : '';
        return `  - ${p.id}: ${p.label}, ${r}${ar}, default ${p.default}${p.help ? `. ${p.help}` : ''}`;
      });
      return [head, ...ps].join('\n');
    })
    .join('\n');
}

/** Structural key: params flagged `rebuild` change the graph shape, not just a value. */
export function structureKey(kind: string, values: ParamValues): string {
  return getDevice(kind)
    .params.filter((p) => p.rebuild)
    .map((p) => `${p.id}=${values[p.id]}`)
    .join('|');
}

/** Delay times for synced notes, in beats (quarter = 1). */
export const NOTE_BEATS: Record<string, number> = {
  '1/32': 0.125, '1/16t': 1 / 6, '1/16': 0.25, '1/16d': 0.375, '1/8t': 1 / 3, '1/8': 0.5, '1/8d': 0.75,
  '1/4t': 2 / 3, '1/4': 1, '1/4d': 1.5, '1/2': 2, '1/1': 4,
};
