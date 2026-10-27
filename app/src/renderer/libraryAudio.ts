// Library audio in the renderer: decode-once cache, click-to-preview (like Logic's Loop
// Browser, a click plays the sound and a second click stops it), and the item being dragged
// (HTML5 drag data can't be read during dragover, so the drop indicator reads it from here).
import { getGlobalContext } from '@waveform-playlist/playout';
import type { Bridge } from '../core/bridge';
import type { LibraryEntry } from '../core/library';

const ctx = () => getGlobalContext().rawContext as unknown as AudioContext;
const cache = new Map<string, Promise<AudioBuffer>>();

export function libraryBuffer(bridge: Bridge, id: string): Promise<AudioBuffer> {
  let p = cache.get(id);
  if (!p) {
    p = bridge.loadLibraryAudio(id).then((bytes) => ctx().decodeAudioData(bytes));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

let current: { id: string; node: AudioBufferSourceNode } | null = null;

export function stopPreview(): void {
  if (!current) return;
  const { node } = current;
  current = null;
  try {
    node.stop();
  } catch {
    /* already stopped */
  }
}

/** Plays a library item; resolves when it ends or is stopped. */
export async function preview(bridge: Bridge, id: string, onEnd: () => void): Promise<void> {
  stopPreview();
  const c = ctx();
  if (c.state === 'suspended') await c.resume();
  const buffer = await libraryBuffer(bridge, id);
  stopPreview();
  const node = c.createBufferSource();
  const gain = c.createGain();
  gain.gain.value = 0.8;
  node.buffer = buffer;
  node.connect(gain).connect(c.destination);
  node.onended = () => {
    if (current?.node === node) current = null;
    onEnd();
  };
  current = { id, node };
  node.start();
}

export const LIBRARY_MIME = 'application/x-lattice-sound';

/** The library item currently being dragged (null otherwise). */
export const libraryDrag: { item: LibraryEntry | null } = { item: null };
