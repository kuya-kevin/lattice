// Bundles the Electron main + preload scripts to dist-electron/*.cjs with esbuild.
import { build } from 'esbuild';

export async function buildElectron({ watch = false } = {}) {
  const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' };
  await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
  await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
}

if (import.meta.url === `file://${process.argv[1]}`) await buildElectron();
