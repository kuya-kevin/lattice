import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG, VOCAB, coerce, defaults, fromNorm, getDevice, getParam, normalizeParams, nudge, toNorm } from '../src/fx/catalog';
import * as C from '../src/fx/chain';
import * as S from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const BUILD_ORDER = ['utility', 'eq', 'comp', 'deess', 'gate', 'limiter', 'sat', 'filter', 'delay', 'reverb', 'pitch', 'mod', 'crush'];

describe('knob catalog', () => {
  it('has the 13 v1 devices in build order with well-formed params', () => {
    expect(CATALOG.devices.map((d) => d.id)).toEqual(BUILD_ORDER);
    for (const d of CATALOG.devices) {
      expect(d.id).toMatch(/^[a-z][a-z0-9_]*$/);
      const ids = d.params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of d.params) {
        if (p.type === 'float' || p.type === 'int') {
          expect(p.min! < p.max!, `${d.id}.${p.id} range`).toBe(true);
          expect(p.default as number).toBeGreaterThanOrEqual(p.min!);
          expect(p.default as number).toBeLessThanOrEqual(p.max!);
          if (p.agentRange) {
            expect(p.agentRange[0]).toBeGreaterThanOrEqual(p.min!);
            expect(p.agentRange[1]).toBeLessThanOrEqual(p.max!);
          }
          if (p.curve === 'log') expect(p.min!).toBeGreaterThan(0);
        }
        if (p.type === 'enum') expect(p.options).toContain(p.default);
        if (p.type === 'bool') expect(typeof p.default).toBe('boolean');
      }
      for (const [name, preset] of Object.entries(d.presets ?? {})) {
        expect(() => normalizeParams(d.id, preset), `${d.id} preset ${name}`).not.toThrow();
        expect(getParam(d, d.presetParam!).options).toContain(name);
      }
    }
  });

  it('vocab.json only names real devices, params and legal values', () => {
    for (const e of VOCAB) {
      for (const m of e.moves) {
        const p = getParam(getDevice(m.device), m.param);
        if (m.op === 'set') expect(() => coerce(p, m.value)).not.toThrow();
        else expect(typeof m.value).toBe('number');
      }
    }
  });

  it('maps knob travel along the param curve and back', () => {
    const f = getParam(getDevice('eq'), 'b3_freq'); // log 20..20000
    expect(fromNorm(f, 0.5)).toBeCloseTo(632, 0); // geometric middle
    expect(toNorm(f, 632.46)).toBeCloseTo(0.5, 3);
    const g = getParam(getDevice('eq'), 'b3_gain'); // db -24..24
    expect(fromNorm(g, 0.75)).toBeCloseTo(12, 5);
    expect(nudge(f, 1000, 3)).toBeCloseTo(1000 * 2 ** 0.999, 3); // 3 x 1/3 octave
    expect(nudge(g, 0, -1)).toBe(-2);
  });

  it('clamps to the range and to a narrower agent range', () => {
    const p = getParam(getDevice('comp'), 'ratio');
    expect(coerce(p, 50)).toEqual({ value: 20, clamped: true });
    expect(coerce(p, 50, p.agentRange)).toEqual({ value: 10, clamped: true });
    expect(coerce(getParam(getDevice('delay'), 'time_note'), '1/8d').value).toBe('1/8d');
    expect(() => coerce(getParam(getDevice('sat'), 'model'), 'valve')).toThrow(/one of/);
    expect(coerce(getParam(getDevice('pitch'), 'semis'), 3.6).value).toBe(4);
  });
});

describe('device chain ops', () => {
  const base = () => {
    const [s] = S.addTrack(S.emptySession(), 'Vox');
    return s;
  };

  it('inserts with defaults, sets, moves, bypasses and removes', () => {
    let [s, eq] = C.insertDevice(base(), 't1', 'eq');
    expect(eq.params).toEqual(defaults('eq'));
    let comp;
    [s, comp] = C.insertDevice(s, 't1', 'comp', 0, { style: 'opto' });
    expect(s.tracks[0].devices.map((d) => d.kind)).toEqual(['comp', 'eq']);
    expect(comp.params).toMatchObject({ style: 'opto', attack: 20, release: 600, detector: 'rms' });
    let ch;
    [s, ch] = C.setDeviceParam(s, 't1', eq.id, 'b3_gain', 3, { op: 'add' });
    expect(ch).toMatchObject({ value: 3, previous: 0, clamped: false });
    [s, ch] = C.setDeviceParam(s, 't1', comp.id, 'style', 'fet');
    expect(ch.also).toMatchObject({ attack: 0.3, release: 50 });
    s = C.moveDevice(s, 't1', eq.id, 0);
    s = C.setDeviceOn(s, 't1', comp.id, false);
    expect(S.describeChain(s.tracks[0])).toBe(`${eq.id} eq(b3_gain=3 dB) -> ${comp.id} comp[bypassed](style=fet, knee=2 dB, attack=0.3 ms, release=50 ms)`);
    s = C.removeDevice(s, 't1', eq.id);
    expect(s.tracks[0].devices).toHaveLength(1);
    expect(() => C.setDeviceParam(s, 't1', comp.id, 'nope', 1)).toThrow(/no param/);
    expect(() => C.insertDevice(s, 't1', 'chorus')).toThrow(/unknown device/);
  });
});

describe('fx tools', () => {
  const ctx = async (): Promise<ToolContext> => {
    const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
    await runTool(c, 'import_audio', { source_id: 's', name: 'Vox', duration: 4 }, 'user');
    c.store.takeUserEdits();
    return c;
  };

  it('are exposed to Muse', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['list_devices', 'insert_device', 'set_param', 'remove_device', 'bypass_device', 'move_device']));
  });

  it('hold Muse to the agent range and log user knob moves as hand edits', async () => {
    const c = await ctx();
    const ins = await runTool(c, 'insert_device', { track_id: 't1', device: 'comp', params: { ratio: 40 } }, 'muse');
    expect(ins).toMatchObject({ ok: true, result: { device: 'comp', clamped: ['ratio=10'] } });
    const id = (ins.result as { device_id: string }).device_id;
    const m = await runTool(c, 'set_param', { track_id: 't1', device_id: 'comp', param: 'thresh', value: -55 }, 'muse');
    expect(m).toMatchObject({ ok: true, result: { value: -40, note: expect.stringMatching(/usual range/) } });
    expect(c.store.takeUserEdits()).toEqual([]);
    const u = await runTool(c, 'set_param', { track_id: 't1', device_id: id, param: 'thresh', value: -55 }, 'user');
    expect(u).toMatchObject({ ok: true, result: { value: -55 } });
    expect(c.store.takeUserEdits()).toEqual([`set_param {"track_id":"t1","device_id":"${id}","param":"thresh","value":-55}`]);
    expect(S.summarize(c.store.get())).toContain(`fx: ${id} comp(thresh=-55 dB, ratio=10:1)`);
    const bad = await runTool(c, 'set_param', { track_id: 't1', device_id: id, param: 'detector', value: 'loud' }, 'muse');
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/one of peak, rms/) });
    const nudged = await runTool(c, 'set_param', { track_id: 't1', device_id: id, param: 'attack', value: 1, op: 'nudge' }, 'muse');
    expect((nudged.result as { value: number }).value).toBeCloseTo(10 * 2 ** 0.5, 2);
    expect((await runTool(c, 'remove_device', { track_id: 't1', device_id: id }, 'muse')).ok).toBe(true);
    expect(c.store.get().tracks[0].devices).toEqual([]);
  });

  it('list_devices describes a device for the agent', async () => {
    const r = await runTool(await ctx(), 'list_devices', { device: 'deess' }, 'muse');
    expect((r.result as { catalog: string }).catalog).toMatch(/thresh: Threshold, -60..0 dB, usual -50..-6/);
  });
});

// ------------------------------------------------------------------ Faust devices in Node
// Same processor code the AudioWorklet runs (engine/worklets.js), on the committed wasm builds.
const fxDir = path.resolve(__dirname, '../src/fx');
new Function(fs.readFileSync(path.join(fxDir, 'engine/worklets.js'), 'utf8'))();
type Dsp = { set(k: string, v: number): void; meter(k: string): number; compute(i: Float32Array[], o: Float32Array[], n: number): void };
const FaustDsp = (globalThis as unknown as { __latticeFaustDsp: new (m: WebAssembly.Module, meta: unknown, sr: number) => Dsp }).__latticeFaustDsp;
const SR = 48000;

function dsp(id: string, params: Record<string, number>): Dsp {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(fxDir, `faust/build/${id}.wasm`)));
  const meta = JSON.parse(fs.readFileSync(path.join(fxDir, `faust/build/${id}.json`), 'utf8'));
  const d = new FaustDsp(mod, meta, SR);
  for (const [k, v] of Object.entries(params)) d.set(k, v);
  return d;
}
function run(d: Dsp, x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i);
    const o = [new Float32Array(n), new Float32Array(n)];
    d.compute([x.subarray(i, i + n), x.subarray(i, i + n)], o, n);
    y.set(o[0], i);
  }
  return y;
}
const square = (dbfs: number, sec: number) => Float32Array.from({ length: SR * sec }, (_, i) => (Math.floor((i * 2000) / SR) % 2 ? -1 : 1) * 10 ** (dbfs / 20));
const dbOf = (x: number) => 20 * Math.log10(Math.abs(x));

describe('Faust devices (wasm in Node)', () => {
  it('comp follows the Giannoulis soft-knee static curve', () => {
    for (const [inDb, outDb] of [[-40, -40], [-24, -24.75], [-12, -21], [0, -18]] as const) {
      // T -24, R 4, knee 6: -24 is inside the knee -> -24 + (1/4 - 1)(3)^2 / 12 = -24.5625; use knee 0 except that point
      const knee = inDb === -24 ? 6 : 0;
      const y = run(dsp('comp', { thresh: -24, ratio: 4, knee, attack: 1, release: 50 }), square(inDb, 0.5));
      const expected = inDb === -24 ? -24 + (0.25 - 1) * 9 / 12 : outDb;
      expect(dbOf(y[y.length - 1])).toBeCloseTo(expected, 1);
    }
  });

  it('limiter never exceeds the ceiling', () => {
    const x = Float32Array.from({ length: SR }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 997 * i) / SR) + (i % 4800 === 0 ? 0.5 : 0));
    const y = run(dsp('limiter', { gain: 12, ceiling: -1, lookahead: 5 }), x);
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
  });

  it('gate closes by its range and de-esser leaves low frequencies alone', () => {
    const g = run(dsp('gate', { thresh: -40, range: -30, hold: 0, release: 10 }), square(-60, 1));
    expect(dbOf(g[g.length - 1])).toBeCloseTo(-90, 1);
    const low = Float32Array.from({ length: SR / 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR));
    const d = dsp('deess', { thresh: -30, range: 10, mode: 1 });
    const y = run(d, low);
    expect(Math.max(...y.subarray(SR / 4).map(Math.abs))).toBeCloseTo(0.5, 2);
    expect(d.meter('gr_db')).toBe(0);
  });
});
