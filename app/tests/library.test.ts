// Sound library: manifest parsing (via the node loader on the small fixture), search,
// filter chips, category browse, attribution, and the edit key commands.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attribution, categoriesBySet, filterLibrary, fitsProject, fromManifestEntry, groupSoundRuns, linkSoundNames, needsAttribution, soundsFromSteps, pitchClass, pushRecent, scaleOf, tempoFits, type LibraryEntry } from '../src/core/library';
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
    expect(g[0].categories[0]).toEqual({ id: 'synth_lead', label: 'Synth Lead', count: 1, total: 1 });
    // with a filter, count is how many pass (shown as "n of total")
    const kept = categoriesBySet(items, (i) => i.id !== 'fs:101');
    expect(kept[0].categories[0]).toEqual({ id: 'synth_lead', label: 'Synth Lead', count: 0, total: 1 });
  });

  it('reads note names and keys', () => {
    expect(['C3', 'F#2', 'Bb1', 'G♯', 'e-1', 'H2'].map(pitchClass)).toEqual([0, 6, 10, 8, 4, null]);
    expect([...scaleOf('A minor')!].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect([...scaleOf('Eb major')!].sort((a, b) => a - b)).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(scaleOf('nonsense')).toBeNull();
  });

  it('fits the project: pitched notes in the key, phrases near the tempo, the rest always', () => {
    const base = { set: 'freesound' as const, tags: [], license: 'CC0-1.0' };
    const note = (n: string, bpm: number | null = 150): LibraryEntry => ({ ...base, id: n, category: 'pad', kind: 'pitched', name: n, note: n, bpm, duration: 2 });
    const p = { key: 'G minor', tempo: 90 };
    expect(fitsProject(note('Bb2'), p)).toBe(true);
    expect(fitsProject(note('B2'), p)).toBe(false);
    expect(fitsProject(note('B2'), { key: null, tempo: 90 })).toBe(true); // no key: nothing to check
    expect(fitsProject({ ...note('B2'), kind: 'drum' }, p)).toBe(true); // a kick's "note" doesn't count
    expect(fitsProject({ ...note('B2'), note: null }, p)).toBe(true);
    // Freesound's bpm on a single note is noise; a phrase's tempo counts, half/double time too
    const phrase = (bpm: number): LibraryEntry => ({ ...base, id: `p${bpm}`, set: 'material', category: 'drum_loop_live', name: 'loop', bpm, duration: 8 });
    expect(fitsProject(phrase(91), p)).toBe(true);
    expect(fitsProject(phrase(180), p)).toBe(true);
    expect(fitsProject(phrase(120), p)).toBe(false);
    expect(tempoFits(46, 90)).toBe(true);
    expect(tempoFits(100, 90)).toBe(false);
    expect(filterLibrary([note('B2'), note('D3'), phrase(120)], { fits: p }).map((i) => i.id)).toEqual(['D3']);
  });

  it('keeps recent sounds newest first, without repeats, up to a limit', () => {
    let r: string[] = [];
    for (const id of ['a', 'b', 'c', 'a']) r = pushRecent(r, id, 3);
    expect(r).toEqual(['a', 'c', 'b']);
    expect(pushRecent(r, 'd', 3)).toEqual(['d', 'a', 'c']);
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

describe('sound names in Muse replies', () => {
  const found = (result: unknown, ok = true, tool = 'find_library_sounds') => ({ tool, outcome: ok ? { ok, result } : { ok } });
  it('collects the sounds a turn found, once each, in order', () => {
    const steps = [
      found({ sounds: [{ library_id: 'fs:1', name: 'Airy Pad' }, { library_id: 'fs:2', name: 'Pad dot wav' }] }),
      found({ sounds: [{ library_id: 'fs:2', name: 'Pad dot wav' }, { library_id: 'fs:3', name: 'Deep Pads 25' }] }),
      found({ sounds: [{ library_id: 'fs:9', name: 'nope' }] }, false),
      found({ summary: 'x' }, true, 'list_tracks'),
    ];
    expect(soundsFromSteps(steps).map((x) => x.library_id)).toEqual(['fs:1', 'fs:2', 'fs:3']);
  });

  it('links names in the reply: whole words, any case, the longest name first', () => {
    const sounds = [{ library_id: 'a', name: 'Pad' }, { library_id: 'b', name: 'Pad dot wav' }, { library_id: 'c', name: 'Bass Hit 29_1' }];
    const parts = linkSoundNames('Pads: pad dot wav, Pad and Bass Hit 29_1. Padding.', sounds);
    expect(parts.filter((p) => 'id' in p)).toEqual([
      { text: 'pad dot wav', id: 'b' },
      { text: 'Pad', id: 'a' },
      { text: 'Bass Hit 29_1', id: 'c' },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('Pads: pad dot wav, Pad and Bass Hit 29_1. Padding.');
    expect(linkSoundNames('no sounds', [])).toEqual([{ text: 'no sounds' }]);
  });

  it('turns a run of 3+ names into one list; shorter mentions stay inline', () => {
    const sounds = ['Airy Pad', 'Orion Pad', 'Deep Pad', 'FM Strings', 'Big Kick'].map((name, i) => ({ library_id: `p${i}`, name }));
    const reply = 'Pads: Airy Pad, Orion Pad, Deep Pad and FM Strings.\n\nTry Airy Pad or Big Kick.';
    const g = groupSoundRuns(linkSoundNames(reply, sounds));
    expect(g).toEqual([
      { text: 'Pads: ' },
      { list: [{ text: 'Airy Pad', id: 'p0' }, { text: 'Orion Pad', id: 'p1' }, { text: 'Deep Pad', id: 'p2' }, { text: 'FM Strings', id: 'p3' }] },
      { text: 'Try ' },
      { text: 'Airy Pad', id: 'p0' },
      { text: ' or ' },
      { text: 'Big Kick', id: 'p4' },
      { text: '.' },
    ]);
    // a sentence between names breaks the run
    expect(groupSoundRuns(linkSoundNames('Airy Pad is soft, but Orion Pad, Deep Pad', sounds)).some((p) => 'list' in p)).toBe(false);
  });
});
