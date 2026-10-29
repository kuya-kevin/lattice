// B9: the renderer's half of measure_track. It holds the audio, so it renders the track
// offline (as heard, and with its effects removed) and measures both with core/ears.
import { useEffect } from 'react';
import type { Bridge } from '../core/bridge';
import { measure } from '../core/ears';
import type { Session } from '../core/session';
import { renderTrack } from '../fx/engine/render';
import { buffers } from './audio';

async function features(s: Session, trackId: string) {
  const b = await renderTrack(s, trackId, buffers, { tail: 1 });
  return measure([b.getChannelData(0), b.getChannelData(1)], b.sampleRate);
}

export async function measureTrack(s: Session, trackId: string) {
  const t = s.tracks.find((t) => t.id === trackId);
  if (!t) throw new Error(`no track ${trackId}`);
  const missing = t.clips.filter((c) => !buffers.has(c.midi ? `midi:${c.id}` : c.sourceId));
  if (missing.length === t.clips.length) throw new Error(`the audio of track ${trackId} is not loaded yet`);
  const dry = { ...s, tracks: s.tracks.map((x) => (x.id === trackId ? { ...x, devices: [] } : x)) };
  const [wet, base] = await Promise.all([features(s, trackId), features(dry, trackId)]);
  return { wet, dry: base };
}

export function useServeMeasure(bridge: Bridge) {
  useEffect(() => bridge.serveMeasure(measureTrack), [bridge]);
}
