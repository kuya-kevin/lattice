// B17/B18: the renderer's half of export_sound, star_sound, export_stems and set_mix_view. It
// holds the audio, so the tools ask it to render (as measure_track does, renderer/ears.ts).
import { useEffect } from 'react';
import type { Bridge } from '../core/bridge';
import { drySession, gatedRmsDb, trimTrailingSilence, type RenderJob, type RenderOut } from '../core/mixView';
import { sessionEnd, type Session } from '../core/session';
import { encodeWav, renderTrack } from '../fx/engine/render';
import { buffers } from './audio';

/** Seconds rendered past the last region, for reverb and delay tails (trimmed afterwards). */
const TAIL_S = 8;

const bufferId = (c: Session['tracks'][number]['clips'][number]) => (c.midi ? `midi:${c.id}` : c.sourceId);

/** Render at the rate the audio was decoded at, so a dry render is the audio sample for sample. */
function rateOf(s: Session, trackIds?: string[]): number {
  for (const t of s.tracks) {
    if (trackIds && !trackIds.includes(t.id)) continue;
    for (const c of t.clips) {
      const b = buffers.get(bufferId(c));
      if (b) return b.sampleRate;
    }
  }
  return 48000;
}

function checkLoaded(s: Session, trackIds: string[]) {
  for (const id of trackIds) {
    const t = s.tracks.find((x) => x.id === id);
    if (!t) throw new Error(`no track ${id}`);
    const missing = t.clips.filter((c) => !buffers.has(bufferId(c)));
    if (missing.length) throw new Error(`the audio of ${missing.map((c) => c.id).join(', ')} on ${t.id} is not loaded yet`);
  }
}

const channels = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
const asBuffer = (chs: Float32Array[], sampleRate: number) => ({ numberOfChannels: chs.length, length: chs[0]?.length ?? 0, sampleRate, getChannelData: (i: number) => chs[i] });
const fit = (chs: Float32Array[], n: number) => chs.map((c) => { const o = new Float32Array(n); o.set(c.subarray(0, n)); return o; });

/** A session holding just one track's chosen regions, moved so the first starts at 0. */
function soloRegions(s: Session, trackId: string, clipIds?: string[]): Session {
  const t = s.tracks.find((x) => x.id === trackId)!;
  const clips = clipIds ? t.clips.filter((c) => clipIds.includes(c.id)) : t.clips;
  if (!clips.length) throw new Error(`no regions to render on ${trackId}`);
  const t0 = Math.min(...clips.map((c) => c.start));
  return { ...s, tracks: [{ ...t, muted: false, soloed: false, clips: clips.map((c) => ({ ...c, start: c.start - t0 })) }] };
}

export async function renderJob<J extends RenderJob>(s: Session, job: J): Promise<RenderOut[J['kind']]> {
  type Out = RenderOut[J['kind']];
  if (job.kind === 'source') {
    const b = buffers.get(job.sourceId);
    if (!b) throw new Error(`the audio of ${job.sourceId} is not loaded`);
    return { wav: encodeWav(b), duration: b.duration, sampleRate: b.sampleRate } as Out;
  }

  if (job.kind === 'sound') {
    checkLoaded(s, [job.trackId]);
    const one = soloRegions(s, job.trackId, job.clipIds);
    const sampleRate = rateOf(one);
    const contentEnd = sessionEnd(one);
    const [wet, dry] = await Promise.all([
      renderTrack(one, job.trackId, buffers, { tail: TAIL_S, sampleRate }),
      // the recipe's source: the regions at the track's gain, before every device (reopen_sound
      // loads them all again at 0 dB gain, which plays back the export)
      renderTrack({ ...one, tracks: one.tracks.map((t) => ({ ...t, devices: [] })) }, job.trackId, buffers, { tail: 0, sampleRate }),
    ]);
    const trimmed = trimTrailingSilence(channels(wet), sampleRate);
    const duration = trimmed[0].length / sampleRate;
    const dryChs = channels(dry);
    return {
      wav: encodeWav(asBuffer(trimmed, sampleRate)),
      dry: encodeWav(asBuffer(dryChs, sampleRate)),
      duration,
      dryDuration: dry.duration,
      tail: Math.max(0, duration - contentEnd),
      sampleRate,
    } as Out;
  }

  if (job.kind === 'stems') {
    const ids = s.tracks.filter((t) => t.clips.length).map((t) => t.id);
    checkLoaded(s, ids);
    const src = job.set === 'dry' ? drySession(s) : s;
    const sampleRate = rateOf(s);
    const end = sessionEnd(s);
    const rendered = await Promise.all(ids.map((id) => renderTrack(src, id, buffers, { tail: job.set === 'wet' ? TAIL_S : 0, sampleRate })));
    // every stem in a set has the same length, from the session start: dry ends at the last
    // region, wet where the last effect tail dies away
    let n = Math.round(end * sampleRate);
    if (job.set === 'wet') for (const b of rendered) n = Math.max(n, trimTrailingSilence(channels(b), sampleRate)[0].length);
    const stems = rendered.map((b, i) => ({
      trackId: ids[i],
      name: s.tracks.find((t) => t.id === ids[i])!.name,
      wav: encodeWav(asBuffer(fit(channels(b), n), sampleRate)),
    }));
    return { stems, duration: n / sampleRate, sampleRate } as Out;
  }

  // loudness of the mix as heard (mute and solo respected), with and without effects
  const anySolo = s.tracks.some((t) => t.soloed);
  const heard = s.tracks.filter((t) => t.clips.length && !t.muted && (!anySolo || t.soloed)).map((t) => t.id);
  if (!heard.length) return { wetDb: -Infinity, dryDb: -Infinity } as Out;
  checkLoaded(s, heard);
  const sampleRate = rateOf(s, heard);
  const mix = async (x: Session, tail: number) => {
    const parts = await Promise.all(heard.map((id) => renderTrack(x, id, buffers, { tail, sampleRate })));
    const n = Math.max(...parts.map((p) => p.length));
    const sum = [new Float32Array(n), new Float32Array(n)];
    for (const p of parts) for (let c = 0; c < 2; c++) { const d = p.getChannelData(Math.min(c, p.numberOfChannels - 1)); for (let i = 0; i < d.length; i++) sum[c][i] += d[i]; }
    return gatedRmsDb(sum, sampleRate);
  };
  const [wetDb, dryDb] = await Promise.all([mix(s, 2), mix(drySession(s), 0)]);
  return { wetDb, dryDb } as Out;
}

export function useServeRender(bridge: Bridge) {
  useEffect(() => bridge.serveRender(renderJob), [bridge]);
}
