// B17 sound shelves: Starred (sounds starred from the library, Ideas or pads) and My Sounds
// (the user's recordings and exported sounds). They live outside the session and span
// projects: Electron keeps them in userData/shelf (node/shelfFile.ts), the web build and tests
// in memory (as saved chains do, fx/savedChains.ts).
import type { ParamValues } from '../fx/catalog';

export type ShelfName = 'starred' | 'mine';
export const SHELF_LABELS: Record<ShelfName, string> = { starred: 'Starred', mine: 'My Sounds' };

export interface ShelfItem {
  id: string; // "sh-…"
  shelf: ShelfName;
  name: string;
  duration: number; // seconds
  addedAt: string; // ISO time
  /** where it came from: a library item, an Ideas sound, a pad, an export or a recording */
  from: 'library' | 'idea' | 'pad' | 'export' | 'recording';
  /** a library item's id: its audio comes from the library, nothing is copied */
  library?: string;
  /** the session source it was starred from (that project only; marks its star in Ideas) */
  sourceId?: string;
  credit?: string;
  /** an exported sound remembers how it was made: the audio before the effects (kept beside
   *  the WAV) and the track's device chain, so it can be reopened and changed */
  recipe?: { trackName: string; devices: { kind: string; on: boolean; params: ParamValues }[]; sourceDuration: number };
}

export type NewShelfItem = Omit<ShelfItem, 'id' | 'addedAt'>;

export interface SoundShelf {
  /** newest first */
  list(shelf?: ShelfName): ShelfItem[];
  get(id: string): ShelfItem | undefined;
  /** `audio`: the sound's WAV (none for library items); `recipeAudio`: the audio before the effects */
  add(item: NewShelfItem, audio?: Uint8Array, recipeAudio?: Uint8Array): ShelfItem;
  remove(id: string): ShelfItem | undefined;
  /** Give a shelf sound a new name (its audio stays where it is). */
  rename(id: string, name: string): ShelfItem | undefined;
  audio(id: string): Uint8Array | null;
  recipeAudio(id: string): Uint8Array | null;
  subscribe(fn: () => void): () => void;
}

const newId = () => `sh-${Math.random().toString(36).slice(2, 10)}`;

export class MemorySoundShelf implements SoundShelf {
  protected items: ShelfItem[];
  private bytes = new Map<string, Uint8Array>();
  private listeners = new Set<() => void>();

  constructor(initial: ShelfItem[] = []) {
    this.items = initial;
  }

  list(shelf?: ShelfName): ShelfItem[] {
    return [...this.items].reverse().filter((i) => !shelf || i.shelf === shelf);
  }

  get(id: string): ShelfItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  add(item: NewShelfItem, audio?: Uint8Array, recipeAudio?: Uint8Array): ShelfItem {
    const full: ShelfItem = { ...item, id: newId(), addedAt: new Date().toISOString() };
    if (audio) this.storeAudio(full.id, 'sound', audio);
    if (recipeAudio) this.storeAudio(full.id, 'source', recipeAudio);
    this.items = [...this.items, full];
    this.changed();
    return full;
  }

  remove(id: string): ShelfItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    this.items = this.items.filter((i) => i.id !== id);
    this.changed();
    return item;
  }

  rename(id: string, name: string): ShelfItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    const renamed = { ...item, name };
    this.items = this.items.map((i) => (i.id === id ? renamed : i));
    this.changed();
    return renamed;
  }

  audio(id: string): Uint8Array | null {
    return this.readAudio(id, 'sound');
  }

  recipeAudio(id: string): Uint8Array | null {
    return this.readAudio(id, 'source');
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected changed() {
    for (const l of this.listeners) l();
  }

  protected storeAudio(id: string, part: 'sound' | 'source', bytes: Uint8Array) {
    this.bytes.set(`${id}:${part}`, bytes);
  }

  protected readAudio(id: string, part: 'sound' | 'source'): Uint8Array | null {
    return this.bytes.get(`${id}:${part}`) ?? null;
  }
}

/** The context's shelf, or an in-memory one created on first use (tests, scenarios). */
export function soundShelf(ctx: { shelf?: SoundShelf }): SoundShelf {
  return (ctx.shelf ??= new MemorySoundShelf());
}

/** Every word must appear in the name, origin, shelf or credit. */
export function findOnShelf(items: ShelfItem[], query = ''): ShelfItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    const hay = [i.name, i.from, SHELF_LABELS[i.shelf], i.shelf, i.credit ?? '', i.recipe?.trackName ?? ''].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** One line for Muse's session summary (empty when both shelves are empty). */
export function shelvesLine(shelf: SoundShelf): string {
  const part = (s: ShelfName) => {
    const items = shelf.list(s);
    if (!items.length) return null;
    const names = items.slice(0, 8).map((i) => `${i.id} "${i.name}"`).join(', ');
    return `${SHELF_LABELS[s]}: ${names}${items.length > 8 ? ` (+${items.length - 8} more, find_sound_in_shelf)` : ''}`;
  };
  const parts = [part('starred'), part('mine')].filter(Boolean);
  return parts.length ? `Shelves (across projects; use_shelf_sound brings one in): ${parts.join('; ')}` : '';
}
