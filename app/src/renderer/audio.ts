// Audio data lives only in the renderer, keyed by source id. The session (main process)
// knows sources by id and duration; this module decodes files and maps the session to
// waveform-playlist tracks.
import type { AudioClip, ClipTrack } from '@waveform-playlist/core';
import { getGlobalContext } from '@waveform-playlist/playout';
import { laneHeight, type Session } from '../core/session';

/** A Map that tells subscribers when a buffer is added (e.g. so sampler MIDI clips re-render
 *  once their sample's audio arrives). */
class BufferStore extends Map<string, AudioBuffer> {
  private listeners = new Set<(id: string) => void>();
  override set(id: string, b: AudioBuffer) {
    super.set(id, b);
    for (const fn of this.listeners ?? []) fn(id); // listeners is unset while Map's constructor runs
    return this;
  }
  subscribe(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
export const buffers = new BufferStore();

/** [S3 midi] Key of a MIDI clip's rendered audio in `buffers` (renderer/midiSynth.ts). */
export const midiBufferId = (clipId: string) => `midi:${clipId}`;

export function newSourceId(): string {
  return `src-${Math.random().toString(36).slice(2, 10)}`;
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const ctx = getGlobalContext().rawContext as unknown as BaseAudioContext;
  return ctx.decodeAudioData(await file.arrayBuffer());
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

export function toClipTracks(s: Session, waveHeight = 84): ClipTrack[] {
  return s.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    height: laneHeight(t.heightScale, waveHeight), // the playlist is patched to honour this (patches/)
    muted: t.muted,
    soloed: t.soloed,
    volume: dbToGain(t.gainDb),
    pan: 0,
    clips: t.clips.flatMap((c): AudioClip[] => {
      const b = buffers.get(c.midi ? midiBufferId(c.id) : c.sourceId); // [S3 midi] MIDI clips play their render
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

/** True when two track lists have the same layout (lets us keep the engine's own array
 *  reference after a drag, which avoids a full engine rebuild). Mute, solo and volume don't
 *  count: App's MixSync sends those to the engine directly. */
export function sameLayout(a: ClipTrack[], b: ClipTrack[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i];
    if (t.id !== u.id || t.name !== u.name || t.height !== u.height) return false;
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
