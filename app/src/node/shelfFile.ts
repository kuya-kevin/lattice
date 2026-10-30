// B17 sound shelves on disk, under userData/shelf:
//   index.json          the items (Starred and My Sounds)
//   <id>.wav            the sound (exports, starred session sounds; library items have none)
//   <id>.source.wav     an export's audio before the effects (its recipe; the chain is in index.json)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemorySoundShelf, type ShelfItem } from '../core/shelf';

const fileOf = (id: string, part: 'sound' | 'source') => `${id.replace(/[^\w-]/g, '_')}${part === 'source' ? '.source' : ''}.wav`;

export class FileSoundShelf extends MemorySoundShelf {
  constructor(private dir: string) {
    super(readIndex(join(dir, 'index.json')));
  }

  protected override changed() {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'index.json');
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, items: this.items }, null, 2));
    renameSync(`${file}.tmp`, file);
    super.changed();
  }

  // removed items keep their files: a sound taken off a shelf by mistake can still be found
  protected override storeAudio(id: string, part: 'sound' | 'source', bytes: Uint8Array) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, fileOf(id, part)), bytes);
  }

  protected override readAudio(id: string, part: 'sound' | 'source'): Uint8Array | null {
    const p = join(this.dir, fileOf(id, part));
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }

  /** Where a shelf sound's WAV is on disk (null if it has none). */
  pathOf(id: string): string | null {
    const p = join(this.dir, fileOf(id, 'sound'));
    return existsSync(p) ? p : null;
  }
}

function readIndex(file: string): ShelfItem[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data?.items) ? data.items : [];
  } catch (e) {
    console.warn(`sound shelf: could not read ${file}: ${(e as Error).message}`);
    return [];
  }
}
