// Offline rendering with the live chain code: build a ChainHost in an OfflineAudioContext.
// Used by the verification harness (fxlab page, driven headless by Playwright) and as the
// render entry point for agent/sidecar renders of a track.
import { normalizeParams, type ParamValues } from '../catalog';
import type { Session } from '../../core/session';
import { ChainHost, type ChainDevice } from './host';

export interface RenderOptions {
  sampleRate?: number;
  /** seconds rendered after the input ends (reverb/delay tails) */
  tail?: number;
  tempo?: number;
}

export interface DeviceSpec {
  kind: string;
  params?: Record<string, unknown>;
  on?: boolean;
  id?: string;
}

export function toChain(devices: DeviceSpec[]): ChainDevice[] {
  return devices.map((d, i) => ({ id: d.id ?? `r${i}`, kind: d.kind, on: d.on ?? true, params: normalizeParams(d.kind, d.params ?? {}) as ParamValues }));
}

/** Render channels (1 or 2) through a device chain; returns a stereo AudioBuffer. */
export async function renderChain(channels: Float32Array[], devices: DeviceSpec[], opts: RenderOptions = {}): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48000;
  const n = channels[0]?.length ?? 0;
  const length = Math.max(1, n + Math.round((opts.tail ?? 0) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const host = new ChainHost(ctx, { tempo: opts.tempo ?? 120 });
  await host.setChain(toChain(devices));
  if (n > 0) {
    const buf = new AudioBuffer({ numberOfChannels: channels.length, length: n, sampleRate });
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(host.input);
    src.start(0);
  }
  host.output.connect(ctx.destination);
  return ctx.startRendering();
}

/** Render one track of the session (its clips, gain and insert chain) to a stereo buffer. */
export async function renderTrack(s: Session, trackId: string, buffers: Map<string, AudioBuffer>, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const t = s.tracks.find((t) => t.id === trackId);
  if (!t) throw new Error(`no track ${trackId}`);
  const sampleRate = opts.sampleRate ?? 48000;
  const end = t.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const length = Math.max(1, Math.round((end + (opts.tail ?? 2)) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const host = new ChainHost(ctx, { tempo: opts.tempo ?? s.tempo });
  await host.setChain(t.devices);
  const gain = new GainNode(ctx, { gain: Math.pow(10, t.gainDb / 20) });
  gain.connect(host.input);
  host.output.connect(ctx.destination);
  for (const c of t.clips) {
    const b = buffers.get(c.sourceId);
    if (!b) continue;
    const src = new AudioBufferSourceNode(ctx, { buffer: b });
    src.connect(gain);
    src.start(c.start, c.offset, c.duration);
  }
  return ctx.startRendering();
}

/** 32-bit float WAV (IEEE, format 3). */
export function encodeWav(buf: { numberOfChannels: number; length: number; sampleRate: number; getChannelData(c: number): Float32Array }): Uint8Array {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const bytes = new Uint8Array(44 + n * ch * 4);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n * ch * 4, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 4, true);
  dv.setUint16(32, ch * 4, true);
  dv.setUint16(34, 32, true);
  w(36, 'data');
  dv.setUint32(40, n * ch * 4, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 4) dv.setFloat32(o, data[c][i], true);
  return bytes;
}
