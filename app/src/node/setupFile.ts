// The producer's setups on disk (Oct 30): one JSON file in userData with the setups, what Lattice
// has seen at each Save and the "learn after" setting; read once, rewritten on every change
// (like chains.json, node/chainFile.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySetupLibrary, type SetupState } from '../core/setups';

export class FileSetupLibrary extends MemorySetupLibrary {
  constructor(private file: string) {
    super(readState(file));
  }

  protected override changed() {
    if (!this.file) return; // the base constructor's own writes, before this.file is set
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ version: 2, ...this.state }, null, 2));
  }
}

function readState(file: string): Partial<SetupState> {
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return {
      setups: Array.isArray(data?.setups) ? data.setups : [],
      seen: Array.isArray(data?.seen) ? data.seen : [],
      declined: Array.isArray(data?.declined) ? data.declined : [],
      ...(typeof data?.learnAfter === 'number' ? { learnAfter: data.learnAfter } : {}),
    };
  } catch (e) {
    console.warn(`setups: could not read ${file}: ${(e as Error).message}`);
    return {};
  }
}
