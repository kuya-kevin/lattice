// Dev: Vite dev server for the renderer + Electron pointed at it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { buildElectron } from './build-electron.mjs';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
await buildElectron();
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
