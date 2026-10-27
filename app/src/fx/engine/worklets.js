// AudioWorklet processors for Lattice's effects (loaded as one module per AudioContext).
// Plain JS on purpose: it is imported as text (?raw) and registered from a Blob URL, and the
// vitest suite evaluates the same file with small shims to run the Faust devices in Node.
//
// lattice-faust: a minimal host for Faust modules compiled ahead of time with `-lang wasm-i`
// (internal memory). Memory layout follows @grame/faustwasm's mono DSP: DSP struct at 0,
// then the input/output pointer tables, then the audio buffers.
// lattice-crush: bit-depth reduction + sample-and-hold downsampling.

const BLOCK = 128;

function faustImports() {
  const m = Math;
  const env = {
    memoryBase: 0,
    tableBase: 0,
    _abs: m.abs,
    _acosf: m.acos, _asinf: m.asin, _atanf: m.atan, _atan2f: m.atan2, _ceilf: m.ceil, _cosf: m.cos, _expf: m.exp,
    _floorf: m.floor, _fmodf: (x, y) => x % y, _logf: m.log, _log10f: m.log10, _max_f: m.max, _min_f: m.min,
    _remainderf: (x, y) => x - m.round(x / y) * y, _powf: m.pow, _roundf: m.round, _sinf: m.sin, _sqrtf: m.sqrt,
    _tanf: m.tan, _acoshf: m.acosh, _asinhf: m.asinh, _atanhf: m.atanh, _coshf: m.cosh, _sinhf: m.sinh, _tanhf: m.tanh,
    _isnanf: Number.isNaN, _isinff: (x) => !isFinite(x), _copysignf: (x, y) => (m.sign(x) === m.sign(y) ? x : -x),
    _acos: m.acos, _asin: m.asin, _atan: m.atan, _atan2: m.atan2, _ceil: m.ceil, _cos: m.cos, _exp: m.exp,
    _floor: m.floor, _fmod: (x, y) => x % y, _log: m.log, _log10: m.log10, _max_: m.max, _min_: m.min,
    _remainder: (x, y) => x - m.round(x / y) * y, _pow: m.pow, _round: m.round, _sin: m.sin, _sqrt: m.sqrt,
    _tan: m.tan, _acosh: m.acosh, _asinh: m.asinh, _atanh: m.atanh, _cosh: m.cosh, _sinh: m.sinh, _tanh: m.tanh,
    _isnan: Number.isNaN, _isinf: (x) => !isFinite(x), _copysign: (x, y) => (m.sign(x) === m.sign(y) ? x : -x),
  };
  return { env };
}

function walkUi(items, out) {
  for (const it of items) {
    if (it.items) walkUi(it.items, out);
    else out.push(it);
  }
  return out;
}

/** A Faust wasm-i DSP instance that renders blocks of up to 128 frames. */
class FaustDsp {
  constructor(module, meta, sr) {
    const inst = new WebAssembly.Instance(module, faustImports());
    this.ex = inst.exports;
    this.nin = meta.inputs;
    this.nout = meta.outputs;
    const align = (x) => (x + 15) & ~15;
    this.insPtr = align(meta.size);
    this.outsPtr = this.insPtr + this.nin * 4;
    const bufStart = align(this.outsPtr + this.nout * 4);
    const need = bufStart + (this.nin + this.nout) * BLOCK * 4;
    const mem = this.ex.memory;
    if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
    const heap32 = new Int32Array(mem.buffer);
    this.ins = [];
    this.outs = [];
    for (let c = 0; c < this.nin; c++) {
      const p = bufStart + c * BLOCK * 4;
      heap32[(this.insPtr >> 2) + c] = p;
      this.ins.push(new Float32Array(mem.buffer, p, BLOCK));
    }
    for (let c = 0; c < this.nout; c++) {
      const p = bufStart + (this.nin + c) * BLOCK * 4;
      heap32[(this.outsPtr >> 2) + c] = p;
      this.outs.push(new Float32Array(mem.buffer, p, BLOCK));
    }
    this.ex.init(0, sr);
    this.params = {}; // short name -> byte index
    this.meters = {};
    for (const it of walkUi(meta.ui, [])) {
      const name = it.shortname || it.label;
      if (it.type === 'hbargraph' || it.type === 'vbargraph') this.meters[name] = it.index;
      else this.params[name] = it.index;
    }
  }
  set(name, value) {
    const idx = this.params[name];
    if (idx !== undefined) this.ex.setParamValue(0, idx, Number(value));
  }
  meter(name) {
    return this.ex.getParamValue(0, this.meters[name]);
  }
  /** inputs/outputs: arrays of Float32Array (channel data), n <= 128 */
  compute(inputs, outputs, n) {
    for (let c = 0; c < this.nin; c++) {
      const src = inputs[c] || inputs[0];
      if (src) this.ins[c].set(src.length === n ? src : src.subarray(0, n));
      else this.ins[c].fill(0);
    }
    this.ex.compute(0, n, this.insPtr, this.outsPtr);
    for (let c = 0; c < outputs.length; c++) outputs[c].set(this.outs[Math.min(c, this.nout - 1)].subarray(0, n));
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class LatticeFaust extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options.processorOptions;
      this.dsp = new FaustDsp(o.module, o.meta, sampleRate);
      for (const [k, v] of Object.entries(o.params || {})) this.dsp.set(k, v);
      this.meterNames = Object.keys(this.dsp.meters);
      this.meterEvery = Math.round(sampleRate * 0.05);
      this.sinceMeter = 0;
      this.alive = true;
      this.port.onmessage = (e) => {
        const d = e.data;
        if (d.set) for (const [k, v] of Object.entries(d.set)) this.dsp.set(k, v);
        if (d.dispose) this.alive = false;
      };
    }
    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out.length) return this.alive;
      this.dsp.compute(inputs[0] || [], out, out[0].length);
      if (this.meterNames.length) {
        this.sinceMeter += out[0].length;
        if (this.sinceMeter >= this.meterEvery) {
          this.sinceMeter = 0;
          const m = {};
          for (const k of this.meterNames) m[k] = this.dsp.meter(k);
          this.port.postMessage({ meters: m });
        }
      }
      return this.alive;
    }
  }
  registerProcessor('lattice-faust', LatticeFaust);

  class LatticeCrush extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'bits', defaultValue: 12, minValue: 1, maxValue: 24, automationRate: 'k-rate' },
        { name: 'downsample', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
        { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      ];
    }
    constructor() {
      super();
      this.held = [0, 0];
      this.phase = 0;
    }
    process(inputs, outputs, p) {
      const inp = inputs[0];
      const out = outputs[0];
      const bits = Math.round(p.bits[0]);
      const step = bits >= 24 ? 0 : 1 / Math.pow(2, bits - 1); // quantizer step for [-1, 1)
      const ds = Math.max(1, p.downsample[0]);
      const mix = p.mix[0];
      const n = out[0].length;
      for (let i = 0; i < n; i++) {
        this.phase += 1;
        const take = this.phase >= ds;
        if (take) this.phase -= ds;
        for (let c = 0; c < out.length; c++) {
          const x = (inp[c] || inp[0] || [])[i] || 0;
          if (take) this.held[c] = step ? Math.max(-1, Math.min(1 - step, step * Math.round(x / step))) : x;
          out[c][i] = (1 - mix) * x + mix * this.held[c];
        }
      }
      return true;
    }
  }
  registerProcessor('lattice-crush', LatticeCrush);
}

// for Node tests (the file is also evaluated outside a worklet)
if (typeof globalThis !== 'undefined') globalThis.__latticeFaustDsp = FaustDsp;
