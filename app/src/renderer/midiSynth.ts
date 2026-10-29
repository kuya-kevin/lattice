// [S3 midi] Playback for MIDI clips: the notes are rendered offline (OfflineAudioContext) into an
// AudioBuffer that the playlist plays like any audio clip. One piano-like voice for every pitched
// part, a small synthesized kit for drums, and a sampler (an audio clip repitched per note) for
// takes recorded on Musical Typing with a sample as the instrument.
import { useEffect, useRef, useState } from 'react';
import { getGlobalContext } from '@waveform-playlist/playout';
import { midiSignature, sampleRateFor, type MidiData, type MidiNote, type SampleRef } from '../core/midi';
import type { Session } from '../core/session';
import { buffers, midiBufferId } from './audio';

/** A sounding note; release(t) starts its note-off. */
export interface Voice {
  release(t: number): void;
}

/** Note-off fade of a sampler voice (s). */
export const SAMPLE_RELEASE = 0.08;

/** One sampler voice: the sample's region from t0, repitched to `pitch` (root = unchanged).
 *  Velocity scales the level; release(t) fades out over SAMPLE_RELEASE. A one-shot shorter
 *  than the note just ends. Shared by the offline render and live playing. */
export function sampleVoice(ctx: BaseAudioContext, out: AudioNode, buffer: AudioBuffer, smp: SampleRef, pitch: number, velocity: number, t0: number): Voice {
  const level = Math.pow(velocity / 127, 1.2);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(level, t0 + 0.003); // no click at the start
  env.connect(out);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = sampleRateFor(pitch, smp.root);
  src.connect(env);
  const offset = Math.min(Math.max(0, smp.offset), buffer.duration);
  const length = Math.max(0, Math.min(smp.duration, buffer.duration - offset)); // buffer time
  src.start(t0, offset, length);
  src.onended = () => env.disconnect();
  let released = false;
  return {
    release(t1: number) {
      if (released) return;
      released = true;
      const g = env.gain;
      if ('cancelAndHoldAtTime' in g && !(ctx instanceof OfflineAudioContext)) g.cancelAndHoldAtTime(t1);
      else {
        g.cancelScheduledValues(t1);
        g.setValueAtTime(t1 >= t0 + 0.003 ? level : g.value, t1);
      }
      g.linearRampToValueAtTime(0, t1 + SAMPLE_RELEASE);
      try {
        src.stop(t1 + SAMPLE_RELEASE + 0.01);
      } catch {
        // already ended
      }
    },
  };
}

const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);

/** One piano voice from t0, ringing until release(t) (the damper). Shared by the offline
 *  render and live playing (Musical Typing). */
export function pianoVoice(ctx: BaseAudioContext, out: AudioNode, pitch: number, velocity: number, t0: number): Voice {
  const f = hz(pitch);
  const peak = 0.4 * Math.pow(velocity / 127, 1.2);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + 0.004);
  // a struck string: fast initial drop, then a slower, pitch-dependent decay; damper at note-off
  env.gain.setTargetAtTime(peak * 0.45, t0 + 0.004, 0.08);
  env.gain.setTargetAtTime(0.0001, t0 + 0.2, Math.max(0.4, 2.2 - (pitch - 40) * 0.03));
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(9000, f * 8), t0);
  lp.frequency.setTargetAtTime(Math.min(4000, f * 3), t0, 0.3);
  lp.connect(env).connect(out);
  const oscs: OscillatorNode[] = [];
  for (const [mult, type, g] of [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f * mult * (mult === 2 ? 1.001 : 1);
    const gg = ctx.createGain();
    gg.gain.value = g;
    o.connect(gg).connect(lp);
    o.start(t0);
    oscs.push(o);
  }
  return {
    release(t1: number) {
      // live: hold the current level at t1 instead of jumping back to a scheduled value
      if ('cancelAndHoldAtTime' in env.gain && !(ctx instanceof OfflineAudioContext)) env.gain.cancelAndHoldAtTime(t1);
      else env.gain.cancelScheduledValues(t1);
      env.gain.setTargetAtTime(0, t1, 0.06);
      for (const o of oscs) o.stop(t1 + 0.5);
      oscs[0].onended = () => env.disconnect();
    },
  };
}

function pianoNote(ctx: BaseAudioContext, out: AudioNode, n: MidiNote) {
  pianoVoice(ctx, out, n.pitch, n.velocity, n.start).release(n.start + Math.max(n.duration, 0.05));
}

let noise: AudioBuffer | null = null;
function noiseBuffer(ctx: BaseAudioContext) {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

function drumHit(ctx: BaseAudioContext, out: AudioNode, n: MidiNote) {
  const t = n.start;
  const v = n.velocity / 127;
  const g = ctx.createGain();
  g.connect(out);
  if (n.pitch === 35 || n.pitch === 36) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.4);
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  const hat = n.pitch === 42 || n.pitch === 44 || n.pitch === 46;
  f.type = hat ? 'highpass' : 'bandpass';
  f.frequency.value = hat ? 7000 : 1800;
  const len = hat ? 0.05 : 0.18;
  g.gain.setValueAtTime((hat ? 0.25 : 0.5) * v, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(f).connect(g);
  src.start(t);
  src.stop(t + len + 0.02);
  if (!hat) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 185;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.35 * v, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }
}

/** One short note on a clip's own instrument, now: the Piano Roll's click preview. A sampler
 *  clip plays its sample (`sample`: the source's audio; the piano until it is loaded), a drum
 *  clip its kit, anything else the piano. */
export function auditionNote(ctx: BaseAudioContext, out: AudioNode, m: MidiData | undefined, pitch: number, velocity: number, sample?: AudioBuffer, length = 0.25) {
  const t = ctx.currentTime;
  if (m?.drum) return drumHit(ctx, out, { pitch, velocity, start: t, duration: length });
  const v = m?.sample && sample ? sampleVoice(ctx, out, sample, m.sample, pitch, velocity, t) : pianoVoice(ctx, out, pitch, velocity, t);
  v.release(t + length);
}

/** Render a clip's notes. A sampler clip (m.sample) needs its source's audio as `sample`. */
export async function renderMidi(m: MidiData, seconds: number, sampleRate = 44100, sample?: AudioBuffer): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor(); // keeps dense chords from clipping
  comp.threshold.value = -12;
  master.connect(comp).connect(ctx.destination);
  for (const n of m.notes) {
    if (n.start >= seconds) continue;
    if (m.sample && sample) sampleVoice(ctx, master, sample, m.sample, n.pitch, n.velocity, n.start).release(n.start + Math.max(n.duration, 0.01));
    else (m.drum ? drumHit : pianoNote)(ctx, master, n);
  }
  return ctx.startRendering();
}

/** Keeps a rendered buffer per MIDI clip, re-rendering when its notes change (edits, quantize,
 *  undo). A sampler clip waits for its sample's audio and renders once it arrives. */
export function useMidiRenders(session: Session | null, setRendered: (bufferId: string, b: AudioBuffer) => void) {
  const sigs = useRef(new Map<string, string>());
  const [loaded, setLoaded] = useState(0); // bumps when a source's audio arrives
  useEffect(() => buffers.subscribe((id) => !id.startsWith(midiBufferId('')) && setLoaded((n) => n + 1)), []);
  useEffect(() => {
    if (!session) return;
    const sr = (getGlobalContext().rawContext as unknown as BaseAudioContext).sampleRate || 44100;
    for (const t of session.tracks) {
      for (const c of t.clips) {
        if (!c.midi) continue;
        const seconds = session.sources[c.sourceId]?.duration ?? c.offset + c.duration;
        const sample = c.midi.sample ? buffers.get(c.midi.sample.sourceId) : undefined;
        if (c.midi.sample && !sample) continue; // not loaded (yet): render when it arrives
        const sig = midiSignature(c.midi, seconds);
        if (sigs.current.get(c.id) === sig) continue;
        sigs.current.set(c.id, sig);
        renderMidi(c.midi, seconds, sr, sample).then((b) => {
          if (sigs.current.get(c.id) === sig) setRendered(midiBufferId(c.id), b);
        });
      }
    }
  }, [session, setRendered, loaded]);
}
