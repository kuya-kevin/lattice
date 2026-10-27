// Small Web Audio helpers shared by the device builders. Everything takes a plain
// BaseAudioContext, so the same code runs live (AudioContext) and offline (OfflineAudioContext).
import type { ParamValues } from '../catalog';

export interface BuildEnv {
  /** project tempo (BPM) for synced times */
  tempo: number;
}

export interface DeviceNode {
  input: AudioNode;
  output: AudioNode;
  /** apply a full set of values (cheap: only AudioParams and node settings are touched) */
  update(values: ParamValues): void;
  dispose(): void;
  /** processing latency in seconds at the current settings */
  latency?: number;
  /** latest meter readings (e.g. gr_db), if the device reports any */
  meters?: Record<string, number>;
}

export type Builder = (ctx: BaseAudioContext, values: ParamValues, env: BuildEnv) => DeviceNode | Promise<DeviceNode>;

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const num = (v: unknown) => Number(v);

const isOffline = (ctx: BaseAudioContext) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

/** Set an AudioParam: smoothed (15 ms) while a live context runs, immediate otherwise. */
export function setParam(ctx: BaseAudioContext, p: AudioParam, v: number, smoothing = 0.015) {
  if (!Number.isFinite(v)) return;
  if (!isOffline(ctx) && ctx.state === 'running' && smoothing > 0) {
    p.cancelScheduledValues(ctx.currentTime);
    p.setTargetAtTime(v, ctx.currentTime, smoothing / 3);
  } else {
    p.cancelScheduledValues(0);
    p.value = v;
  }
}

/** A stereo GainNode: mono input is up-mixed to both channels. */
export function stereoGain(ctx: BaseAudioContext, gain = 1): GainNode {
  return new GainNode(ctx, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
}

export function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, Q = Math.SQRT1_2, gain = 0): BiquadFilterNode {
  return new BiquadFilterNode(ctx, { type, frequency, Q, gain, channelCount: 2, channelCountMode: 'explicit' });
}

/** Web Audio's lowpass/highpass Q is in dB (spec: Q_linear = 10^(Q/20)); bandpass/notch/peaking use linear Q. */
export const qForLpHp = (qLinear: number) => 20 * Math.log10(qLinear);

/** Q of each 2nd-order section of an order-N Butterworth (N even), lowest Q first.
 *  Q_k = 1 / (2 cos(theta_k)), theta_k = (2k - 1) pi / (2N), k = 1..N/2. */
export function butterworthQs(order: number): number[] {
  const qs: number[] = [];
  for (let k = 1; k <= order / 2; k++) qs.push(1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order))));
  return qs.sort((a, b) => a - b);
}

/** Connect a list of nodes in series; returns [first, last]. */
export function series(nodes: AudioNode[]): [AudioNode, AudioNode] {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return [nodes[0], nodes[nodes.length - 1]];
}

export function disconnectAll(nodes: (AudioNode | undefined | null)[]) {
  for (const n of nodes) {
    try {
      n?.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/** Dry/wet crossfade around an effect: input -> dry -> output, input -> [fx] -> wet -> output. */
export function dryWet(ctx: BaseAudioContext) {
  const input = stereoGain(ctx);
  const output = stereoGain(ctx);
  const dry = stereoGain(ctx, 0);
  const wet = stereoGain(ctx, 1);
  input.connect(dry).connect(output);
  wet.connect(output);
  return {
    input,
    output,
    dry,
    wet,
    setMix(mix01: number) {
      setParam(ctx, dry.gain, 1 - mix01);
      setParam(ctx, wet.gain, mix01);
    },
    nodes: [input, output, dry, wet] as AudioNode[],
  };
}

export function shaper(ctx: BaseAudioContext, curve: Float32Array, oversample: OverSampleType = '4x'): WaveShaperNode {
  return new WaveShaperNode(ctx, { curve: curve as Float32Array<ArrayBuffer>, oversample, channelCount: 2, channelCountMode: 'explicit' });
}

export function makeCurve(fn: (x: number) => number, n = 4097): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((2 * i) / (n - 1) - 1);
  return c;
}
