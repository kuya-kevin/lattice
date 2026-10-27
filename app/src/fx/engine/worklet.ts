// AudioWorklet-backed devices: Faust (comp, deess, gate, limiter, reverb), crush, pitch.
// Each AudioContext (live or offline) must load the worklet module once; WebAssembly modules
// are compiled once per page and handed to each processor in processorOptions.
import workletSource from './worklets.js?raw';
import { FAUST_WASM_BASE64 } from '../faust/build/wasm';
import compMeta from '../faust/build/comp.json';
import deessMeta from '../faust/build/deess.json';
import gateMeta from '../faust/build/gate.json';
import limiterMeta from '../faust/build/limiter.json';
import reverbMeta from '../faust/build/reverb.json';
import SignalsmithStretch, { type StretchNode } from '../vendor/signalsmith-stretch.mjs';
import { getDevice, type ParamValues } from '../catalog';
import { disconnectAll, dryWet, num, setParam, stereoGain, type Builder, type DeviceNode } from './util';

const FAUST: Record<string, { meta: any }> = {
  comp: { meta: compMeta },
  deess: { meta: deessMeta },
  gate: { meta: gateMeta },
  limiter: { meta: limiterMeta },
  reverb: { meta: reverbMeta },
};

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const modules = new Map<string, Promise<WebAssembly.Module>>();
function wasmModule(id: string): Promise<WebAssembly.Module> {
  let p = modules.get(id);
  if (!p) {
    p = WebAssembly.compile(fromBase64(FAUST_WASM_BASE64[id]));
    modules.set(id, p);
  }
  return p;
}

let workletUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
/** Load Lattice's worklet processors into a context (once per context). */
export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    workletUrl ??= URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(workletUrl);
    loaded.set(ctx, p);
  }
  return p;
}

/** Start compiling everything a context will need (call early, e.g. at app start). */
export function warmUp(ctx?: BaseAudioContext): Promise<unknown> {
  return Promise.all([...Object.keys(FAUST).map(wasmModule), ctx ? ensureWorklets(ctx) : null]);
}

/** Faust param value: enums are sent as their option index, bools as 0/1. */
function faustValues(kind: string, v: ParamValues): Record<string, number> {
  const dev = getDevice(kind);
  const out: Record<string, number> = {};
  for (const p of dev.params) {
    const x = v[p.id];
    if (x === undefined) continue;
    out[p.id] = p.type === 'enum' ? Math.max(0, (p.options ?? []).indexOf(x as never)) : p.type === 'bool' ? (x ? 1 : 0) : Number(x);
  }
  return out;
}

const faustBuilder = (kind: string): Builder => async (ctx, v) => {
  const [mod] = await Promise.all([wasmModule(kind), ensureWorklets(ctx)]);
  const node = new AudioWorkletNode(ctx, 'lattice-faust', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { module: mod, meta: FAUST[kind].meta, params: faustValues(kind, v) },
  });
  const input = stereoGain(ctx);
  input.connect(node);
  const dev: DeviceNode = {
    input,
    output: node,
    meters: {},
    latency: kind === 'limiter' ? Math.max(1, Math.round((num(v.lookahead) / 1000) * ctx.sampleRate)) / ctx.sampleRate : 0,
    update(v) {
      node.port.postMessage({ set: faustValues(kind, v) });
      if (kind === 'limiter') dev.latency = Math.max(1, Math.round((num(v.lookahead) / 1000) * ctx.sampleRate)) / ctx.sampleRate;
    },
    dispose() {
      node.port.postMessage({ dispose: true });
      disconnectAll([input, node]);
    },
  };
  node.port.onmessage = (e) => {
    if (e.data?.meters) Object.assign(dev.meters!, e.data.meters);
  };
  return dev;
};

// ---------------------------------------------------------------- crush
export const crush: Builder = async (ctx, v) => {
  await ensureWorklets(ctx);
  const node = new AudioWorkletNode(ctx, 'lattice-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  const input = stereoGain(ctx);
  input.connect(node);
  const update = (v: ParamValues) => {
    setParam(ctx, node.parameters.get('bits')!, num(v.bits), 0);
    setParam(ctx, node.parameters.get('downsample')!, num(v.downsample), 0);
    setParam(ctx, node.parameters.get('mix')!, num(v.mix) / 100);
  };
  update(v);
  return { input, output: node, update, dispose: () => disconnectAll([input, node]) };
};

// ---------------------------------------------------------------- pitch
// Signalsmith Stretch (MIT) on live input: semitones + cents, formant compensation/shift,
// tonality limit. The dry path is delayed by the stretcher's latency so Mix < 100 % lines up.
export const pitch: Builder = async (ctx, v) => {
  const dw = dryWet(ctx);
  const node: StretchNode = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  const lat = await node.latency();
  const dryDelay = new DelayNode(ctx, { maxDelayTime: 1, delayTime: Math.min(1, lat) });
  dw.input.disconnect();
  dw.input.connect(dryDelay).connect(dw.dry);
  dw.input.connect(node).connect(dw.wet);
  const schedule = (v: ParamValues) => ({
    active: true,
    semitones: num(v.semis) + num(v.cents) / 100,
    formantCompensation: Boolean(v.formant_keep),
    formantSemitones: num(v.formant),
    tonalityHz: num(v.tonality),
  });
  await node.schedule(schedule(v));
  await node.start();
  dw.setMix(num(v.mix) / 100);
  return {
    input: dw.input,
    output: dw.output,
    latency: lat,
    update(v) {
      node.schedule(schedule(v));
      dw.setMix(num(v.mix) / 100);
    },
    dispose() {
      node.stop();
      disconnectAll([...dw.nodes, node, dryDelay]);
    },
  };
};

export const WORKLET: Record<string, Builder> = {
  ...Object.fromEntries(Object.keys(FAUST).map((k) => [k, faustBuilder(k)])),
  crush,
  pitch,
};
