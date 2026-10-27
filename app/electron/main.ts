// Electron main process: owns the session store, runs the Muse agent loop and Freesound
// search, so API keys never reach the renderer.
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { join, resolve } from 'node:path';
import { MuseAgent, type ChatFn } from '../src/core/agent';
import { searchFreesound } from '../src/core/freesound';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';
import { liveChat, loadEnv } from '../src/node/muse';

const appDir = app.getAppPath(); // .../lattice/app
loadEnv(resolve(appDir, '..', '.env'));

const store = new SessionStore();
const ctx: ToolContext = {
  store,
  sidecar: new StubSidecar(), // TODO(sidecar): swap for the Python sidecar
  searchFreesound: async (q, f, n) => {
    const token = process.env.FREESOUND_API_KEY;
    if (!token) throw new Error('FREESOUND_API_KEY is not set');
    return searchFreesound(token, q, f, n);
  },
};

let chat: ChatFn | null = null;
let agent: MuseAgent | null = null;
function getAgent(): MuseAgent {
  if (!agent) {
    chat = liveChat({ usageLog: join(appDir, 'logs', 'muse-usage.jsonl') });
    agent = new MuseAgent(ctx, chat);
  }
  return agent;
}

let win: BrowserWindow | null = null;
store.subscribe((s) => win?.webContents.send('session:changed', s));

ipcMain.handle('session:get', () => store.get());
ipcMain.handle('tool:run', (_e, name: string, args: Record<string, unknown>) => runTool(ctx, name, args, 'user'));
let busy = false;
ipcMain.handle('chat:send', async (_e, text: string) => {
  if (busy) return { ok: false, error: 'Muse is still working on the last message' };
  busy = true;
  try {
    return { ok: true, turn: await getAgent().send(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    busy = false;
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    title: 'Lattice',
    backgroundColor: '#111317',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(appDir, 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // allow the microphone for recording
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
