// The Python sidecar (DSP/ML) interface. Everything here is a stub for now: it returns
// plausible fake results so the agent loop and UI can be built end to end.
//
// TODO(sidecar): implement as a long-lived Python process (JSON lines over stdio) in the
// spikes' uv env, wrapping:
//   cleanupNoise        -> spikes/b_cleanup/run_noisereduce.py (stationary, profile from the quietest 0.5 s)
//   setSynthKnobs       -> spikes/c_recreate/synth.py render()
//   fitSynthToReference -> spikes/c_recreate/match.py + run_optimizer.py (CMA-ES, ~30 s)
//   generateMrt2        -> spikes/d_mrt2/run_mrt2.py (envs/mrt, mlx==0.31.1)
//   quantizeDrums       -> onset slicing + snap + crossfade (no time-stretch), not written yet

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

export interface Sidecar {
  quantizeDrums(a: { sourceId: string; grid: string; strength: number; bpm: number }): Promise<{ onsets: number; moved: number; maxShiftMs: number }>;
  cleanupNoise(a: { sourceId: string }): Promise<{ method: string; noiseFloorDb: number; performanceDb: number }>;
  generateMrt2(a: { styleText?: string; referenceSourceId?: string; notes?: string; seconds: number }): Promise<{ status: string; seconds: number; prompt: string }>;
  setSynthKnobs(patch: Record<string, number>): Promise<{ patch: Record<string, number>; clamped: string[] }>;
  fitSynthToReference(a: { sourceId: string }): Promise<{ patch: Record<string, number>; distance: number; renders: number }>;
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

/** TODO(sidecar): every method below fakes its result. */
export class StubSidecar implements Sidecar {
  async quantizeDrums(a: { grid: string; strength: number }) {
    return { onsets: 32, moved: Math.round(28 * a.strength), maxShiftMs: Math.round(24 * a.strength) };
  }
  async cleanupNoise() {
    return { method: 'noisereduce stationary (stub)', noiseFloorDb: -11, performanceDb: -0.8 };
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
}
