// The producer's setups on disk (Oct 30): one JSON file in userData, read once, rewritten on
// every change (like chains.json, node/chainFile.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySetupLibrary, type Setup } from '../core/setups';

export class FileSetupLibrary extends MemorySetupLibrary {
  constructor(private file: string) {
    super(readSetups(file));
  }

  override save(setup: Setup): boolean {
    const replaced = super.save(setup);
    this.write();
    return replaced;
  }

  override remove(name: string): boolean {
    const had = super.remove(name);
    this.write();
    return had;
  }

  private write() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ version: 1, setups: this.setups }, null, 2));
  }
}

function readSetups(file: string): Setup[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data?.setups) ? data.setups : [];
  } catch (e) {
    console.warn(`setups: could not read ${file}: ${(e as Error).message}`);
    return [];
  }
}
