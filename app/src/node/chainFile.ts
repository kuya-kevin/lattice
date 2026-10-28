// Saved device chains on disk (B10): one JSON file, read once, rewritten on every save.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryChainLibrary, type SavedChain } from '../fx/savedChains';

export class FileChainLibrary extends MemoryChainLibrary {
  constructor(private file: string) {
    super(readChains(file));
  }

  override save(chain: SavedChain): boolean {
    const replaced = super.save(chain);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ version: 1, chains: this.chains }, null, 2));
    return replaced;
  }
}

function readChains(file: string): SavedChain[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data?.chains) ? data.chains : [];
  } catch (e) {
    console.warn(`saved chains: could not read ${file}: ${(e as Error).message}`);
    return [];
  }
}
