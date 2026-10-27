import { createReadStream, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { audioMime, loadLibrary, type Library } from './src/node/library.ts';

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
  plugins: [react(), libraryMiddleware()],
  base: './', // so the built page loads from file:// in Electron
  server: { port: 5199, strictPort: false, fs: { allow: [searchForWorkspaceRoot(process.cwd()), realNodeModules] } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'] },
});
