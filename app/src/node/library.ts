// Node side of the sound library: reads the manifests and voice notes from a data directory
// (the repo's data/ folder, or a small fixture folder in tests) and resolves item ids to
// files. Used by Electron main (IPC) and by the Vite dev middleware (/api/library).
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fromManifestEntry, voiceNoteItem, type LibraryItem } from '../core/library.ts';

/** Duration of a PCM/float WAV file from its header, or 0 if it can't be read. */
export function wavDuration(path: string): number {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let byteRate = 0;
    let pos = 12;
    while (pos + 8 <= n) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === 'fmt ') byteRate = head.readUInt32LE(pos + 16);
      if (id === 'data') {
        const total = statSync(path).size;
        const dataBytes = Math.min(size, total - pos - 8);
        return byteRate ? Math.round((dataBytes / byteRate) * 1000) / 1000 : 0;
      }
      pos += 8 + size + (size % 2);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readManifest(path: string): any[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export interface Library {
  dataDir: string;
  items: LibraryItem[];
  /** Absolute path of an item's audio file, or null for unknown ids / missing files. */
  pathOf(id: string): string | null;
}

export function loadLibrary(dataDir: string): Library {
  const root = resolve(dataDir);
  const items: LibraryItem[] = [];
  for (const [set, dir] of [['freesound', 'freesound'], ['material', 'freesound_material']] as const) {
    for (const e of readManifest(join(root, dir, 'manifest.json'))) {
      const item = fromManifestEntry(set, e);
      if (item && existsSync(join(root, item.file))) items.push(item);
    }
  }
  const vnDir = join(root, 'voice_notes');
  if (existsSync(vnDir)) {
    for (const f of readdirSync(vnDir).sort()) {
      if (extname(f).toLowerCase() !== '.wav') continue;
      const d = wavDuration(join(vnDir, f));
      if (d > 0) items.push(voiceNoteItem(f, d));
    }
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    dataDir: root,
    items,
    pathOf(id) {
      const item = byId.get(id);
      if (!item) return null;
      const p = resolve(root, item.file);
      return p.startsWith(root + sep) && existsSync(p) ? p : null; // never leave the data dir
    },
  };
}

export const audioMime = (path: string) => (extname(path).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav');
