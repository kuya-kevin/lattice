// [S3 midi] Node side of the source-prep sidecar: stores uploaded source audio as WAV files and
// runs spikes/k_source_prep/run.sh (a one-shot child process) on them. Used by Electron main and
// by the Vite dev middleware (dev:web). With $LATTICE_SIDECAR_MOCK=<manifest.json> it returns that
// manifest instead (e2e tests, machines without the Python envs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrepManifest } from '../core/midi.ts';
import type { ExtractMidiArgs } from '../core/sidecar.ts';

export interface SourcePrepConfig {
  /** spikes/k_source_prep/run.sh */
  script: string;
  /** where uploaded audio and run outputs go */
  workDir: string;
  mockManifest?: string;
  /** folder for the Python envs, model weights and caches (LATTICE_BIGDISK, passed to run.sh) */
  bigDisk?: string;
}

/** Where the sidecar's envs and weights live when LATTICE_BIGDISK isn't set (the Mac setup, backlog B3a). */
export const DEFAULT_BIGDISK = join(homedir(), 'lattice-data');

/** Defaults from the environment (Electron loads lattice/.env first): LATTICE_SIDECAR_MOCK,
 *  LATTICE_SIDECAR_WORK, LATTICE_BIGDISK (else ~/lattice-data when that folder exists). */
export function sourcePrepConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env, fallbackBig = DEFAULT_BIGDISK): SourcePrepConfig {
  const big = env.LATTICE_BIGDISK || (existsSync(fallbackBig) ? fallbackBig : undefined);
  return {
    script: resolve(repoRoot, 'spikes', 'k_source_prep', 'run.sh'),
    // big audio and stems stay off the (small) root disk when the big disk is configured
    workDir: env.LATTICE_SIDECAR_WORK ?? (big ? join(big, 'out-k', 'app') : join(tmpdir(), 'lattice-sidecar')),
    ...(env.LATTICE_SIDECAR_MOCK ? { mockManifest: resolve(env.LATTICE_SIDECAR_MOCK) } : {}),
    ...(big ? { bigDisk: resolve(big) } : {}),
  };
}

const safeId = (id: string) => {
  if (!/^[\w.-]{1,80}$/.test(id)) throw new Error(`bad source id "${id}"`);
  return id;
};

export function audioPath(cfg: SourcePrepConfig, sourceId: string): string {
  return join(cfg.workDir, 'sources', `${safeId(sourceId)}.wav`);
}

export function putAudio(cfg: SourcePrepConfig, sourceId: string, wav: Uint8Array): string {
  const p = audioPath(cfg, sourceId);
  mkdirSync(join(cfg.workDir, 'sources'), { recursive: true });
  writeFileSync(p, wav);
  return p;
}

/** prep.py command-line options for the tool arguments. */
export function prepArgs(a: Omit<ExtractMidiArgs, 'sourceId'>): string[] {
  const out = ['--mode', a.mode, '--separate', a.separate, '--grid', a.grid];
  if (!a.keySnap) out.push('--no-key-snap');
  if (a.bpm) out.push('--bpm', String(a.bpm));
  return out;
}

export async function runSourcePrep(cfg: SourcePrepConfig, a: ExtractMidiArgs, timeoutMs = 10 * 60_000): Promise<PrepManifest> {
  if (cfg.mockManifest) {
    const m = JSON.parse(readFileSync(cfg.mockManifest, 'utf8')) as PrepManifest;
    return { ...m, dir: resolve(cfg.mockManifest, '..') };
  }
  const input = audioPath(cfg, a.sourceId);
  if (!existsSync(input)) throw new Error(`no audio for source ${a.sourceId} on the sidecar side (the renderer uploads it when the audio loads)`);
  if (!existsSync(cfg.script)) throw new Error(`source-prep sidecar not found at ${cfg.script}`);
  if (!cfg.bigDisk) throw new Error(`no folder for the Python envs: set LATTICE_BIGDISK in lattice/.env, or create ${DEFAULT_BIGDISK} (backlog B3a)`);
  const outDir = join(cfg.workDir, 'runs', `${safeId(a.sourceId)}-${Date.now().toString(36)}`);
  mkdirSync(outDir, { recursive: true });
  const { sourceId: _s, ...opts } = a;
  return new Promise((ok, fail) => {
    const p = spawn('bash', [cfg.script, input, outDir, ...prepArgs(opts)], { env: { ...process.env, LATTICE_BIGDISK: cfg.bigDisk }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), fail(e)));
    p.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('MANIFEST '));
      if (code !== 0 || !line) return fail(new Error(`source prep failed (exit ${code}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
      try {
        const m = JSON.parse(readFileSync(line.slice(9).trim(), 'utf8')) as PrepManifest;
        ok({ ...m, dir: outDir });
      } catch (e) {
        fail(e);
      }
    });
  });
}
