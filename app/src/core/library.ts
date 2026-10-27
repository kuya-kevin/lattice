// Sound library (pure, shared by the renderer, the Vite dev middleware and Electron main).
// Three sets: the Freesound instrument/drum set, the Freesound "producer material" set and
// the user's voice notes. Items come from the curated manifests; audio is fetched by item id
// through the bridge (Electron IPC) or the dev middleware (/api/library), never by raw path.

export type LibrarySet = 'freesound' | 'material' | 'voice_notes';

export interface LibraryItem {
  /** Stable id: "fs:858950", "mat:787821", "vn:new_recording_143". */
  id: string;
  set: LibrarySet;
  category: string; // e.g. "synth_lead", "dry_vocal", "voice_note"
  name: string;
  tags: string[];
  duration: number; // seconds
  /** Short licence name, e.g. "CC0-1.0", "CC-BY-4.0", "own recording". */
  license: string;
  licenseUrl?: string;
  author?: string;
  /** Page the sound came from (for attribution). */
  url?: string;
  description?: string;
  note?: string | null; // e.g. "F2"
  bpm?: number | null;
  /** Path of the audio file relative to the data directory (server side only uses it). */
  file: string;
}

/** What the renderer sees (the file path stays on the server side). */
export type LibraryEntry = Omit<LibraryItem, 'file'>;

export const SET_LABELS: Record<LibrarySet, string> = {
  freesound: 'Instruments & Drums',
  material: 'Producer Material',
  voice_notes: 'Voice Notes',
};

const CATEGORY_LABELS: Record<string, string> = {
  synth_lead: 'Synth Lead', synth_bass: 'Synth Bass', pad: 'Pad', pluck: 'Pluck', electric_piano: 'Electric Piano',
  piano_note: 'Piano', bell_mallet: 'Bells & Mallets', brass_stab: 'Brass', organ: 'Organ', strings_note: 'Strings',
  kick: 'Kick', snare: 'Snare', clap: 'Clap', closed_hat: 'Closed Hi-Hat', open_hat: 'Open Hi-Hat', percussion: 'Percussion',
  noise_vinyl: 'Noise & Vinyl', riser: 'Riser', phone_instrument: 'Phone Instrument', hum_whistle_beatbox: 'Hum, Whistle, Beatbox',
  layered_multi: 'Layered Idea', dry_vocal: 'Dry Vocal', drum_loop_live: 'Live Drum Loop', bass_keys_phrase: 'Bass & Keys Phrase',
  voice_note: 'Voice Note',
};

export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

/** Logic Loop Browser-style keyword buttons. Selected chips combine with AND, as in Logic. */
export interface Chip {
  id: string;
  label: string;
  test: (i: LibraryEntry) => boolean;
}

const inCats = (...cats: string[]) => (i: LibraryEntry) => cats.includes(i.category);
const hasTag = (re: RegExp) => (i: LibraryEntry) => i.tags.some((t) => re.test(t));

export const CHIPS: Chip[] = [
  { id: 'drums', label: 'Drums', test: (i) => inCats('kick', 'snare', 'clap', 'closed_hat', 'open_hat', 'percussion', 'drum_loop_live')(i) || hasTag(/^drums?$/i)(i) },
  { id: 'bass', label: 'Bass', test: (i) => inCats('synth_bass', 'bass_keys_phrase')(i) || hasTag(/^bass$/i)(i) },
  { id: 'synth', label: 'Synth', test: (i) => inCats('synth_lead', 'synth_bass', 'pad', 'pluck')(i) || hasTag(/^synth/i)(i) },
  { id: 'keys', label: 'Keys', test: (i) => inCats('electric_piano', 'piano_note', 'organ', 'bass_keys_phrase')(i) || hasTag(/^(piano|keys|organ)$/i)(i) },
  { id: 'vocal', label: 'Vocal', test: (i) => inCats('dry_vocal', 'hum_whistle_beatbox', 'voice_note')(i) || hasTag(/^(vocal|voice|singing)$/i)(i) },
  { id: 'fx', label: 'FX', test: inCats('noise_vinyl', 'riser') },
  { id: 'oneshot', label: 'One-shot', test: (i) => i.duration <= 3 },
  { id: 'phrase', label: 'Phrase / Loop', test: (i) => i.duration > 3 },
  { id: 'cc0', label: 'CC0 only', test: (i) => /^CC0/i.test(i.license) || i.set === 'voice_notes' },
];

export interface LibraryQuery {
  text?: string;
  set?: LibrarySet | 'all';
  category?: string | null;
  chips?: string[];
}

/** Text search over name, tags, category, author and note; every word must match somewhere. */
export function filterLibrary<T extends LibraryEntry>(items: T[], q: LibraryQuery): T[] {
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const chips = CHIPS.filter((c) => q.chips?.includes(c.id));
  return items.filter((i) => {
    if (q.set && q.set !== 'all' && i.set !== q.set) return false;
    if (q.category && i.category !== q.category) return false;
    if (!chips.every((c) => c.test(i))) return false;
    if (!words.length) return true;
    const hay = [i.name, ...i.tags, i.category, categoryLabel(i.category), i.author ?? '', i.note ?? ''].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Categories with counts, in manifest order, grouped by set (for the browse view). */
export function categoriesBySet(items: LibraryEntry[]): { set: LibrarySet; categories: { id: string; label: string; count: number }[] }[] {
  const out = new Map<LibrarySet, Map<string, number>>();
  for (const i of items) {
    const m = out.get(i.set) ?? new Map<string, number>();
    m.set(i.category, (m.get(i.category) ?? 0) + 1);
    out.set(i.set, m);
  }
  return [...out].map(([set, m]) => ({ set, categories: [...m].map(([id, count]) => ({ id, label: categoryLabel(id), count })) }));
}

/** TASL attribution (Title, Author, Source, License), as Creative Commons recommends. */
export function attribution(i: LibraryEntry): string {
  if (i.set === 'voice_notes') return `"${i.name}", own recording.`;
  const by = i.author ? ` by ${i.author}` : '';
  const src = i.url ? ` (${i.url})` : '';
  const lic = i.license.replace(/-(\d)/, ' $1');
  return `"${i.name}"${by}${src}, licensed under ${lic}${i.licenseUrl ? ` (${i.licenseUrl})` : ''}.`;
}

export const needsAttribution = (i: LibraryEntry) => /^CC-BY/i.test(i.license);

const LICENSE_SHORT = (name: string | undefined, url: string | undefined) => {
  if (name) return name;
  if (url?.includes('publicdomain/zero')) return 'CC0-1.0';
  const m = url?.match(/licenses\/([a-z-]+)\/([\d.]+)/);
  return m ? `CC-${m[1].toUpperCase()}-${m[2]}` : 'unknown';
};

const stripData = (p: string) => p.replace(/^\.?\/?data\//, '');
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const cleanText = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 280);

/** One entry of data/freesound/manifest.json or data/freesound_material/manifest.json. */
export function fromManifestEntry(set: 'freesound' | 'material', e: any): LibraryItem | null {
  const file = e.wav || e.mp3;
  if (!file || e.id == null) return null;
  return {
    id: `${set === 'freesound' ? 'fs' : 'mat'}:${e.id}`,
    set,
    category: String(e.category ?? 'other'),
    name: String(e.name ?? e.id),
    tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 12) : [],
    duration: num(e.trimmed_duration) ?? num(e.duration) ?? 0,
    license: LICENSE_SHORT(e.license_name, e.license),
    licenseUrl: e.license || undefined,
    author: e.username || undefined,
    url: e.url || undefined,
    description: cleanText(e.description) || undefined,
    note: e.f0_note ?? e.fs_note_name ?? null,
    bpm: num(e.fs_bpm) || null,
    file: stripData(String(file)),
  };
}

export function voiceNoteItem(fileName: string, duration: number): LibraryItem {
  const base = fileName.replace(/\.[^.]+$/, '');
  return {
    id: `vn:${base}`,
    set: 'voice_notes',
    category: 'voice_note',
    name: base.replace(/^new_recording_/, 'Voice note ').replace(/^vn-/, '').replace(/[-_]/g, ' '),
    tags: ['voice note'],
    duration,
    license: 'own recording',
    file: `voice_notes/${fileName}`,
  };
}
