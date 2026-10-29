// Sound library: manifest parsing (via the node loader on the small fixture), search,
// filter chips, category browse, attribution, and the edit key commands.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attribution, categoriesBySet, filterLibrary, fromManifestEntry, needsAttribution, type LibraryEntry } from '../src/core/library';
import { loadLibrary, wavDuration } from '../src/node/library';
import { editShortcutFor } from '../src/renderer/shortcuts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/library');
const lib = loadLibrary(FIXTURE);
const ids = (xs: LibraryEntry[]) => xs.map((x) => x.id);

describe('library loader', () => {
  it('reads both manifests and the voice notes', () => {
    expect(ids(lib.items)).toEqual(['fs:101', 'fs:102', 'fs:103', 'fs:104', 'mat:201', 'mat:202', 'vn:new_recording_900']);
    const vn = lib.items.find((i) => i.set === 'voice_notes')!;
    expect(vn).toMatchObject({ name: 'Voice note 900', category: 'voice_note', license: 'own recording' });
    expect(vn.duration).toBeCloseTo(3, 2);
  });

  it('maps manifest fields and strips the data/ prefix from paths', () => {
    expect(lib.items[1]).toMatchObject({ name: 'Fixture Sub Bass', license: 'CC-BY-4.0', author: 'bass_maker', note: 'E1', file: 'freesound/audio/synth_bass/102.wav' });
    expect(fromManifestEntry('material', { id: 5, name: 'x', license: 'http://creativecommons.org/licenses/by/3.0/', mp3: 'data/a/b.mp3' })).toMatchObject({ id: 'mat:5', license: 'CC-BY-3.0', file: 'a/b.mp3' });
    expect(fromManifestEntry('freesound', { name: 'no id or file' })).toBeNull();
  });

  it('resolves ids to files inside the data dir only', () => {
    expect(lib.pathOf('fs:103')).toBe(resolve(FIXTURE, 'freesound/audio/kick/103.wav'));
    expect(lib.pathOf('fs:999')).toBeNull();
    expect(lib.pathOf('../../etc/passwd')).toBeNull();
    expect(wavDuration(resolve(FIXTURE, 'freesound/audio/kick/103.wav'))).toBeCloseTo(0.4, 3);
  });

  it('returns an empty library for a missing data dir', () => {
    expect(loadLibrary(resolve(FIXTURE, 'nope')).items).toEqual([]);
  });
});

describe('library search and filters', () => {
  const items = lib.items;
  it('searches name, tags, category and author; all words must match', () => {
    expect(ids(filterLibrary(items, { text: 'kick' }))).toEqual(['fs:103']);
    expect(ids(filterLibrary(items, { text: 'drummer loop' }))).toEqual(['mat:202']);
    expect(ids(filterLibrary(items, { text: 'sub bass' }))).toEqual(['fs:102']);
    expect(ids(filterLibrary(items, { text: 'hi-hat' }))).toEqual(['fs:104']); // category label
    expect(filterLibrary(items, { text: 'zzz' })).toEqual([]);
  });

  it('combines chips with AND, like Logic keyword buttons', () => {
    expect(ids(filterLibrary(items, { chips: ['drums'] }))).toEqual(['fs:103', 'fs:104', 'mat:202']);
    expect(ids(filterLibrary(items, { chips: ['drums', 'oneshot'] }))).toEqual(['fs:103', 'fs:104']);
    expect(ids(filterLibrary(items, { chips: ['drums', 'cc0'] }))).toEqual(['fs:104', 'mat:202']);
    expect(ids(filterLibrary(items, { chips: ['vocal'] }))).toEqual(['mat:201', 'vn:new_recording_900']);
    expect(ids(filterLibrary(items, { chips: ['bass', 'synth'] }))).toEqual(['fs:102']);
  });

  it('filters by set and category', () => {
    expect(ids(filterLibrary(items, { set: 'material' }))).toEqual(['mat:201', 'mat:202']);
    expect(ids(filterLibrary(items, { set: 'all', category: 'kick' }))).toEqual(['fs:103']);
    expect(ids(filterLibrary(items, { set: 'voice_notes', text: 'kick' }))).toEqual([]);
  });

  it('groups categories by set with counts', () => {
    const g = categoriesBySet(items);
    expect(g.map((x) => x.set)).toEqual(['freesound', 'material', 'voice_notes']);
    expect(g[0].categories[0]).toEqual({ id: 'synth_lead', label: 'Synth Lead', count: 1 });
  });

  it('builds a TASL credit line and flags CC-BY', () => {
    const bass = items.find((i) => i.id === 'fs:102')!;
    expect(needsAttribution(bass)).toBe(true);
    expect(attribution(bass)).toBe('"Fixture Sub Bass" by bass_maker (https://freesound.org/people/bass_maker/sounds/102/), licensed under CC-BY 4.0 (http://creativecommons.org/licenses/by/4.0/).');
    expect(needsAttribution(items[0])).toBe(false);
    expect(attribution(items[6])).toBe('"Voice note 900", own recording.');
  });
});

describe('edit key commands', () => {
  const k = (key: string, o: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; tag: string }> = {}) => ({
    key, shiftKey: !!o.shiftKey, metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey, altKey: false,
    target: o.tag ? ({ tagName: o.tag.toUpperCase(), isContentEditable: false } as unknown as EventTarget) : null,
  });
  it('maps undo/redo, delete, O, B and Cmd-G', () => {
    expect(editShortcutFor(k('z', { metaKey: true }))).toBe('undo');
    expect(editShortcutFor(k('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(editShortcutFor(k('z', { ctrlKey: true }))).toBe('undo');
    expect(editShortcutFor(k('Backspace'))).toBe('deleteClip');
    expect(editShortcutFor(k('o'))).toBe('toggleLibrary');
    expect(editShortcutFor(k('l'))).toBe('toggleLibrary');
    expect(editShortcutFor(k('b'))).toBe('toggleSmartControls');
    expect(editShortcutFor(k('g', { metaKey: true }))).toBe('toggleSnap');
    expect(editShortcutFor(k(' '))).toBeNull(); // transport keys stay with the control bar
    expect(editShortcutFor(k('z', { metaKey: true, tag: 'input' }))).toBeNull();
    expect(editShortcutFor(k('Backspace', { tag: 'textarea' }))).toBeNull();
  });
});
