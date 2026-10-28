// Saved device chains (B10): a named copy of a track's devices and knob values, to load
// onto any track later. The library lives outside the session (it spans projects): Electron
// keeps it in a JSON file in userData (node/chainFile.ts); web and tests keep it in memory.
import type { ParamValues } from './catalog';

export interface SavedChain {
  name: string;
  devices: { kind: string; on: boolean; params: ParamValues }[];
  savedAt: string; // ISO time
}

export interface ChainLibrary {
  list(): SavedChain[];
  get(name: string): SavedChain | undefined;
  /** Adds or overwrites by name; returns true if a chain with that name was replaced. */
  save(chain: SavedChain): boolean;
}

export class MemoryChainLibrary implements ChainLibrary {
  protected chains: SavedChain[];

  constructor(initial: SavedChain[] = []) {
    this.chains = initial;
  }

  list(): SavedChain[] {
    return this.chains;
  }

  get(name: string): SavedChain | undefined {
    return this.chains.find((c) => c.name === name);
  }

  save(chain: SavedChain): boolean {
    const replaced = this.chains.some((c) => c.name === chain.name);
    this.chains = [...this.chains.filter((c) => c.name !== chain.name), chain].sort((a, b) => a.name.localeCompare(b.name));
    return replaced;
  }
}

/** The context's library, or an in-memory one created on first use (tests, scenarios). */
export function chainLibrary(ctx: { chains?: ChainLibrary }): ChainLibrary {
  return (ctx.chains ??= new MemoryChainLibrary());
}
