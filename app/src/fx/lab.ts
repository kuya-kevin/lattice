// Dev-only page (fxlab.html): exposes the offline renderer to Playwright. Audio crosses the
// page boundary as base64 float32 (little-endian) so large buffers stay cheap to pass.
import { renderChain, type DeviceSpec } from './engine/render';
import { setShaperLatency } from './engine/native';

const toF32 = (b64: string) => {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
};
const fromF32 = (f: Float32Array) => {
  const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Measure the 4x WaveShaper latency (Chromium's oversampler) with an impulse, in frames. */
async function measureShaperLatency(sampleRate: number): Promise<number> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1024, sampleRate });
  const b = new AudioBuffer({ length: 1024, sampleRate, numberOfChannels: 1 });
  b.getChannelData(0)[0] = 0.5;
  const src = new AudioBufferSourceNode(ctx, { buffer: b });
  const sh = new WaveShaperNode(ctx, { curve: new Float32Array([-1, 1]), oversample: '4x' });
  src.connect(sh).connect(ctx.destination);
  src.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  let best = 0;
  for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[best])) best = i;
  return best;
}

const lab = {
  async render(req: { channels: string[]; devices: DeviceSpec[]; sampleRate?: number; tail?: number; tempo?: number }) {
    const sr = req.sampleRate ?? 48000;
    setShaperLatency(sr, await measureShaperLatency(sr));
    const t0 = performance.now();
    const out = await renderChain(req.channels.map(toF32), req.devices, { sampleRate: sr, tail: req.tail, tempo: req.tempo });
    return { channels: [0, 1].map((c) => fromF32(out.getChannelData(c))), sampleRate: out.sampleRate, ms: performance.now() - t0 };
  },
  measureShaperLatency,
};

declare global {
  interface Window {
    fxLab?: typeof lab;
  }
}
window.fxLab = lab;
document.body.dataset.ready = '1';
