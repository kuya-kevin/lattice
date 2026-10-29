import { createReadStream, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { audioMime, loadLibrary, type Library } from './src/node/library.ts';
import { putAudio, runSourcePrep, sourcePrepConfig } from './src/node/sourcePrep.ts';
import { runAnalysis, runEngineer } from './src/node/engineer.ts';
import { config as loadDotenv } from 'dotenv';
import { transcriberFromEnv } from './src/node/stt.ts';
import type { Transcribe } from './src/core/stt.ts';

/** [S3 midi] dev:web stand-in for the Electron sidecar IPC: POST /api/sidecar/extract-midi?args=<json>
 *  with the source's WAV as the body -> the prep.py manifest (or $LATTICE_SIDECAR_MOCK's). */
function sidecarMiddleware(): Plugin {
  const cfg = sourcePrepConfig(resolve(import.meta.dirname, '..'));
  return {
    name: 'lattice-sidecar',
    configureServer(server) {
      server.middlewares.use('/api/sidecar/extract-midi', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            if (req.method !== 'POST') throw new Error('POST only');
            const args = JSON.parse(new URL(req.url ?? '/', 'http://x').searchParams.get('args') ?? '{}');
            if (!cfg.mockManifest) putAudio(cfg, args.sourceId, Buffer.concat(chunks));
            res.end(JSON.stringify(await runSourcePrep(cfg, args)));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });
      // B3: POST /api/sidecar/engineer?args=<EngineerJob json> with the source's WAV -> the processed
      // WAV, with the result JSON in the X-Lattice-Result header ($LATTICE_ENGINEER_MOCK=1: input unchanged)
      server.middlewares.use('/api/sidecar/engineer', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            if (req.method !== 'POST') throw new Error('POST only');
            const job = JSON.parse(new URL(req.url ?? '/', 'http://x').searchParams.get('args') ?? '{}');
            putAudio(cfg, job.sourceId, Buffer.concat(chunks));
            const { result, wav } = await runEngineer(cfg, job, { mock: process.env.LATTICE_ENGINEER_MOCK === '1' });
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('X-Lattice-Result', encodeURIComponent(JSON.stringify(result)));
            res.end(Buffer.from(wav));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });
      // B13: POST /api/sidecar/analyze?args={"op":"hits"|"regions","sourceId"} with the source's WAV
      // -> the hit list or the sound regions
      server.middlewares.use('/api/sidecar/analyze', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            if (req.method !== 'POST') throw new Error('POST only');
            const { op, sourceId } = JSON.parse(new URL(req.url ?? '/', 'http://x').searchParams.get('args') ?? '{}');
            const run = runAnalysis[op as keyof typeof runAnalysis];
            if (!run) throw new Error(`unknown analysis ${op}`);
            putAudio(cfg, sourceId, Buffer.concat(chunks));
            res.end(JSON.stringify(await run(cfg, sourceId, { mock: process.env.LATTICE_ENGINEER_MOCK === '1' })));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });
    },
  };
}

/** B2: dev:web stand-in for the Electron transcription IPC: POST /api/stt with a push-to-talk
 *  WAV -> { text } from Muse Voice Transcribe ($LATTICE_STT_MOCK: fixed text, no call). */
function sttMiddleware(): Plugin {
  let transcribe: Transcribe | null = null;
  // the key is loaded on the first clip, not when the config loads (Vitest reads this file too)
  const get = () => (transcribe ??= (loadDotenv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true }), transcriberFromEnv(process.env, resolve(import.meta.dirname, 'logs', 'muse-usage.jsonl'))));
  return {
    name: 'lattice-stt',
    configureServer(server) {
      server.middlewares.use('/api/stt', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            if (req.method !== 'POST') throw new Error('POST only');
            res.end(JSON.stringify({ text: (await get()(new Uint8Array(Buffer.concat(chunks)))).text }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });
    },
  };
}

/** dev:web stand-in for the Electron library IPC: GET /api/library (item list) and
 *  GET /api/library/audio/<id> (the file). Data dir: $LATTICE_DATA_DIR, else ../data. */
function libraryMiddleware(): Plugin {
  const dataDir = process.env.LATTICE_DATA_DIR ? resolve(process.env.LATTICE_DATA_DIR) : resolve(import.meta.dirname, '..', 'data');
  let lib: Library | null = null;
  const get = () => (lib ??= loadLibrary(dataDir));
  return {
    name: 'lattice-library',
    configureServer(server) {
      server.middlewares.use('/api/library', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/' || url.pathname === '') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(get().items.map(({ file: _f, ...rest }) => rest)));
          return;
        }
        const m = url.pathname.match(/^\/audio\/(.+)$/);
        const path = m ? get().pathOf(decodeURIComponent(m[1])) : null;
        if (!path) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', audioMime(path));
        createReadStream(path).pipe(res);
      });
    },
  };
}

// node_modules may be a symlink (git worktrees share the main checkout's); let Vite serve
// files from its real location (the recording AudioWorklet is loaded from there).
const realNodeModules = (() => {
  try {
    return realpathSync(resolve(import.meta.dirname, 'node_modules'));
  } catch {
    return resolve(import.meta.dirname, 'node_modules');
  }
})();

export default defineConfig({
  plugins: [react(), libraryMiddleware(), sidecarMiddleware(), sttMiddleware()],
  base: './', // so the built page loads from file:// in Electron
  server: { port: 5199, strictPort: false, fs: { allow: [searchForWorkspaceRoot(process.cwd()), realNodeModules] } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'] },
});
