// [S3 midi] Playback for MIDI clips: the notes are rendered offline (OfflineAudioContext) into an
// AudioBuffer that the playlist plays like any audio clip. One piano-like voice for every pitched
// part and a small synthesized kit for drums; the user swaps in real sounds later.
import { useEffect, useRef } from 'react';
import { getGlobalContext } from '@waveform-playlist/playout';
import { midiSignature, type MidiData, type MidiNote } from '../core/midi';
import type { Session } from '../core/session';
import { midiBufferId } from './audio';

const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);

function pianoNote(ctx: BaseAudioContext, out: AudioNode, n: MidiNote) {
  const t0 = n.start;
  const t1 = n.start + Math.max(n.duration, 0.05);
  const f = hz(n.pitch);
  const peak = 0.4 * Math.pow(n.velocity / 127, 1.2);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + 0.004);
  // a struck string: fast initial drop, then a slower, pitch-dependent decay; damper at note-off
  env.gain.setTargetAtTime(peak * 0.45, t0 + 0.004, 0.08);
  env.gain.setTargetAtTime(0.0001, t0 + 0.2, Math.max(0.4, 2.2 - (n.pitch - 40) * 0.03));
  env.gain.cancelScheduledValues(t1);
  env.gain.setTargetAtTime(0, t1, 0.06);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(9000, f * 8), t0);
  lp.frequency.setTargetAtTime(Math.min(4000, f * 3), t0, 0.3);
  lp.connect(env).connect(out);
  for (const [mult, type, g] of [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f * mult * (mult === 2 ? 1.001 : 1);
    const gg = ctx.createGain();
    gg.gain.value = g;
    o.connect(gg).connect(lp);
    o.start(t0);
    o.stop(t1 + 0.5);
  }
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

export async function renderMidi(m: MidiData, seconds: number, sampleRate = 44100): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor(); // keeps dense chords from clipping
  comp.threshold.value = -12;
  master.connect(comp).connect(ctx.destination);
  for (const n of m.notes) {
    if (n.start >= seconds) continue;
    (m.drum ? drumHit : pianoNote)(ctx, master, n);
  }
  return ctx.startRendering();
}

/** Keeps a rendered buffer per MIDI clip, re-rendering when its notes change (edits, quantize, undo). */
export function useMidiRenders(session: Session | null, setRendered: (bufferId: string, b: AudioBuffer) => void) {
  const sigs = useRef(new Map<string, string>());
  useEffect(() => {
    if (!session) return;
    const sr = (getGlobalContext().rawContext as unknown as BaseAudioContext).sampleRate || 44100;
    for (const t of session.tracks) {
      for (const c of t.clips) {
        if (!c.midi) continue;
        const seconds = session.sources[c.sourceId]?.duration ?? c.offset + c.duration;
        const sig = midiSignature(c.midi, seconds);
        if (sigs.current.get(c.id) === sig) continue;
        sigs.current.set(c.id, sig);
        renderMidi(c.midi, seconds, sr).then((b) => {
          if (sigs.current.get(c.id) === sig) setRendered(midiBufferId(c.id), b);
        });
      }
    }
  }, [session, setRendered]);
}
