// Native Web Audio device builders: utility, eq, sat, filter, delay, mod.
// Graph code only; DSP is the browser's (BiquadFilter = RBJ cookbook, WaveShaper, Delay).
import { NOTE_BEATS, type ParamValues } from '../catalog';
import {
  biquad, butterworthQs, dbToGain, disconnectAll, dryWet, makeCurve, num, qForLpHp, setParam, shaper, stereoGain,
  type Builder, type DeviceNode,
} from './util';

// ---------------------------------------------------------------- utility
// M/S width, phase flips and swap fold into one 2x2 matrix (4 gains); then gain and pan.
// Mono-below: Linkwitz-Riley LR4 crossover (two cascaded Butterworth 2nd-order sections),
// low band summed to mono. LR4 low + high sums to an allpass, so the split is flat.
export const utility: Builder = (ctx, v) => {
  const input = stereoGain(ctx);
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  const m = { ll: new GainNode(ctx), rl: new GainNode(ctx), lr: new GainNode(ctx), rr: new GainNode(ctx) };
  input.connect(split);
  split.connect(m.ll, 0).connect(merge, 0, 0);
  split.connect(m.rl, 1).connect(merge, 0, 0);
  split.connect(m.lr, 0).connect(merge, 0, 1);
  split.connect(m.rr, 1).connect(merge, 0, 1);
  // crossover after the matrix
  const direct = stereoGain(ctx);
  const lo1 = biquad(ctx, 'lowpass', 20, qForLpHp(Math.SQRT1_2));
  const lo2 = biquad(ctx, 'lowpass', 20, qForLpHp(Math.SQRT1_2));
  const hi1 = biquad(ctx, 'highpass', 20, qForLpHp(Math.SQRT1_2));
  const hi2 = biquad(ctx, 'highpass', 20, qForLpHp(Math.SQRT1_2));
  // 1-channel node: the speakers down-mix gives 0.5 * (L + R); the stereo node after it copies it to both sides
  const loMono = new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const xoverOut = stereoGain(ctx, 0);
  merge.connect(direct);
  merge.connect(lo1).connect(lo2).connect(loMono).connect(xoverOut);
  merge.connect(hi1).connect(hi2).connect(xoverOut);
  const gain = stereoGain(ctx);
  const pan = new StereoPannerNode(ctx, { pan: 0 });
  direct.connect(gain);
  xoverOut.connect(gain);
  gain.connect(pan);

  const update = (v: ParamValues) => {
    const w = num(v.width) / 100;
    const sl = v.phase_l ? -1 : 1;
    const sr = v.phase_r ? -1 : 1;
    // L' = a*L + b*R, R' = b*L + a*R with a = (1+w)/2, b = (1-w)/2 (M/S width)
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    let [ll, rl, lr, rr] = [a * sl, b * sr, b * sl, a * sr];
    if (v.swap) [ll, rl, lr, rr] = [lr, rr, ll, rl];
    setParam(ctx, m.ll.gain, ll);
    setParam(ctx, m.rl.gain, rl);
    setParam(ctx, m.lr.gain, lr);
    setParam(ctx, m.rr.gain, rr);
    const f = num(v.mono_below);
    const on = f > 20.5;
    for (const n of [lo1, lo2, hi1, hi2]) setParam(ctx, n.frequency, f);
    setParam(ctx, direct.gain, on ? 0 : 1);
    setParam(ctx, xoverOut.gain, on ? 1 : 0);
    setParam(ctx, gain.gain, dbToGain(num(v.gain)));
    setParam(ctx, pan.pan, num(v.pan));
  };
  update(v);
  const all = [input, split, merge, m.ll, m.rl, m.lr, m.rr, direct, lo1, lo2, hi1, hi2, loMono, xoverOut, gain, pan];
  return { input, output: pan, update, dispose: () => disconnectAll(all) };
};

// ---------------------------------------------------------------- eq
// 8 bands like Logic's Channel EQ: Butterworth low/high cut (12-48 dB/oct as cascaded
// 2nd-order sections), low/high shelf (RBJ, S = 1), four RBJ peaking bells.
export const eq: Builder = (ctx, v) => {
  const input = stereoGain(ctx);
  const output = stereoGain(ctx);
  const hpOrder = v.hp_on ? num(v.hp_slope) / 6 : 0;
  const lpOrder = v.lp_on ? num(v.lp_slope) / 6 : 0;
  const hp = butterworthQs(hpOrder).map((q) => biquad(ctx, 'highpass', num(v.hp_freq), qForLpHp(q)));
  const lp = butterworthQs(lpOrder).map((q) => biquad(ctx, 'lowpass', num(v.lp_freq), qForLpHp(q)));
  const ls = biquad(ctx, 'lowshelf', 100);
  const hs = biquad(ctx, 'highshelf', 10000);
  const bells = [1, 2, 3, 4].map(() => biquad(ctx, 'peaking', 1000));
  const chain: AudioNode[] = [input, ...hp, ls, ...bells, hs, ...lp, output];
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  const update = (v: ParamValues) => {
    for (const n of hp) setParam(ctx, n.frequency, num(v.hp_freq));
    for (const n of lp) setParam(ctx, n.frequency, num(v.lp_freq));
    setParam(ctx, ls.frequency, num(v.ls_freq));
    setParam(ctx, ls.gain, num(v.ls_gain));
    setParam(ctx, hs.frequency, num(v.hs_freq));
    setParam(ctx, hs.gain, num(v.hs_gain));
    bells.forEach((b, i) => {
      setParam(ctx, b.frequency, num(v[`b${i + 1}_freq`]));
      setParam(ctx, b.gain, num(v[`b${i + 1}_gain`]));
      setParam(ctx, b.Q, num(v[`b${i + 1}_q`]));
    });
    setParam(ctx, output.gain, dbToGain(num(v.out)));
  };
  update(v);
  return { input, output, update, dispose: () => disconnectAll(chain) };
};

// ---------------------------------------------------------------- sat
// Static waveshaper families (Zolzer DAFX ch. 4; Pirkle, Designing Audio Effect Plugins, ch. 19):
// tape = tanh, tube = asymmetric tanh (even harmonics), transistor = cubic soft clip with a hard
// knee, fuzz = sine wavefolder. Drive is folded into the curve (the curve domain is [-1, 1]),
// the shaper runs 4x oversampled, and auto gain matches a -12 dBFS sine's RMS.
export type SatModel = 'tape' | 'tube' | 'transistor' | 'fuzz';
export function satFn(model: SatModel): (u: number) => number {
  switch (model) {
    case 'tube':
      return (u) => (u >= 0 ? Math.tanh(u) : 1.5 * Math.tanh(u / 1.5));
    case 'transistor':
      return (u) => (Math.abs(u) >= 1 ? Math.sign(u) : 1.5 * (u - (u * u * u) / 3));
    case 'fuzz':
      return (u) => Math.sin((Math.PI / 2) * u);
    default:
      return Math.tanh;
  }
}

export function satCurve(model: SatModel, driveDb: number, bias: number): { curve: Float32Array; makeup: number } {
  const f = satFn(model);
  const g = dbToGain(driveDb);
  const b = bias * 0.5;
  const fb = f(b);
  const curve = makeCurve((x) => f(g * x + b) - fb, 8193);
  // auto gain: RMS of a -12 dBFS sine in vs out (DC removed, as the DC blocker will)
  const N = 512;
  let si = 0;
  let mean = 0;
  const ys: number[] = [];
  for (let i = 0; i < N; i++) {
    const x = 0.25 * Math.sin((2 * Math.PI * i) / N);
    si += x * x;
    const y = f(g * x + b) - fb;
    ys.push(y);
    mean += y / N;
  }
  const so = ys.reduce((a, y) => a + (y - mean) * (y - mean), 0);
  return { curve, makeup: so > 0 ? Math.sqrt(si / so) : 1 };
}

/** Latency of the browser's 4x oversampled WaveShaper, measured once per sample rate. */
const SHAPER_LATENCY_FRAMES: Record<number, number> = {};
export const setShaperLatency = (sr: number, frames: number) => (SHAPER_LATENCY_FRAMES[sr] = frames);

export const sat: Builder = (ctx, v) => {
  const dw = dryWet(ctx);
  const prehp = biquad(ctx, 'highpass', 20, qForLpHp(Math.SQRT1_2));
  const sh = shaper(ctx, new Float32Array([-1, 1]), '4x');
  const dc = biquad(ctx, 'highpass', 8, qForLpHp(Math.SQRT1_2));
  const tone = biquad(ctx, 'lowpass', 12000, qForLpHp(Math.SQRT1_2));
  const comp = stereoGain(ctx);
  const out = stereoGain(ctx);
  // dry path aligned with the oversampler's latency so Mix < 100 % does not comb-filter
  const dryDelay = new DelayNode(ctx, { maxDelayTime: 0.01, delayTime: (SHAPER_LATENCY_FRAMES[ctx.sampleRate] ?? 0) / ctx.sampleRate, channelCount: 2, channelCountMode: 'explicit' });
  dw.input.disconnect();
  dw.input.connect(dryDelay).connect(dw.dry);
  dw.input.connect(prehp).connect(sh).connect(dc).connect(tone).connect(comp).connect(dw.wet);
  dw.output.connect(out);
  let key = '';
  const update = (v: ParamValues) => {
    const k = `${v.model}|${v.drive}|${v.bias}`;
    const c = satCurve(v.model as SatModel, num(v.drive), num(v.bias));
    if (k !== key) {
      sh.curve = c.curve as Float32Array<ArrayBuffer>;
      key = k;
    }
    setParam(ctx, prehp.frequency, num(v.low_cut));
    setParam(ctx, tone.frequency, Math.min(num(v.tone), ctx.sampleRate * 0.49));
    setParam(ctx, comp.gain, v.auto_gain ? c.makeup : 1);
    dw.setMix(num(v.mix) / 100);
    setParam(ctx, out.gain, dbToGain(num(v.out)));
  };
  update(v);
  return { input: dw.input, output: out, update, dispose: () => disconnectAll([...dw.nodes, prehp, sh, dc, tone, comp, out, dryDelay]) };
};

// ---------------------------------------------------------------- filter
// Cascaded biquads (order = slope / 6). At reso = 0.7071 the low/high-pass cascade is an exact
// Butterworth; resonance scales the highest-Q section. The LFO and the envelope follower move
// every section's `detune` (cents), so modulation is exponential (in octaves) as on AutoFilter.
export const filter: Builder = (ctx, v) => {
  const dw = dryWet(ctx);
  const type = v.type as BiquadFilterType;
  const order = num(v.slope) / 6;
  const qs = type === 'lowpass' || type === 'highpass' ? butterworthQs(order) : new Array(order / 2).fill(1);
  const secs = qs.map(() => biquad(ctx, type, 1000));
  let last: AudioNode = dw.input;
  for (const s of secs) last = last.connect(s);
  last.connect(dw.wet);
  // LFO (octaves -> cents)
  const lfoDepth = new GainNode(ctx, { gain: 0 });
  let lfo: AudioScheduledSourceNode;
  let lfoRate: AudioParam;
  const shape = String(v.lfo_shape);
  if (shape === 'random') {
    // stepped random: 64 random steps in a looped buffer, playbackRate sets the step rate
    const steps = 64;
    const buf = new AudioBuffer({ length: steps * 64, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
    const d = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < steps; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d.fill((seed / 0x7fffffff) * 2 - 1, i * 64, (i + 1) * 64);
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
    lfo = src;
    lfoRate = src.playbackRate; // 1 step per (64 / sr) s at rate 1
  } else {
    const osc = new OscillatorNode(ctx, { type: shape === 'saw' ? 'sawtooth' : (shape as OscillatorType), frequency: 1 });
    lfo = osc;
    lfoRate = osc.frequency;
  }
  lfo.connect(lfoDepth);
  // envelope follower: |x| (waveshaper) -> 10 Hz low-pass -> gain (octaves at full scale)
  const rect = shaper(ctx, makeCurve((x) => Math.abs(x), 1025), 'none');
  const rectMono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
  const envLp = biquad(ctx, 'lowpass', 10, qForLpHp(Math.SQRT1_2));
  const envDepth = new GainNode(ctx, { gain: 0 });
  dw.input.connect(rect).connect(rectMono).connect(envLp).connect(envDepth);
  for (const s of secs) {
    lfoDepth.connect(s.detune);
    envDepth.connect(s.detune);
  }
  lfo.start();
  const update = (v: ParamValues) => {
    const reso = num(v.reso);
    secs.forEach((s, i) => {
      setParam(ctx, s.frequency, Math.min(num(v.cutoff), ctx.sampleRate * 0.49));
      const isTop = i === secs.length - 1;
      const q = isTop ? qs[i] * (reso / Math.SQRT1_2) : qs[i];
      setParam(ctx, s.Q, type === 'lowpass' || type === 'highpass' ? qForLpHp(q) : isTop ? reso : q);
    });
    const rate = num(v.lfo_rate);
    setParam(ctx, lfoRate, shape === 'random' ? (rate * 64) / ctx.sampleRate : rate);
    setParam(ctx, lfoDepth.gain, num(v.lfo_depth) * 1200);
    // full-scale sine has mean |x| = 2/pi; scale so a full-scale signal moves env_amt octaves
    setParam(ctx, envDepth.gain, num(v.env_amt) * 1200 * (Math.PI / 2));
    dw.setMix(num(v.mix) / 100);
  };
  update(v);
  return {
    input: dw.input,
    output: dw.output,
    update,
    dispose: () => {
      try {
        lfo.stop();
      } catch {
        /* not started */
      }
      disconnectAll([...dw.nodes, ...secs, lfo, lfoDepth, rect, rectMono, envLp, envDepth]);
    },
  };
};

// ---------------------------------------------------------------- delay
// Stereo tape-style delay. Per side: input -> main delay T -> [x0.5, high-pass, low-pass, soft
// clipper] -> echo out; echo -> feedback gain -> loop delay -> back into the filters. The soft
// clipper is always present (linear below 0 dBFS) so feedback > 100 % stays bounded; Tape
// Saturation drives it harder. Ping-pong routes each side's echo into the other side's loop.
// Browsers add one render quantum (128 frames) to every cycle, so the loop delay is shortened by
// the measured amount and echoes land exactly at T, 2T, 3T. Wow/flutter: 0.5 Hz + 6 Hz on delayTime.
// Spacing and feedback: J.O. Smith, PASP, "Feedback Comb Filters"; Zolzer DAFX ch. 2.
const cycleExtra = new Map<number, Promise<number>>();
/** Extra frames a feedback cycle adds in this browser (Chromium: 128), measured once per rate. */
export function cycleExtraFrames(sampleRate: number): Promise<number> {
  let p = cycleExtra.get(sampleRate);
  if (!p) {
    p = (async () => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 4096, sampleRate });
      const b = new AudioBuffer({ length: 1, sampleRate, numberOfChannels: 1 });
      b.getChannelData(0)[0] = 1;
      const src = new AudioBufferSourceNode(ctx, { buffer: b });
      const sum = new GainNode(ctx);
      const d = new DelayNode(ctx, { maxDelayTime: 1, delayTime: 512 / sampleRate });
      const fb = new GainNode(ctx, { gain: 0.5 });
      src.connect(sum).connect(d).connect(ctx.destination);
      d.connect(fb).connect(sum);
      src.start();
      const y = (await ctx.startRendering()).getChannelData(0);
      const peaks: number[] = [];
      for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 0.1) peaks.push(i);
      return peaks.length > 1 ? Math.max(0, peaks[1] - 2 * peaks[0]) : 0;
    })();
    cycleExtra.set(sampleRate, p);
  }
  return p;
}

export const delay: Builder = async (ctx, v, env) => {
  const extra = (await cycleExtraFrames(ctx.sampleRate)) / ctx.sampleRate;
  const dw = dryWet(ctx);
  const ping = Boolean(v.pingpong);
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  const mono = { channelCount: 1, channelCountMode: 'explicit' as const };
  const mk = () => {
    const s = {
      main: new DelayNode(ctx, { maxDelayTime: 2.1, delayTime: 0.375, ...mono }),
      loop: new DelayNode(ctx, { maxDelayTime: 2.1, delayTime: 0.375, ...mono }),
      sum: new GainNode(ctx, { gain: 0.5, ...mono }), // the soft clipper sees half scale
      hp: biquad(ctx, 'highpass', 150, qForLpHp(Math.SQRT1_2)),
      lp: biquad(ctx, 'lowpass', 6000, qForLpHp(Math.SQRT1_2)),
      sh: shaper(ctx, new Float32Array([-1, 1]), 'none'),
      fb: new GainNode(ctx, { gain: 0.35, ...mono }),
    };
    for (const n of [s.hp, s.lp, s.sh]) Object.assign(n, mono);
    s.main.connect(s.sum);
    s.loop.connect(s.sum);
    s.sum.connect(s.hp).connect(s.lp).connect(s.sh).connect(s.fb);
    return s;
  };
  const L = mk();
  const R = mk();
  dw.input.connect(split);
  if (ping) {
    const monoIn = new GainNode(ctx, { gain: 0.5, ...mono });
    split.connect(monoIn, 0);
    split.connect(monoIn, 1);
    monoIn.connect(L.main);
    L.fb.connect(R.loop); // L echo feeds R
    R.fb.connect(L.loop); // R echo feeds L
  } else {
    split.connect(L.main, 0);
    split.connect(R.main, 1);
    L.fb.connect(L.loop);
    R.fb.connect(R.loop);
  }
  L.sh.connect(merge, 0, 0);
  R.sh.connect(merge, 0, 1);
  merge.connect(dw.wet);
  // wow & flutter
  const wow = new OscillatorNode(ctx, { frequency: 0.5 });
  const flutter = new OscillatorNode(ctx, { frequency: 6 });
  const wowG = new GainNode(ctx, { gain: 0 });
  const flutG = new GainNode(ctx, { gain: 0 });
  wow.connect(wowG);
  flutter.connect(flutG);
  for (const s of [L, R]) {
    for (const d of [s.main, s.loop]) {
      wowG.connect(d.delayTime);
      flutG.connect(d.delayTime);
    }
  }
  wow.start();
  flutter.start();
  let satKey = -1;
  const update = (v: ParamValues) => {
    const t = v.sync ? (NOTE_BEATS[String(v.time_note)] ?? 0.5) * (60 / env.tempo) : num(v.time_ms) / 1000;
    const time = Math.min(2, Math.max(1 / ctx.sampleRate, t));
    const spread = ping ? 0 : (num(v.width) / 100) * 0.015;
    const tR = Math.min(2.09, time + spread);
    setParam(ctx, L.main.delayTime, time, 0.05);
    setParam(ctx, R.main.delayTime, tR, 0.05);
    // ping-pong: R's loop carries L's echo (time T), L's loop carries R's echo (also T)
    setParam(ctx, L.loop.delayTime, Math.max(0, time - extra), 0.05);
    setParam(ctx, R.loop.delayTime, Math.max(0, (ping ? time : tR) - extra), 0.05);
    const fb = num(v.feedback) / 100;
    for (const s of [L, R]) {
      setParam(ctx, s.fb.gain, fb); // loop gain: fb x 0.5 (sum) x 2 (clipper curve) = fb
      setParam(ctx, s.hp.frequency, num(v.low_cut));
      setParam(ctx, s.lp.frequency, Math.min(num(v.high_cut), ctx.sampleRate * 0.49));
    }
    const satAmt = num(v.sat) / 100;
    if (satAmt !== satKey) {
      satKey = satAmt;
      // The clipper sees half scale (curve domain [-1, 1] covers +-2 full scale) and gives full scale back.
      // sat = 0: linear up to full scale, soft clip above. sat > 0: tanh(g x) / g, clipping at 1/g (g up to +18 dB).
      const g = dbToGain(18 * satAmt);
      const c = satAmt === 0
        ? makeCurve((x) => { const u = 2 * x; return Math.abs(u) <= 1 ? u : Math.sign(u) * (1 + Math.tanh(Math.abs(u) - 1)); }, 4097)
        : makeCurve((x) => Math.tanh(2 * g * x) / g, 4097);
      L.sh.curve = c as Float32Array<ArrayBuffer>;
      R.sh.curve = c as Float32Array<ArrayBuffer>;
    }
    const w = num(v.wow) / 100;
    setParam(ctx, wowG.gain, w * 0.003);
    setParam(ctx, flutG.gain, w * 0.0004);
    dw.setMix(num(v.mix) / 100);
  };
  update(v);
  return {
    input: dw.input,
    output: dw.output,
    update,
    dispose: () => {
      wow.stop();
      flutter.stop();
      disconnectAll([...dw.nodes, split, merge, wow, flutter, wowG, flutG, ...[L, R].flatMap((s) => [s.main, s.loop, s.sum, s.hp, s.lp, s.sh, s.fb])]);
    },
  };
};

// ---------------------------------------------------------------- mod
// chorus / flanger: LFO-modulated delay with feedback (Zolzer DAFX ch. 2; Dattorro 1997,
// "Effect Design Part 2: Delay-Line Modulation and Chorus", JAES 45(10)). Right LFO is offset by
// `spread` degrees (PeriodicWave phase). phaser: stages/2 second-order allpass sections swept
// exponentially via detune (feedback is not available in v1: a native feedback loop would add
// a 128-frame delay).
function phasedSine(ctx: BaseAudioContext, deg: number): PeriodicWave {
  const ph = (deg * Math.PI) / 180;
  // sin(wt + ph) = sin(ph) cos(wt) + cos(ph) sin(wt)
  return new PeriodicWave(ctx, { real: [0, Math.sin(ph)], imag: [0, Math.cos(ph)], disableNormalization: true });
}

export const mod: Builder = (ctx, v) => {
  const dw = dryWet(ctx);
  const mode = String(v.mode);
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  dw.input.connect(split);
  merge.connect(dw.wet);
  const oscL = new OscillatorNode(ctx, { frequency: 0.8 });
  const oscR = new OscillatorNode(ctx, { frequency: 0.8 });
  oscR.setPeriodicWave(phasedSine(ctx, num(v.spread)));
  const extra: AudioNode[] = [];
  const perSide: { depth: GainNode; delay?: DelayNode; fb?: GainNode; aps?: BiquadFilterNode[] }[] = [];
  for (const [ch, osc] of [[0, oscL], [1, oscR]] as const) {
    const depth = new GainNode(ctx, { gain: 0 });
    osc.connect(depth);
    if (mode === 'phaser') {
      const n = Math.max(1, Math.round(num(v.stages) / 2));
      const aps = Array.from({ length: n }, () => {
        const a = new BiquadFilterNode(ctx, { type: 'allpass', frequency: 800, Q: 0.5, channelCount: 1, channelCountMode: 'explicit' });
        depth.connect(a.detune);
        return a;
      });
      let last: AudioNode = split;
      aps.forEach((a, i) => {
        if (i === 0) split.connect(a, ch);
        else last.connect(a);
        last = a;
      });
      last.connect(merge, 0, ch);
      perSide.push({ depth, aps });
      extra.push(...aps);
    } else {
      const delay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: 0.007, channelCount: 1, channelCountMode: 'explicit' });
      const fb = new GainNode(ctx, { gain: 0 });
      split.connect(delay, ch);
      delay.connect(fb).connect(delay);
      delay.connect(merge, 0, ch);
      depth.connect(delay.delayTime);
      perSide.push({ depth, delay, fb });
      extra.push(delay, fb);
    }
    extra.push(depth);
  }
  oscL.start();
  oscR.start();
  const update = (v: ParamValues) => {
    const depth = num(v.depth) / 100;
    for (const o of [oscL, oscR]) setParam(ctx, o.frequency, num(v.rate));
    for (const s of perSide) {
      if (s.delay) {
        const base = num(v.delay) / 1000;
        setParam(ctx, s.delay.delayTime, base);
        // sweep +-depth * base (never below 0.1 ms)
        setParam(ctx, s.depth.gain, Math.max(0, Math.min(depth * base, base - 0.0001)));
        setParam(ctx, s.fb!.gain, num(v.feedback) / 100);
      } else {
        // phaser: centre 800 Hz, sweep +-3 octaves * depth
        setParam(ctx, s.depth.gain, depth * 3 * 1200);
      }
    }
    dw.setMix(num(v.mix) / 100);
  };
  update(v);
  return {
    input: dw.input,
    output: dw.output,
    update,
    dispose: () => {
      oscL.stop();
      oscR.stop();
      disconnectAll([...dw.nodes, split, merge, oscL, oscR, ...extra]);
    },
  };
};

export const NATIVE: Record<string, Builder> = { utility, eq, sat, filter, delay, mod };
export type { DeviceNode };
