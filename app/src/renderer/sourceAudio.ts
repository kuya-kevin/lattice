// B11: keep each source's audio findable after a restart or a version restore. The main
// process remembers the imported file's path, the library id, or (recordings, files without a
// path) the bytes; after a restore, sources with no buffer are loaded again from there.
import { useEffect, useRef } from 'react';
import type { Bridge } from '../core/bridge';
import type { Session } from '../core/session';
import { encodeWav } from '../fx/engine/render';
import { buffers, decodeBytes } from './audio';

export type KeepAudio = Parameters<Bridge['keepSourceAudio']>[1] | 'encode' | 'none';

export function keepSourceAudio(bridge: Bridge, id: string, b: AudioBuffer, keep: KeepAudio): Promise<void> {
  if (keep === 'none') return Promise.resolve();
  const ref = keep === 'encode' ? { bytes: encodeWav(b).buffer as ArrayBuffer } : keep;
  return bridge.keepSourceAudio(id, ref);
}

/** An imported file by its path on disk (Electron), else by its bytes. */
export async function importRef(bridge: Bridge, file: File): Promise<KeepAudio> {
  const path = bridge.pathForFile?.(file);
  return path ? { path } : { bytes: await file.arrayBuffer() };
}

/** Load audio for sources that have none in this window (after a relaunch or a restore). */
export function useSourceAudioReload(bridge: Bridge, session: Session | null, addBuffer: (id: string, b: AudioBuffer, keep: KeepAudio) => void, onError: (msg: string) => void) {
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!session) return;
    for (const src of Object.values(session.sources)) {
      if (src.origin === 'generated' || buffers.has(src.id) || tried.current.has(src.id)) continue; // MIDI renders come from the notes
      tried.current.add(src.id);
      bridge
        .loadSourceAudio(src.id)
        .then(async (bytes) => bytes && addBuffer(src.id, await decodeBytes(bytes), 'none'))
        .catch((e) => onError(`Audio for "${src.name}" could not be loaded: ${e instanceof Error ? e.message : e}`));
    }
  }, [bridge, session, addBuffer, onError]);
}
