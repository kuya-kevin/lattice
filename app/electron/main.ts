// Electron main process: owns the session store, runs the Muse agent loop and Freesound
// search, so API keys never reach the renderer.
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MuseAgent, type ChatFn } from '../src/core/agent';
import { searchFreesound } from '../src/core/freesound';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';
import { FileChainLibrary } from '../src/node/chainFile';
import { FileVersionLibrary, loadAutosave, SessionAutosave, SourceAudioFiles } from '../src/node/projectFiles';
import { loadLibrary, type Library } from '../src/node/library';
import { liveChat, loadEnv } from '../src/node/muse';
import { putAudio, runSourcePrep, sourcePrepConfig } from '../src/node/sourcePrep'; // [S3 midi]
import { runEngineer } from '../src/node/engineer'; // B3
import type { ExtractMidiArgs, QuantizeDrumsArgs } from '../src/core/sidecar';
import type { Features } from '../src/core/ears';
import type { Session } from '../src/core/session';

const appDir = app.getAppPath(); // .../lattice/app
loadEnv(resolve(appDir, '..', '.env'));
// tests point this at a fresh folder so each launch starts clean
if (process.env.LATTICE_USER_DATA) app.setPath('userData', resolve(process.env.LATTICE_USER_DATA));
const projectDir = join(app.getPath('userData'), 'project'); // B11: autosave, versions, audio refs

// [S3 midi] extract_midi, and (B3) cleanup_noise / quantize_drums, run the Python sidecar as a
// child process; the synth and MRT2 methods are still stubs. Processed audio is kept under its
// new source id, where the renderer loads it (source:load).
const prepCfg = sourcePrepConfig(resolve(appDir, '..'));
const engineerMock = { mock: process.env.LATTICE_ENGINEER_MOCK === '1' };
class AppSidecar extends StubSidecar {
  override extractMidi(a: ExtractMidiArgs) {
    return runSourcePrep(prepCfg, a);
  }
  override async cleanupNoise(a: { sourceId: string; newSourceId: string }) {
    const { result, wav } = await runEngineer(prepCfg, { op: 'cleanup', sourceId: a.sourceId }, engineerMock);
    sourceAudio.keep(a.newSourceId, { bytes: wav });
    return result;
  }
  override async quantizeDrums({ newSourceId, ...a }: QuantizeDrumsArgs) {
    const { result, wav } = await runEngineer(prepCfg, { op: 'quantize', ...a }, engineerMock);
    sourceAudio.keep(newSourceId, { bytes: wav });
    return result;
  }
}
ipcMain.handle('source:put', (_e, id: string, bytes: Uint8Array) => {
  putAudio(prepCfg, String(id), bytes);
});

// B11: the open session comes back on launch and is written after each change
const store = new SessionStore(loadAutosave(join(projectDir, 'session.json')) ?? undefined);
const autosave = new SessionAutosave(join(projectDir, 'session.json'), store);
app.on('before-quit', () => autosave.dispose());
const sourceAudio = new SourceAudioFiles(join(projectDir, 'audio'));

const ctx: ToolContext = {
  store,
  sidecar: new AppSidecar(), // TODO(sidecar): the synth and MRT2 methods are stubs
  searchFreesound: async (q, f, n) => {
    const token = process.env.FREESOUND_API_KEY;
    if (!token) throw new Error('FREESOUND_API_KEY is not set');
    return searchFreesound(token, q, f, n);
  },
  chains: new FileChainLibrary(join(app.getPath('userData'), 'chains.json')), // B10
  versions: new FileVersionLibrary(join(projectDir, 'versions')), // B11
  measureTrack: (session, trackId) => askRenderer(session, trackId), // B9
};

// B9: measure_track renders in the renderer, which holds the audio; ask it and wait for the answer
let measureSeq = 0;
const measureWaits = new Map<number, (r: { ok: boolean; result?: any; error?: string }) => void>();
ipcMain.on('measure:res', (_e, reqId: number, r) => measureWaits.get(reqId)?.(r));
function askRenderer(session: Session, trackId: string): Promise<{ wet: Features; dry: Features }> {
  if (!win) return Promise.reject(new Error('no window to render in'));
  const reqId = ++measureSeq;
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => (measureWaits.delete(reqId), fail(new Error('measuring timed out after 60 s'))), 60_000);
    measureWaits.set(reqId, (r) => {
      clearTimeout(timer);
      measureWaits.delete(reqId);
      if (r.ok) ok(r.result);
      else fail(new Error(r.error));
    });
    win!.webContents.send('measure:req', reqId, session, trackId);
  });
}

let chat: ChatFn | null = null;
let agent: MuseAgent | null = null;
function getAgent(): MuseAgent {
  if (!agent) {
    chat = liveChat({ usageLog: join(appDir, 'logs', 'muse-usage.jsonl') });
    agent = new MuseAgent(ctx, chat);
  }
  return agent;
}

// Sound library: manifests + voice notes under the repo's data/ (or $LATTICE_DATA_DIR).
let library: Library | null = null;
const getLibrary = () => (library ??= loadLibrary(process.env.LATTICE_DATA_DIR ?? resolve(appDir, '..', 'data')));
ipcMain.handle('library:list', () => getLibrary().items.map(({ file: _f, ...rest }) => rest));
ipcMain.handle('library:audio', async (_e, id: string) => {
  const path = getLibrary().pathOf(String(id));
  if (!path) throw new Error(`unknown library item ${id}`);
  return new Uint8Array(await readFile(path));
});

// B11: where each source's audio is, so a restored session can load it again
ipcMain.handle('source:keep', (_e, id: string, ref: { path: string } | { library: string } | { bytes: Uint8Array }) => sourceAudio.keep(String(id), ref));
ipcMain.handle('source:load', async (_e, id: string) => {
  const ref = sourceAudio.ref(String(id));
  if (!ref) return null;
  if ('library' in ref) {
    const path = getLibrary().pathOf(ref.library);
    if (!path) throw new Error(`library item ${ref.library} is gone`);
    return new Uint8Array(await readFile(path));
  }
  const bytes = sourceAudio.read(String(id));
  if (!bytes) throw new Error('path' in ref ? `file not found: ${ref.path}` : 'kept audio file is missing');
  return bytes;
});

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
  win.on('close', () => autosave.flush()); // B11: don't wait out the debounce when closing
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // allow the microphone for recording
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
