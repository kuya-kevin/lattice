// ChainHost: one track's insert chain as a Web Audio graph between a fixed input and output.
// The same class runs live (inside waveform-playlist's per-track effects hook) and offline
// (renderChain in an OfflineAudioContext), so there is a single DSP implementation.
// setChain() diffs against what is built: value changes call update(), structural changes
// (params flagged `rebuild`, kind, order, bypass) rebuild or rewire.
import { structureKey, type ParamValues } from '../catalog';
import { NATIVE } from './native';
import { WORKLET } from './worklet';
import { stereoGain, type Builder, type BuildEnv, type DeviceNode } from './util';

export const BUILDERS: Record<string, Builder> = { ...NATIVE, ...WORKLET };

export interface ChainDevice {
  id: string;
  kind: string;
  on: boolean;
  params: ParamValues;
}

interface Slot {
  id: string;
  kind: string;
  key: string;
  node: DeviceNode;
  values: ParamValues;
  on: boolean;
}

const sameValues = (a: ParamValues, b: ParamValues) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export class ChainHost {
  readonly input: GainNode;
  readonly output: GainNode;
  private slots: Slot[] = [];
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private taps: { analysers: AnalyserNode[]; buf: Float32Array<ArrayBuffer> } | null = null;

  constructor(readonly ctx: BaseAudioContext, private env: BuildEnv = { tempo: 120 }) {
    this.input = stereoGain(ctx);
    this.output = stereoGain(ctx);
    this.input.connect(this.output);
  }

  /** Bring the graph in line with a device list. Calls are serialized; resolves when applied. */
  setChain(devices: ChainDevice[]): Promise<void> {
    const snap = devices.map((d) => ({ ...d, params: { ...d.params } }));
    this.queue = this.queue.then(() => this.apply(snap)).catch((e) => console.error('[fx] chain update failed:', e));
    return this.queue;
  }

  setTempo(tempo: number) {
    if (tempo === this.env.tempo) return;
    this.env = { ...this.env, tempo };
    for (const s of this.slots) s.node.update(s.values);
  }

  /** Live knob drag: move one value without touching the session (no rebuild params). */
  preview(deviceId: string, param: string, value: ParamValues[string]) {
    const s = this.slots.find((s) => s.id === deviceId);
    if (!s) return;
    s.values = { ...s.values, [param]: value };
    s.node.update(s.values);
  }

  meters(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.slots.filter((s) => s.node.meters).map((s) => [s.id, { ...s.node.meters! }]));
  }

  /** Peak level of the output per channel (L, R) in dBFS over the last ~20 ms (-Infinity:
   *  silence). The meter taps are made on the first call, so offline renders never get them. */
  levels(): number[] {
    if (!this.taps) {
      const split = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
      this.output.connect(split);
      const analysers = [0, 1].map((ch) => {
        const a = new AnalyserNode(this.ctx, { fftSize: 1024 });
        split.connect(a, ch);
        return a;
      });
      this.taps = { analysers, buf: new Float32Array(1024) };
    }
    const { analysers, buf } = this.taps;
    return analysers.map((a) => {
      a.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      return 20 * Math.log10(peak);
    });
  }

  /** Total latency of the enabled devices, in seconds. */
  latency(): number {
    return this.slots.filter((s) => s.on).reduce((a, s) => a + (s.node.latency ?? 0), 0);
  }

  dispose() {
    this.disposed = true;
    this.queue.then(() => {
      for (const s of this.slots) s.node.dispose();
      this.slots = [];
      try {
        this.input.disconnect();
        this.output.disconnect();
      } catch {
        /* ignore */
      }
    });
  }

  private async apply(devices: ChainDevice[]) {
    if (this.disposed) return;
    const old = new Map(this.slots.map((s) => [s.id, s]));
    const next: Slot[] = [];
    let rewire = devices.length !== this.slots.length;
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      const builder = BUILDERS[d.kind];
      if (!builder) {
        console.warn(`[fx] no builder for "${d.kind}"; skipped`);
        rewire = true;
        continue;
      }
      const key = `${d.kind}#${structureKey(d.kind, d.params)}`;
      const prev = old.get(d.id);
      if (prev && prev.key === key) {
        if (!sameValues(prev.values, d.params)) {
          prev.node.update(d.params);
          prev.values = d.params;
        }
        if (prev.on !== d.on) {
          prev.on = d.on;
          rewire = true;
        }
        if (this.slots[i] !== prev) rewire = true;
        old.delete(d.id);
        next.push(prev);
      } else {
        const node = await builder(this.ctx, d.params, this.env);
        next.push({ id: d.id, kind: d.kind, key, node, values: d.params, on: d.on });
        rewire = true;
      }
    }
    if (this.disposed) {
      for (const s of next) if (!this.slots.includes(s)) s.node.dispose();
      return;
    }
    if (rewire) this.wire(next);
    for (const s of old.values()) s.node.dispose();
    this.slots = next;
  }

  private wire(slots: Slot[]) {
    this.input.disconnect();
    for (const s of [...this.slots, ...slots]) {
      try {
        s.node.output.disconnect();
      } catch {
        /* ignore */
      }
    }
    let last: AudioNode = this.input;
    for (const s of slots) {
      if (!s.on) continue;
      last.connect(s.node.input);
      last = s.node.output;
    }
    last.connect(this.output);
  }
}
