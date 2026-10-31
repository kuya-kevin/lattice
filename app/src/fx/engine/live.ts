// Live hookup: waveform-playlist calls a track's `effects(graphEnd, destination, isOffline)`
// whenever it builds that track. We insert a ChainHost there and keep it in step with the
// session (sync), so device and knob changes never force a playlist rebuild.
import type { ClipTrack } from '@waveform-playlist/core';
import type { Session } from '../../core/session';
import { ChainHost } from './host';
import { warmUp } from './worklet';

const hosts = new Map<string, Set<ChainHost>>();
let latest: Session | null = null;

function nativeNode(x: unknown, side: 'input' | 'output', depth = 0): AudioNode | null {
  if (typeof AudioNode !== 'undefined' && x instanceof AudioNode) return x;
  if (depth > 3 || !x || typeof x !== 'object') return null;
  return nativeNode((x as Record<string, unknown>)[side], side, depth + 1);
}

/** The per-track effects function for waveform-playlist (stable per track id). */
const fns = new Map<string, NonNullable<ClipTrack['effects']>>();
export function trackEffects(trackId: string): NonNullable<ClipTrack['effects']> {
  let fn = fns.get(trackId);
  if (fn) return fn;
  fn = (graphEnd, destination) => {
    const src = nativeNode(graphEnd, 'output');
    const dst = nativeNode(destination, 'input');
    if (!src || !dst || src.context !== dst.context) {
      // standardized-audio-context (non-native) graph: we cannot splice native nodes in
      console.warn('[fx] effects need a native AudioContext (configureGlobalContext({ nativeAudioContext: true })); track plays dry');
      (graphEnd as { connect(d: unknown): void }).connect(destination);
      return;
    }
    const host = new ChainHost(src.context, { tempo: latest?.tempo ?? 120 });
    src.connect(host.input);
    host.output.connect(dst);
    let set = hosts.get(trackId);
    if (!set) hosts.set(trackId, (set = new Set()));
    set.add(host);
    const t = latest?.tracks.find((t) => t.id === trackId);
    host.setChain(t?.devices ?? []);
    return () => {
      set!.delete(host);
      try {
        src.disconnect(host.input);
      } catch {
        /* ignore */
      }
      host.dispose();
    };
  };
  fns.set(trackId, fn);
  return fn;
}

/** Attach the effects hook to playlist tracks (call on the derived ClipTrack list). */
export function withTrackFx(tracks: ClipTrack[]): ClipTrack[] {
  return tracks.map((t) => (t.effects ? t : { ...t, effects: trackEffects(t.id) }));
}

/** Push the session's chains and tempo into every live host. */
export function syncFx(s: Session) {
  latest = s;
  for (const t of s.tracks) {
    for (const h of hosts.get(t.id) ?? []) {
      h.setTempo(s.tempo);
      h.setChain(t.devices ?? []);
    }
  }
}

export function previewParam(trackId: string, deviceId: string, param: string, value: number | string | boolean) {
  for (const h of hosts.get(trackId) ?? []) h.preview(deviceId, param, value);
}

export function trackMeters(trackId: string): Record<string, Record<string, number>> {
  const h = hosts.get(trackId)?.values().next().value;
  return h ? h.meters() : {};
}

/** A track's output level as heard (after its fader, pan, mute and effects): peak dBFS per
 *  channel over the last few ms, or null while the track has no live chain. */
export function trackLevels(trackId: string): number[] | null {
  const set = hosts.get(trackId);
  if (!set?.size) return null;
  // a track can have more than one live host (the playlist rebuilds it); the one playing is loudest
  return [...set].map((h) => h.levels()).reduce((a, b) => a.map((v, i) => Math.max(v, b[i])));
}

export function trackLatency(trackId: string): number {
  const h = hosts.get(trackId)?.values().next().value;
  return h ? h.latency() : 0;
}

export { warmUp };
