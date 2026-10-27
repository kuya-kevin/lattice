// Audio data lives only in the renderer, keyed by source id. The session (main process)
// knows sources by id and duration; this module decodes files and maps the session to
// waveform-playlist tracks.
import type { AudioClip, ClipTrack } from '@waveform-playlist/core';
import { getGlobalContext } from '@waveform-playlist/playout';
import type { Session } from '../core/session';

export const buffers = new Map<string, AudioBuffer>();

export function newSourceId(): string {
  return `src-${Math.random().toString(36).slice(2, 10)}`;
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const ctx = getGlobalContext().rawContext as unknown as BaseAudioContext;
  return ctx.decodeAudioData(await file.arrayBuffer());
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

export function toClipTracks(s: Session): ClipTrack[] {
  return s.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    muted: t.muted,
    soloed: t.soloed,
    volume: dbToGain(t.gainDb),
    pan: 0,
    clips: t.clips.flatMap((c): AudioClip[] => {
      const b = buffers.get(c.sourceId);
      if (!b) return []; // audio not here yet
      const sr = b.sampleRate;
      return [{
        id: c.id,
        name: c.name,
        audioBuffer: b,
        sampleRate: sr,
        sourceDurationSamples: b.length,
        startSample: Math.round(c.start * sr),
        offsetSamples: Math.round(c.offset * sr),
        durationSamples: Math.round(c.duration * sr),
        gain: 1,
      }];
    }),
  }));
}

/** True when two track lists would sound and look the same (lets us keep the engine's
 *  own array reference after a drag, which avoids a full engine rebuild). */
export function sameLayout(a: ClipTrack[], b: ClipTrack[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i];
    if (t.id !== u.id || t.name !== u.name || t.muted !== u.muted || t.soloed !== u.soloed || Math.abs(t.volume - u.volume) > 1e-6) return false;
    if (t.clips.length !== u.clips.length) return false;
    return t.clips.every((c, j) => {
      const d = u.clips[j];
      return c.id === d.id && c.startSample === d.startSample && c.offsetSamples === d.offsetSamples && c.durationSamples === d.durationSamples && c.audioBuffer === d.audioBuffer;
    });
  });
}

/** Turn the engine's edited tracks (after a drag/trim by the user) into user tool calls. */
export function diffToToolCalls(s: Session, next: ClipTrack[]): { tool: string; args: Record<string, unknown> }[] {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  for (const t of next) {
    for (const c of t.clips) {
      const sc = s.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id);
      if (!sc) continue;
      const start = r(c.startSample / c.sampleRate);
      const offset = r(c.offsetSamples / c.sampleRate);
      const duration = r(c.durationSamples / c.sampleRate);
      const eps = 0.002;
      if (Math.abs(offset - sc.offset) > eps || Math.abs(duration - sc.duration) > eps) {
        calls.push({ tool: 'trim_clip', args: { clip_id: c.id, start, end: r(start + duration) } });
      } else if (Math.abs(start - sc.start) > eps) {
        calls.push({ tool: 'move_clip', args: { clip_id: c.id, start } });
      }
    }
  }
  return calls;
}
