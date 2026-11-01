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
  /** "pitched", "drum", "texture" (Freesound set), "voice"; single sounds unless "phrase" */
  kind?: string;
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
  /** keep only sounds that fit the project's key and tempo (fitsProject) */
  fits?: ProjectFit | null;
}

// ---- "Fits this project": key and tempo matching ----

export interface ProjectFit {
  key: string | null; // canonical session key, e.g. "G minor"
  tempo: number | null;
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]; // natural minor

/** Pitch class of a note name like "F#2", "Bb1", "C" (0-11), or null. */
export function pitchClass(note: string): number | null {
  const m = note.trim().match(/^([A-Ga-g])(#|♯|b|♭)?-?\d*$/);
  if (!m) return null;
  return (PC[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12;
}

/** The 7 pitch classes of a key like "G minor" or "Eb major", or null. */
export function scaleOf(key: string): Set<number> | null {
  const m = key.match(/^(\S+)\s+(major|minor)$/);
  const tonic = m && pitchClass(m[1]);
  if (tonic == null) return null;
  return new Set((m![2] === 'minor' ? MINOR_STEPS : MAJOR_STEPS).map((x) => (x + tonic) % 12));
}

/** A single sound (a note, a hit) has no tempo of its own: Freesound's bpm estimate on one is noise. */
const isPhrase = (i: LibraryEntry) => i.kind === 'phrase' || (i.set !== 'freesound' && i.duration > 3);

/** Tempos within 4% count as the same, and half or double time fits too. */
export function tempoFits(bpm: number, tempo: number): boolean {
  return [0.5, 1, 2].some((k) => Math.abs((bpm * k) / tempo - 1) <= 0.04);
}

/** Whether a sound fits the project. Pitched sounds with a known note must be in the key;
 *  phrases with a known tempo must match it (or half/double). Anything we can't measure
 *  (drums, textures, unknown note or tempo, no project key) fits. */
export function fitsProject(i: LibraryEntry, p: ProjectFit): boolean {
  if (p.key && i.kind === 'pitched' && i.note) {
    const scale = scaleOf(p.key);
    const pc = pitchClass(i.note);
    if (scale && pc != null && !scale.has(pc)) return false;
  }
  if (p.tempo && i.bpm && isPhrase(i) && !tempoFits(i.bpm, p.tempo)) return false;
  return true;
}

/** The tempo to show for a sound: only phrases have one. */
export const phraseBpm = (i: LibraryEntry) => (i.bpm && isPhrase(i) ? i.bpm : null);

/** Text search over name, tags, category, author and note; every word must match somewhere. */
export function filterLibrary<T extends LibraryEntry>(items: T[], q: LibraryQuery): T[] {
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const chips = CHIPS.filter((c) => q.chips?.includes(c.id));
  return items.filter((i) => {
    if (q.set && q.set !== 'all' && i.set !== q.set) return false;
    if (q.category && i.category !== q.category) return false;
    if (!chips.every((c) => c.test(i))) return false;
    if (q.fits && !fitsProject(i, q.fits)) return false;
    if (!words.length) return true;
    const hay = [i.name, ...i.tags, i.category, categoryLabel(i.category), i.author ?? '', i.note ?? ''].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Categories in manifest order, grouped by set (for the browse view): how many sounds each
 *  has, and how many of them pass `keep` (e.g. fit the project; all of them by default). */
export function categoriesBySet(
  items: LibraryEntry[],
  keep: (i: LibraryEntry) => boolean = () => true,
): { set: LibrarySet; categories: { id: string; label: string; count: number; total: number }[] }[] {
  const out = new Map<LibrarySet, Map<string, { count: number; total: number }>>();
  for (const i of items) {
    const m = out.get(i.set) ?? new Map<string, { count: number; total: number }>();
    const c = m.get(i.category) ?? { count: 0, total: 0 };
    c.total++;
    if (keep(i)) c.count++;
    m.set(i.category, c);
    out.set(i.set, m);
  }
  return [...out].map(([set, m]) => ({ set, categories: [...m].map(([id, c]) => ({ id, label: categoryLabel(id), ...c })) }));
}

/** Recently used sounds, newest first, no repeats. */
export function pushRecent(ids: string[], id: string, max = 20): string[] {
  return [id, ...ids.filter((x) => x !== id)].slice(0, max);
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
    ...(e.kind ? { kind: String(e.kind) } : {}),
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
    kind: 'voice',
    file: `voice_notes/${fileName}`,
  };
}

/** A sound's name without its file extension ("Airy Pad.wav" -> "Airy Pad"), as Muse quotes it. */
export const soundName = (name: string) => name.replace(/\.(wav|mp3|aiff?|flac|ogg|m4a)$/i, '');

// ---- sounds Muse mentions in chat (clickable, they open the library on that sound) ----

export interface FoundSound {
  library_id: string;
  name: string;
  note?: string;
}

/** The library sounds a Muse turn found (find_library_sounds results), in order, once each. */
export function soundsFromSteps(steps: { tool: string; outcome: { ok: boolean; result?: unknown } }[]): FoundSound[] {
  const out = new Map<string, FoundSound>();
  for (const s of steps) {
    if (s.tool !== 'find_library_sounds' || !s.outcome.ok) continue;
    const sounds = (s.outcome.result as { sounds?: FoundSound[] } | undefined)?.sounds ?? [];
    for (const x of sounds) {
      if (x?.library_id && x.name && !out.has(x.library_id)) out.set(x.library_id, { library_id: x.library_id, name: x.name, ...(x.note ? { note: x.note } : {}) });
    }
  }
  return [...out.values()];
}

/** Split a reply into plain text and sound names (case-insensitive, whole words, longest
 *  name first so "Pad dot wav" wins over "Pad"). */
export function linkSoundNames(text: string, sounds: FoundSound[]): ({ text: string } | { text: string; id: string })[] {
  const named = sounds.filter((s) => s.name.trim().length >= 3).sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return [{ text }];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byName = new Map(named.map((s) => [s.name.toLowerCase(), s.library_id]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${named.map((s) => esc(s.name)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const out: ({ text: string } | { text: string; id: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], id: byName.get(m[0].toLowerCase())! });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

export type ReplyPart = { text: string } | { text: string; id: string } | { list: { text: string; id: string }[] };

/** Runs of 3+ sound names separated only by commas, "and" or "or" become one list (shown as
 *  rows, not a wall of comma-separated links); the full stop that ended the run is dropped. */
export function groupSoundRuns(parts: ({ text: string } | { text: string; id: string })[]): ReplyPart[] {
  const SEP = /^\s*(,|;|,?\s*(and|or)\b)?\s*$/i;
  const out: ReplyPart[] = [];
  let i = 0;
  while (i < parts.length) {
    const run: { text: string; id: string }[] = [];
    let j = i;
    while (j < parts.length && 'id' in parts[j]) {
      run.push(parts[j] as { text: string; id: string });
      if (j + 2 < parts.length && !('id' in parts[j + 1]) && SEP.test(parts[j + 1].text) && 'id' in parts[j + 2]) j += 2;
      else {
        j++;
        break;
      }
    }
    if (run.length >= 3) {
      out.push({ list: run });
      const next = parts[j];
      if (next && !('id' in next)) {
        const rest = next.text.replace(/^[.;,]?\s*/, '');
        if (rest) out.push({ text: rest });
        j++;
      }
      i = j;
    } else {
      out.push(parts[i]);
      i++;
    }
  }
  return out;
}
