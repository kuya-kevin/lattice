// The Python sidecar (DSP/ML) interface. StubSidecar fakes every method (plausible results
// marked stub) so the agent loop and tests run anywhere; the app overrides the real ones.
//
// Real, each a one-shot child process on a WAV the renderer uploads per source (Bridge.putSourceAudio):
//   extractMidi                 (S3) spikes/k_source_prep/run.sh, via src/node/sourcePrep.ts
//   cleanupNoise, quantizeDrums (B3) spikes/k_source_prep/run_engineer.sh, via src/node/engineer.ts;
//     they write the processed audio under `newSourceId`, where the renderer loads it
//     (Bridge.loadSourceAudio). A result without `stub` means that audio exists.
//   drumHits, soundRegions      (B13) the same script's `hits` / `regions` ops: analysis, no audio
//   splitStems                  the same script's `split` op (Meta Demucs); each stem's audio is kept
//     under its source_id, where the renderer loads it
import type { PrepManifest } from './midi';

export type ExtractMode = 'auto' | 'hum' | 'keys' | 'bass' | 'drums' | 'layered';
export interface ExtractMidiArgs {
  sourceId: string;
  mode: ExtractMode;
  /** quantize grid ('off' or a GRIDS key); the sidecar skips it when the tempo is unclear */
  grid: string;
  separate: 'auto' | 'none';
  keySnap: boolean;
  /** known tempo; omit to let the sidecar estimate one */
  bpm?: number;
}

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
  /** what ran: "noisereduce" */
  method: string;
  /** level of the quietest 0.5 s (the noise between phrases), dB */
  noise_floor_db: { before: number; after: number };
  /** overall level change; near 0 means the performance was left alone */
  level_change_db: number;
  seconds?: number;
  stub?: true;
}

/** B13: one drum hit, for slicing a loop by drum. `time` is in source seconds, just before the
 *  attack; `also` lists other drums that sound at the same moment (they stay in this slice). */
export type DrumKind = 'kick' | 'snare' | 'hat';
export interface DrumHit {
  time: number;
  kind: DrumKind;
  also?: DrumKind[];
}
export interface DrumHitsResult {
  hits: DrumHit[];
  stub?: true;
}

/** B13: where a source has sound (source seconds), and the level counted as silence (dB below
 *  the loudest part). */
export interface SoundRegionsResult {
  regions: [number, number][];
  threshold_db: number;
  stub?: true;
}

/** One Demucs stem; its audio is kept under source_id. share: its part of the energy, 0-1. */
export interface SplitStem {
  name: string;
  share: number;
  source_id: string;
}
export interface SplitStemsResult {
  model: string;
  stems: SplitStem[];
  /** stems with next to no sound, not added */
  dropped: string[];
  seconds?: number;
  stub?: true;
}

export interface Sidecar {
  quantizeDrums(a: QuantizeDrumsArgs): Promise<QuantizeDrumsResult>;
  cleanupNoise(a: { sourceId: string; newSourceId: string }): Promise<CleanupNoiseResult>;
  /** B13: the drum hits in a source's audio (spikes/k_source_prep/drums.py slice_points) */
  drumHits(a: { sourceId: string }): Promise<DrumHitsResult>;
  /** B13: the stretches with sound in a source's audio (engineer.py sound_regions) */
  soundRegions(a: { sourceId: string }): Promise<SoundRegionsResult>;
  /** Meta Demucs stems of a source's audio; each kept under `<newSourceId>-<stem>` */
  splitStems(a: { sourceId: string; newSourceId: string }): Promise<SplitStemsResult>;
  /** Voice note -> stems -> notes (spikes/k_source_prep). */
  extractMidi(a: ExtractMidiArgs): Promise<PrepManifest>;
}

/** Every method fakes its result; the audio ones write no audio and say stub. */
export class StubSidecar implements Sidecar {
  async quantizeDrums(a: QuantizeDrumsArgs): Promise<QuantizeDrumsResult> {
    return { hits: 32, moved: Math.round(28 * a.strength), max_shift_ms: Math.round(24 * a.strength), stub: true };
  }
  async cleanupNoise(_a: { sourceId: string; newSourceId: string }): Promise<CleanupNoiseResult> {
    return { method: 'noisereduce stationary (stub)', noise_floor_db: { before: -40, after: -51 }, level_change_db: -0.8, stub: true };
  }
  async drumHits(_a: { sourceId: string }): Promise<DrumHitsResult> {
    return { hits: [], stub: true };
  }
  async soundRegions(_a: { sourceId: string }): Promise<SoundRegionsResult> {
    return { regions: [], threshold_db: -50, stub: true };
  }
  async splitStems(a: { sourceId: string; newSourceId: string }): Promise<SplitStemsResult> {
    return { model: 'htdemucs_6s', stems: ['drums', 'bass', 'other'].map((name) => ({ name, share: 0.33, source_id: `${a.newSourceId}-${name}` })), dropped: [], stub: true };
  }
  async extractMidi(_a: ExtractMidiArgs): Promise<PrepManifest> {
    throw new Error('the source-prep sidecar is not available here (set LATTICE_BIGDISK and run the app from the repo)');
  }
}
