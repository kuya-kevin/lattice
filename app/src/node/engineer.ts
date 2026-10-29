// B3: Node side of the engineer sidecar (cleanup_noise, quantize_drums). Runs
// spikes/k_source_prep/run_engineer.sh (a one-shot child process) on a source's uploaded WAV
// (sourcePrep.audioPath) and returns the processed WAV's bytes with the result. Used by
// Electron main and the Vite dev middleware. With $LATTICE_ENGINEER_MOCK=1 the input comes
// back unchanged with a mock result (e2e tests, machines without the Python envs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CleanupNoiseResult, QuantizeDrumsArgs, QuantizeDrumsResult } from '../core/sidecar.ts';
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
  const input = audioPath(cfg, job.sourceId);
  if (!existsSync(input)) throw new Error(`no audio for source ${job.sourceId} on the sidecar side (the renderer uploads it when the audio loads)`);
  if (opts.mock) return { result: mockResult(job) as ResultOf<J>, wav: new Uint8Array(readFileSync(input)) };
  const script = resolve(cfg.script, '..', 'run_engineer.sh');
  if (!existsSync(script)) throw new Error(`engineer sidecar not found at ${script}`);
  if (!cfg.bigDisk) throw new Error(`no folder for the Python envs: set LATTICE_BIGDISK in lattice/.env, or create ${DEFAULT_BIGDISK} (backlog B3a)`);
  const outDir = join(cfg.workDir, 'runs');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${job.sourceId}-${job.op}-${Date.now().toString(36)}.wav`);
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return new Promise((ok, fail) => {
    const p = spawn('bash', [script, job.op, input, out, ...engineerArgs(job)], { env: { ...process.env, LATTICE_BIGDISK: cfg.bigDisk }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), fail(e)));
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      if (code !== 0 || !line || !existsSync(out)) return fail(new Error(`${job.op} failed (exit ${code}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
      try {
        ok({ result: JSON.parse(line.slice(7)) as ResultOf<J>, wav: new Uint8Array(readFileSync(out)) });
      } catch (e) {
        fail(e);
      }
    });
  });
}
