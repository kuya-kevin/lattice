import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from '../src/core/bridge';

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
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  },
  putSourceAudio: (id, wav) => ipcRenderer.invoke('source:put', id, new Uint8Array(wav)), // [S3 midi]
};

contextBridge.exposeInMainWorld('lattice', bridge);
