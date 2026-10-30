// B18 dry / wet mix, and the render jobs B17 and B18 share. Pure: no DOM, no audio context.
//
// Dry listening bypasses every effect device on every track without changing the session's
// devices: the engine is fed a "heard" copy of the session in which each track keeps only its
// gain and pan (the Utility device's Gain and Pan), plus a loudness-matching gain so the louder
// (usually wet) mix doesn't win the comparison.
import { normalizeParams } from '../fx/catalog';
import type { DeviceInstance, Session, Track } from './session';

export type MixMode = 'dry' | 'wet';

export interface MixView {
  mode: MixMode;
  matchLoudness: boolean;
  /** gain on every track's dry path, from matching the dry mix's loudness to the wet mix's */
  dryGainDb: number;
}

export const DRY_GAIN_ID = 'mix-dry-gain';

/** A track's chain as heard in dry mode: Utility devices keep only Gain and Pan (the balance),
 *  every other device is left out; `gainDb` adds a matching gain at the end. */
export function dryDevices(t: Track, gainDb = 0): DeviceInstance[] {
  const keep = (t.devices ?? [])
    .filter((d) => d.kind === 'utility' && d.on)
    .map((d) => ({ ...d, params: normalizeParams('utility', { gain: d.params.gain, pan: d.params.pan }) }));
  if (Math.abs(gainDb) < 0.05) return keep;
  return [...keep, { id: DRY_GAIN_ID, kind: 'utility', on: true, params: normalizeParams('utility', { gain: Math.max(-48, Math.min(24, gainDb)) }) }];
}

/** The session with every track's effects bypassed (gain and pan kept). */
export function drySession(s: Session, gainDb = 0): Session {
  return { ...s, tracks: s.tracks.map((t) => ({ ...t, devices: dryDevices(t, gainDb) })) };
}

/** What the engine should play: the session itself, or its dry copy in dry mode. */
export function heardSession(s: Session): Session {
  return s.mixView?.mode === 'dry' ? drySession(s, s.mixView.matchLoudness ? s.mixView.dryGainDb : 0) : s;
}

/** One line for Muse's session summary, only while listening dry. */
export function mixViewLine(s: Session): string {
  const v = s.mixView;
  if (v?.mode !== 'dry') return '';
  const match = v.matchLoudness ? `, loudness-matched (${v.dryGainDb >= 0 ? '+' : ''}${v.dryGainDb} dB on the dry mix)` : '';
  return `Listening: DRY, every effect bypassed for an A/B${match}; the devices are unchanged. set_mix_view wet brings the effects back.`;
}

// ---- render jobs: the renderer holds the audio, so tools ask it to render (as measure_track does) ----

export type RenderJob =
  /** a session sound (Ideas, a pad, a recording) as a WAV */
  | { kind: 'source'; sourceId: string }
  /** a track, or some of its regions, through its effects: the WAV with the effect tail and no
   *  trailing silence, and the same audio before the effects (the recipe's source) */
  | { kind: 'sound'; trackId: string; clipIds?: string[] }
  /** one WAV per track, from the session start; dry = effects bypassed (gain and pan kept) */
  | { kind: 'stems'; set: MixMode }
  /** loudness of the mix as heard, with and without effects */
  | { kind: 'loudness' };

export interface RenderOut {
  source: { wav: Uint8Array; duration: number; sampleRate: number };
  sound: { wav: Uint8Array; dry: Uint8Array; duration: number; dryDuration: number; tail: number; sampleRate: number };
  stems: { stems: { trackId: string; name: string; wav: Uint8Array }[]; duration: number; sampleRate: number };
  loudness: { wetDb: number; dryDb: number };
}

export type Render = <J extends RenderJob>(s: Session, job: J) => Promise<RenderOut[J['kind']]>;

// ---- signal helpers (shared by the renderer's render jobs and tests) ----

/** Index just past the last sample louder than `floorDb` in any channel (0 if all silent). */
export function audibleEnd(channels: Float32Array[], floorDb = -70): number {
  const floor = Math.pow(10, floorDb / 20);
  let end = 0;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= end; i--) {
      if (Math.abs(ch[i]) > floor) {
        end = i + 1;
        break;
      }
    }
  }
  return end;
}

/** Copies of `channels` cut after the last audible sample (plus `padS`), with a short fade. */
export function trimTrailingSilence(channels: Float32Array[], sampleRate: number, opts: { floorDb?: number; padS?: number; fadeS?: number } = {}): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const end = Math.min(n, audibleEnd(channels, opts.floorDb) + Math.round((opts.padS ?? 0.02) * sampleRate));
  const fade = Math.min(end, Math.round((opts.fadeS ?? 0.01) * sampleRate));
  return channels.map((ch) => {
    const out = ch.slice(0, Math.max(1, end));
    for (let i = 0; i < fade; i++) out[end - 1 - i] *= i / fade;
    return out;
  });
}

/** Gated RMS loudness in dBFS: 400 ms blocks quieter than -60 dBFS are left out (so silence
 *  between parts doesn't drag the figure down), as integrated loudness meters gate. */
export function gatedRmsDb(channels: Float32Array[], sampleRate: number): number {
  const n = channels[0]?.length ?? 0;
  const block = Math.max(1, Math.round(0.4 * sampleRate));
  const gate = Math.pow(10, -60 / 10);
  let sum = 0;
  let count = 0;
  for (let a = 0; a < n; a += block) {
    const b = Math.min(n, a + block);
    let e = 0;
    for (const ch of channels) for (let i = a; i < b; i++) e += ch[i] * ch[i];
    const ms = e / ((b - a) * channels.length);
    if (ms < gate) continue;
    sum += e;
    count += (b - a) * channels.length;
  }
  return count ? Math.round(10 * Math.log10(sum / count) * 10) / 10 : -Infinity;
}

/** The gain (dB) that brings the dry mix to the wet mix's loudness; 0 if either is silent. */
export function matchingGainDb(l: { wetDb: number; dryDb: number }): number {
  if (!Number.isFinite(l.wetDb) || !Number.isFinite(l.dryDb)) return 0;
  return Math.round(Math.max(-24, Math.min(24, l.wetDb - l.dryDb)) * 10) / 10;
}

/** File-safe track name for a stem, numbered in track order: "01 Lead Vox". */
export function stemName(index: number, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'Track';
  return `${String(index + 1).padStart(2, '0')} ${safe}`;
}
