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
  pathForFile: (file) => webUtils.getPathForFile(file),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
};

contextBridge.exposeInMainWorld('lattice', bridge);
