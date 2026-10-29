// B3: Node side of the engineer sidecar (cleanup_noise, quantize_drums; B13 drum hits, sound regions). Runs
// spikes/k_source_prep/run_engineer.sh (a one-shot child process) on a source's uploaded WAV
// (sourcePrep.audioPath) and returns the processed WAV's bytes with the result. Used by
// Electron main and the Vite dev middleware. With $LATTICE_ENGINEER_MOCK=1 the input comes
// back unchanged with a mock result (e2e tests, machines without the Python envs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CleanupNoiseResult, DrumHitsResult, QuantizeDrumsArgs, QuantizeDrumsResult, SoundRegionsResult } from '../core/sidecar.ts';
import { audioPath, DEFAULT_BIGDISK, type SourcePrepConfig } from './sourcePrep.ts';

export type EngineerJob = { op: 'cleanup'; sourceId: string } | ({ op: 'quantize' } & Omit<QuantizeDrumsArgs, 'newSourceId'>);
type ResultOf<J extends EngineerJob> = J extends { op: 'cleanup' } ? CleanupNoiseResult : QuantizeDrumsResult;

export function engineerArgs(j: EngineerJob): string[] {
  if (j.op === 'cleanup') return [];
  return ['--bpm', String(j.bpm), '--grid', String(j.grid), '--strength', String(j.strength), '--phase', String(j.phase)];
}

function mockResult(j: EngineerJob): CleanupNoiseResult | QuantizeDrumsResult {
  return j.op === 'cleanup'
    ? { method: 'mock (LATTICE_ENGINEER_MOCK)', noise_floor_db: { before: -40, after: -55 }, level_change_db: -0.2 }
    : { hits: 16, moved: 12, max_shift_ms: 20, off_grid_ms: { before: 12, after: 1 } };
}

export async function runEngineer<J extends EngineerJob>(
  cfg: SourcePrepConfig,
  job: J,
  opts: { mock?: boolean; timeoutMs?: number } = {},
): Promise<{ result: ResultOf<J>; wav: Uint8Array }> {
  const input = inputOf(cfg, job.sourceId);
  if (opts.mock) return { result: mockResult(job) as ResultOf<J>, wav: new Uint8Array(readFileSync(input)) };
  const outDir = join(cfg.workDir, 'runs');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${job.sourceId}-${job.op}-${Date.now().toString(36)}.wav`);
  const result = await spawnEngineer(cfg, [job.op, input, out, ...engineerArgs(job)], opts.timeoutMs);
  if (!existsSync(out)) throw new Error(`${job.op} failed: no output audio`);
  return { result: result as ResultOf<J>, wav: new Uint8Array(readFileSync(out)) };
}

/** B13: the drum hits in a source (`hits` op, no audio written). Mock: a kick / hat / snare /
 *  hat pattern every 0.25 s for 2 s. */
export async function runDrumHits(cfg: SourcePrepConfig, sourceId: string, opts: { mock?: boolean; timeoutMs?: number } = {}): Promise<DrumHitsResult> {
  const input = inputOf(cfg, sourceId);
  if (opts.mock) return { hits: Array.from({ length: 8 }, (_, i) => ({ time: i * 0.25, kind: (['kick', 'hat', 'snare', 'hat'] as const)[i % 4] })) };
  const r = (await spawnEngineer(cfg, ['hits', input], opts.timeoutMs)) as DrumHitsResult;
  return { hits: r.hits.map(({ also, ...h }) => (also?.length ? { ...h, also } : h)) };
}

/** B13: where a source has sound (`regions` op, no audio written). Mock: sound from 0.25 to 1.75 s. */
export async function runSoundRegions(cfg: SourcePrepConfig, sourceId: string, opts: { mock?: boolean; timeoutMs?: number } = {}): Promise<SoundRegionsResult> {
  const input = inputOf(cfg, sourceId);
  if (opts.mock) return { regions: [[0.25, 1.75]], threshold_db: -50 };
  const { regions, threshold_db } = (await spawnEngineer(cfg, ['regions', input], opts.timeoutMs)) as SoundRegionsResult;
  return { regions, threshold_db };
}

/** B13: the analysis ops by name, for the dev:web middleware */
export const runAnalysis = { hits: runDrumHits, regions: runSoundRegions };

function inputOf(cfg: SourcePrepConfig, sourceId: string): string {
  const input = audioPath(cfg, sourceId);
  if (!existsSync(input)) throw new Error(`no audio for source ${sourceId} on the sidecar side (the renderer uploads it when the audio loads)`);
  return input;
}

/** Run run_engineer.sh with these args and parse its `RESULT <json>` line. */
function spawnEngineer(cfg: SourcePrepConfig, args: string[], timeoutMs = 10 * 60_000): Promise<unknown> {
  const script = resolve(cfg.script, '..', 'run_engineer.sh');
  if (!existsSync(script)) return Promise.reject(new Error(`engineer sidecar not found at ${script}`));
  if (!cfg.bigDisk) return Promise.reject(new Error(`no folder for the Python envs: set LATTICE_BIGDISK in lattice/.env, or create ${DEFAULT_BIGDISK} (backlog B3a)`));
  return new Promise((ok, fail) => {
    const p = spawn('bash', [script, ...args], { env: { ...process.env, LATTICE_BIGDISK: cfg.bigDisk }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), fail(e)));
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line) return fail(new Error(`${args[0]} failed (exit ${code}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
      try {
        ok(JSON.parse(line.slice(7)));
      } catch (e) {
        fail(e);
      }
    });
  });
}
