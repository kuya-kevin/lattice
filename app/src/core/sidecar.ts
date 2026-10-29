// The Python sidecar (DSP/ML) interface. StubSidecar fakes every method (plausible results
// marked stub) so the agent loop and tests run anywhere; the app overrides the real ones.
//
// Real, each a one-shot child process on a WAV the renderer uploads per source (Bridge.putSourceAudio):
//   extractMidi                 (S3) spikes/k_source_prep/run.sh, via src/node/sourcePrep.ts
//   cleanupNoise, quantizeDrums (B3) spikes/k_source_prep/run_engineer.sh, via src/node/engineer.ts;
//     they write the processed audio under `newSourceId`, where the renderer loads it
//     (Bridge.loadSourceAudio). A result without `stub` means that audio exists.
// TODO(sidecar), still stubs:
//   setSynthKnobs       -> spikes/c_recreate/synth.py render()
//   fitSynthToReference -> spikes/c_recreate/match.py + run_optimizer.py (CMA-ES, ~30 s)
//   generateMrt2        -> spikes/d_mrt2/run_mrt2.py (envs/mrt, mlx==0.31.1)
import type { PrepManifest } from './midi';

export type ExtractMode = 'auto' | 'hum' | 'keys' | 'bass' | 'drums' | 'layered';
export interface ExtractMidiArgs {
  sourceId: string;
  mode: ExtractMode;
  /** quantize grid ('off' or a GRIDS key); the sidecar skips it when the tempo is unclear */
  grid: string;
  separate: 'auto' | 'none' | 'vocals' | 'full';
  keySnap: boolean;
  /** known tempo; omit to let the sidecar estimate one */
  bpm?: number;
}

/** The 15 knobs of our subtractive synth (mirrors spikes/c_recreate/synth.py PARAMS). */
export const SYNTH_KNOBS: Record<string, { lo: number; hi: number; unit: string; doc: string }> = {
  saw: { lo: 0, hi: 1, unit: 'level', doc: 'sawtooth oscillator level' },
  square: { lo: 0, hi: 1, unit: 'level', doc: 'square oscillator level' },
  sub: { lo: 0, hi: 1, unit: 'level', doc: 'sine one octave below' },
  noise: { lo: 0, hi: 0.5, unit: 'level', doc: 'white noise level' },
  voices: { lo: 1, hi: 7, unit: 'count', doc: 'unison voices on saw and square' },
  detune: { lo: 0, hi: 50, unit: 'cents', doc: 'spread of unison voices' },
  cutoff: { lo: 60, hi: 16000, unit: 'Hz', doc: 'low-pass cutoff' },
  resonance: { lo: 0, hi: 0.95, unit: 'amount', doc: 'low-pass resonance' },
  env_amount: { lo: 0, hi: 6, unit: 'octaves', doc: 'filter envelope pushes cutoff up by this much' },
  env_decay: { lo: 0.005, hi: 2, unit: 's', doc: 'filter envelope decay' },
  attack: { lo: 0.001, hi: 1, unit: 's', doc: 'amp attack' },
  decay: { lo: 0.01, hi: 2, unit: 's', doc: 'amp decay' },
  sustain: { lo: 0, hi: 1, unit: 'level', doc: 'amp sustain' },
  release: { lo: 0.01, hi: 2, unit: 's', doc: 'amp release' },
  drive: { lo: 0, hi: 1, unit: 'amount', doc: 'tanh saturation after the filter' },
};

export const DEFAULT_PATCH: Record<string, number> = {
  saw: 0.8, square: 0, sub: 0.2, noise: 0, voices: 1, detune: 0,
  cutoff: 2000, resonance: 0.2, env_amount: 1, env_decay: 0.3,
  attack: 0.005, decay: 0.3, sustain: 0.7, release: 0.2, drive: 0,
};

export interface QuantizeDrumsArgs {
  sourceId: string;
  newSourceId: string;
  /** grid division: 4, 8, 16 or 32 (1/16 -> 16) */
  grid: number;
  strength: number;
  bpm: number;
  /** source seconds of a grid line, so hits land on the session's bars */
  phase: number;
}
export interface QuantizeDrumsResult {
  hits: number;
  moved: number;
  max_shift_ms: number;
  /** median distance of the hits from the nearest grid line */
  off_grid_ms?: { before: number; after: number | null };
  stub?: true;
}
export interface CleanupNoiseResult {
  /** what ran: "Mel-RoFormer denoise", "noisereduce (fallback)", ... */
  method: string;
  /** level of the quietest 0.5 s (the noise between phrases), dB */
  noise_floor_db: { before: number; after: number };
  /** overall level change; near 0 means the performance was left alone */
  level_change_db: number;
  fallback_reason?: string;
  seconds?: number;
  stub?: true;
}

export interface Sidecar {
  quantizeDrums(a: QuantizeDrumsArgs): Promise<QuantizeDrumsResult>;
  cleanupNoise(a: { sourceId: string; newSourceId: string }): Promise<CleanupNoiseResult>;
  generateMrt2(a: { styleText?: string; referenceSourceId?: string; notes?: string; seconds: number }): Promise<{ status: string; seconds: number; prompt: string }>;
  setSynthKnobs(patch: Record<string, number>): Promise<{ patch: Record<string, number>; clamped: string[] }>;
  fitSynthToReference(a: { sourceId: string }): Promise<{ patch: Record<string, number>; distance: number; renders: number }>;
  /** Voice note -> stems -> notes (spikes/k_source_prep). */
  extractMidi(a: ExtractMidiArgs): Promise<PrepManifest>;
}

export function clampPatch(patch: Record<string, number>): { patch: Record<string, number>; clamped: string[] } {
  const out = { ...DEFAULT_PATCH };
  const clamped: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const spec = SYNTH_KNOBS[k];
    if (!spec || typeof v !== 'number') {
      clamped.push(`${k} (unknown knob, ignored)`);
      continue;
    }
    const c = Math.min(spec.hi, Math.max(spec.lo, v));
    if (c !== v) clamped.push(k);
    out[k] = k === 'voices' ? Math.round(c) : c;
  }
  return { patch: out, clamped };
}

/** Every method fakes its result; the audio ones write no audio and say stub. */
export class StubSidecar implements Sidecar {
  async quantizeDrums(a: QuantizeDrumsArgs): Promise<QuantizeDrumsResult> {
    return { hits: 32, moved: Math.round(28 * a.strength), max_shift_ms: Math.round(24 * a.strength), stub: true };
  }
  async cleanupNoise(_a: { sourceId: string; newSourceId: string }): Promise<CleanupNoiseResult> {
    return { method: 'noisereduce stationary (stub)', noise_floor_db: { before: -40, after: -51 }, level_change_db: -0.8, stub: true };
  }
  async generateMrt2(a: { styleText?: string; referenceSourceId?: string; seconds: number }) {
    const prompt = a.styleText ?? `audio prompt from ${a.referenceSourceId}`;
    return { status: 'stub: not rendered (MRT2 sidecar not wired yet)', seconds: a.seconds, prompt };
  }
  async setSynthKnobs(patch: Record<string, number>) {
    return clampPatch(patch);
  }
  async fitSynthToReference() {
    return { patch: { ...DEFAULT_PATCH, voices: 5, detune: 18, cutoff: 3200 }, distance: 0.82, renders: 2400 };
  }
  async extractMidi(_a: ExtractMidiArgs): Promise<PrepManifest> {
    throw new Error('the source-prep sidecar is not available here (set LATTICE_BIGDISK and run the app from the repo)');
  }
}
