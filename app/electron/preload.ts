import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import type { Bridge } from '../src/core/bridge';

const toArrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const bridge: Bridge = {
  mode: 'electron',
  getSession: () => ipcRenderer.invoke('session:get'),
  onSession: (cb) => {
    const listener = (_e: unknown, s: any) => cb(s);
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  },
  runTool: (name, args) => ipcRenderer.invoke('tool:run', name, args),
  sendChat: (text) => ipcRenderer.invoke('chat:send', text),
  transcribe: (wav) => ipcRenderer.invoke('stt:transcribe', new Uint8Array(wav)), // B2
  listLibrary: () => ipcRenderer.invoke('library:list'),
  loadLibraryAudio: async (id) => {
    const bytes: Uint8Array = await ipcRenderer.invoke('library:audio', id);
    return toArrayBuffer(bytes);
  },
  putSourceAudio: (id, wav) => ipcRenderer.invoke('source:put', id, new Uint8Array(wav)), // [S3 midi]
  // B11
  keepSourceAudio: (id, ref) => ipcRenderer.invoke('source:keep', id, 'bytes' in ref ? { bytes: new Uint8Array(ref.bytes) } : ref),
  loadSourceAudio: async (id) => {
    const bytes: Uint8Array | null = await ipcRenderer.invoke('source:load', id);
    return bytes && toArrayBuffer(bytes);
  },
  // B9: main asks (measure:req), the renderer renders and measures, and answers (measure:res)
  serveMeasure: (fn) => {
    ipcRenderer.removeAllListeners('measure:req');
    ipcRenderer.on('measure:req', async (_e, reqId: number, session, trackId: string) => {
      try {
        ipcRenderer.send('measure:res', reqId, { ok: true, result: await fn(session, trackId) });
      } catch (e) {
        ipcRenderer.send('measure:res', reqId, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
  // B17/B18: main asks (render:req), the renderer renders (render:res), as for measure
  serveRender: (fn) => {
    ipcRenderer.removeAllListeners('render:req');
    ipcRenderer.on('render:req', async (_e, reqId: number, session, job) => {
      try {
        ipcRenderer.send('render:res', reqId, { ok: true, result: await fn(session, job) });
      } catch (e) {
        ipcRenderer.send('render:res', reqId, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
  listShelf: () => ipcRenderer.invoke('shelf:list'), // B17
  onShelf: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('shelf:changed', listener);
    return () => ipcRenderer.removeListener('shelf:changed', listener);
  },
  loadShelfAudio: async (id) => toArrayBuffer(await ipcRenderer.invoke('shelf:audio', id)),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
};

contextBridge.exposeInMainWorld('lattice', bridge);
