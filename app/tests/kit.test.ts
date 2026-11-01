// B12 drum pads: kits on the session, the pad tools, takes recorded on a kit, and what Muse sees.
import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '../src/core/library';
import { DEFAULT_PADS, PAD_COUNT, padForKey, padForNote } from '../src/core/kit';
import { StubSidecar } from '../src/core/sidecar';
import { summarize } from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

async function withSounds() {
  const c = ctx();
  await runTool(c, 'add_sound', { source_id: 's-kick', name: 'Dusty kick', duration: 0.4, origin: 'freesound' }, 'user');
  await runTool(c, 'add_sound', { source_id: 's-snare', name: 'Tight snare', duration: 0.3, origin: 'freesound' }, 'user');
  return c;
}

describe('drum pad layout', () => {
  it('has 9 pads on Q W E / A S D / Z X C with distinct GM notes', () => {
    expect(PAD_COUNT).toBe(9);
    expect(['KeyQ', 'KeyE', 'KeyZ', 'KeyC'].map(padForKey)).toEqual([0, 2, 6, 8]);
    expect(padForKey('KeyR')).toBe(-1); // R stays Record
    expect(new Set(DEFAULT_PADS.map((p) => p.note)).size).toBe(9);
    expect(DEFAULT_PADS[6]).toEqual({ label: 'Kick', note: 36 });
    expect(DEFAULT_PADS[7]).toEqual({ label: 'Snare', note: 38 });
  });
});

describe('kit tools', () => {
  it('creates a kit, puts sounds on pads, and Muse sees it; undo takes a pad back off', async () => {
    const c = await withSounds();
    const made = await runTool(c, 'create_kit', { name: 'Lo-fi kit' }, 'user');
    expect(made.ok).toBe(true);
    const kitId = (made.result as any).kit_id;
    expect(c.store.get().kits![kitId].pads).toHaveLength(9);

    expect((await runTool(c, 'set_pad', { kit_id: kitId, pad: 6, source_id: 's-kick' }, 'user')).ok).toBe(true);
    expect((await runTool(c, 'set_pad', { kit_id: kitId, pad: 7, source_id: 's-snare', label: 'Snap' }, 'user')).ok).toBe(true);
    const kit = c.store.get().kits![kitId];
    expect(kit.pads[6].sample).toEqual({ sourceId: 's-kick', offset: 0, duration: 0.4, root: 36 });
    expect(kit.pads[7].label).toBe('Snap');
    expect(kit.pads[6].label).toBe('Dusty kick'); // a pad with its default name takes the sound's
    expect(padForNote(kit, 38)?.sample?.sourceId).toBe('s-snare');

    const sum = summarize(c.store.get());
    expect(sum).toContain(`${kitId} "Lo-fi kit": Z dusty kick(36)=Dusty kick, X snap(38)=Tight snare; 7 empty`);

    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().kits![kitId].pads[7].sample).toBeUndefined();
  });

  it('refuses bad pads and unknown sounds', async () => {
    const c = await withSounds();
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    expect((await runTool(c, 'set_pad', { kit_id: kitId, pad: 9, source_id: 's-kick' }, 'user')).error).toMatch(/pad must be 0-8/);
    expect((await runTool(c, 'set_pad', { kit_id: kitId, pad: 0, source_id: 'nope' }, 'user')).error).toMatch(/no source/);
    expect((await runTool(c, 'set_pad', { kit_id: 'k9', pad: 0, source_id: 's-kick' }, 'user')).error).toMatch(/no kit/);
  });

  it('records a take on a kit as a drum clip that names the kit', async () => {
    const c = await withSounds();
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    await runTool(c, 'set_pad', { kit_id: kitId, pad: 6, source_id: 's-kick' }, 'user');
    await runTool(c, 'add_track', { name: 'Drums' }, 'user');
    const notes = [
      { pitch: 36, velocity: 100, start: 0, duration: 0.1 },
      { pitch: 38, velocity: 100, start: 0.5, duration: 0.1 },
    ];
    const r = await runTool(c, 'record_midi', { track_id: 't2', start: 1, duration: 1, notes, kit_id: kitId }, 'user');
    expect(r.ok).toBe(true);
    const midi = c.store.get().tracks[0].clips[0].midi!;
    expect(midi).toMatchObject({ drum: true, kit: kitId, instrument: 'Sample pad 1' });
    expect(summarize(c.store.get())).toContain(`MIDI drums on kit ${kitId}, 2 hits (kick 1, snare 1, hat 0)`);
  });

  it('deleting a sound empties its pads; deleting the kit keeps the takes on built-in drums', async () => {
    const c = await withSounds();
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    await runTool(c, 'set_pad', { kit_id: kitId, pad: 6, source_id: 's-kick' }, 'user');
    await runTool(c, 'add_track', {}, 'user');
    await runTool(c, 'record_midi', { track_id: 't2', start: 0, duration: 1, notes: [{ pitch: 36, velocity: 100, start: 0, duration: 0.1 }], kit_id: kitId }, 'user');

    await runTool(c, 'delete_sound', { source_id: 's-kick' }, 'user');
    expect(c.store.get().kits![kitId].pads[6]).toEqual({ label: 'Kick', note: 36 });

    expect((await runTool(c, 'delete_kit', { kit_id: kitId }, 'user')).ok).toBe(true);
    const s = c.store.get();
    expect(s.kits).toEqual({});
    expect(s.tracks[0].clips[0].midi).toMatchObject({ drum: true });
    expect(s.tracks[0].clips[0].midi!.kit).toBeUndefined();
  });

  it('Muse can call the kit tools', () => {
    const names = museToolSpecs().map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['create_kit', 'set_pad', 'clear_pad', 'rename_pad', 'rename_kit', 'delete_kit']));
  });

  it('place_kit puts an empty region on the kit, on a new track named after it', async () => {
    const c = await withSounds();
    const kitId = ((await runTool(c, 'create_kit', { name: 'Chops' }, 'user')).result as any).kit_id;
    const r = await runTool(c, 'place_kit', { kit_id: kitId, start: 2 }, 'muse');
    expect(r.ok).toBe(true);
    const s = c.store.get();
    const t = s.tracks.find((x) => x.id === (r.result as any).track_id)!;
    expect(t.name).toBe('Chops');
    expect(t.clips[0]).toMatchObject({ name: 'Chops', start: 2, duration: 4, midi: { drum: true, kit: kitId, notes: [] } }); // 2 bars at 120
    expect(s.selection.clipId).toBe(t.clips[0].id);
    expect((await runTool(c, 'place_kit', { kit_id: kitId, track_id: 'nope' }, 'user')).error).toMatch(/no track/);
  });

  it('pads take any sound and can be renamed; a renamed pad keeps its name through new sounds', async () => {
    const c = await withSounds();
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    expect(c.store.get().kits![kitId].name).toBe('Sample pad 1');
    const pad = (i: number) => c.store.get().kits![kitId].pads[i];
    await runTool(c, 'set_pad', { kit_id: kitId, pad: 0, source_id: 's-kick' }, 'user');
    expect(pad(0).label).toBe('Dusty kick');
    await runTool(c, 'set_pad', { kit_id: kitId, pad: 0, source_id: 's-snare' }, 'user');
    expect(pad(0).label).toBe('Tight snare'); // still named after its sound: follows the new one
    await runTool(c, 'clear_pad', { kit_id: kitId, pad: 0 }, 'user');
    expect(pad(0)).toEqual({ label: 'Crash', note: 49 });

    const r = await runTool(c, 'rename_pad', { kit_id: kitId, pad: 0, label: '  Vox chop ' }, 'user');
    expect(r).toMatchObject({ ok: true, result: { label: 'Vox chop' } });
    await runTool(c, 'set_pad', { kit_id: kitId, pad: 0, source_id: 's-kick' }, 'user');
    expect(pad(0).label).toBe('Vox chop');
    await runTool(c, 'clear_pad', { kit_id: kitId, pad: 0 }, 'user');
    expect(pad(0).label).toBe('Vox chop');
    expect((await runTool(c, 'rename_pad', { kit_id: kitId, pad: 0, label: ' ' }, 'user')).error).toMatch(/cannot be empty/);
    expect(c.store.takeUserEdits()).toContain(`renamed pad 0 of ${kitId} to "Vox chop"`);
  });
});

// B12b: Muse fills a kit from the library (sounds not in the session yet)
describe('Muse fills a kit from the library', () => {
  const lib: LibraryEntry[] = [
    { id: 'fs:1', set: 'freesound', category: 'kick', name: 'Dusty vinyl kick', tags: ['kick', 'lofi', 'dusty'], duration: 0.5, license: 'CC0-1.0' },
    { id: 'fs:2', set: 'freesound', category: 'kick', name: 'Clean 909 kick', tags: ['kick', '909'], duration: 0.4, license: 'CC0-1.0' },
    { id: 'fs:3', set: 'freesound', category: 'snare', name: 'Crusty snare', tags: ['snare', 'lofi'], duration: 0.3, license: 'CC-BY-4.0', author: 'tapes', url: 'https://freesound.org/s/3/' },
    { id: 'fs:4', set: 'freesound', category: 'closed_hat', name: 'Tape hat', tags: ['hat'], duration: 0.2, license: 'CC0-1.0' },
    ...['C3', 'D3', 'F#2', 'Bb2', 'G1', 'A2', 'E3', 'C#3', 'D2', 'F2'].map((note, n) => ({
      id: `fs:pad${n}`, set: 'freesound' as const, category: 'pad', kind: 'pitched', name: `Pad ${note}`, tags: ['pad'], duration: 2, license: 'CC0-1.0', note, bpm: 140,
    })),
  ];
  function libCtx() {
    const adopted: [string, unknown][] = [];
    const c: ToolContext = { ...ctx(), listLibrary: async () => lib, adoptAudio: (id, ref) => void adopted.push([id, ref]) };
    return { c, adopted };
  }

  it('finds library sounds by words and by category, and Muse can call it', async () => {
    const { c } = libCtx();
    expect(museToolSpecs().map((t) => t.function.name)).toEqual(expect.arrayContaining(['find_library_sounds', 'fill_kit']));
    const words = await runTool(c, 'find_library_sounds', { query: 'lofi' }, 'muse');
    expect((words.result as any).sounds.map((x: any) => x.library_id)).toEqual(['fs:1', 'fs:3']);
    const cat = await runTool(c, 'find_library_sounds', { category: 'kick' }, 'muse');
    expect((cat.result as any).count).toBe(2);
    expect((cat.result as any).sounds[0]).toMatchObject({ name: 'Dusty vinyl kick', category: 'Kick', license: 'CC0-1.0' });
    expect((await runTool(c, 'find_library_sounds', {}, 'muse')).ok).toBe(false);
  });

  it('lists a whole category ("what pads do we have") and filters by the project key or another key', async () => {
    const { c } = libCtx();
    const all = (await runTool(c, 'find_library_sounds', { category: 'pad' }, 'muse')).result as any;
    expect(all.count).toBe(10);
    expect(all.sounds).toHaveLength(10); // a category lists them all, not the first 8
    expect(all.sounds[0]).not.toHaveProperty('bpm'); // a single note has no tempo
    lib.push({ id: 'fs:wav', set: 'freesound', category: 'riser', name: 'Big Riser.wav', tags: [], duration: 4, license: 'CC0-1.0' });
    expect(((await runTool(c, 'find_library_sounds', { category: 'riser' }, 'muse')).result as any).sounds[0].name).toBe('Big Riser'); // quoted as a link
    lib.pop();
    expect((await runTool(c, 'find_library_sounds', { category: 'pad', fits_project: true }, 'muse')).error).toMatch(/no key/);
    await runTool(c, 'set_key', { key: 'G major' }, 'user');
    const inG = (await runTool(c, 'find_library_sounds', { category: 'pad', fits_project: true }, 'muse')).result as any;
    expect(inG.fits).toBe('G major, 120 BPM');
    expect(inG.sounds.map((x: any) => x.note)).toEqual(['C3', 'D3', 'F#2', 'G1', 'A2', 'E3', 'D2']);
    const inDm = (await runTool(c, 'find_library_sounds', { category: 'pad', key: 'Dm' }, 'muse')).result as any;
    expect(inDm.sounds.map((x: any) => x.note)).toEqual(['C3', 'D3', 'Bb2', 'G1', 'A2', 'E3', 'D2', 'F2']);
    const kicks = (await runTool(c, 'find_library_sounds', { category: 'kick', key: 'Dm' }, 'muse')).result as any;
    expect(kicks.count).toBe(2); // drums always fit
    const few = (await runTool(c, 'find_library_sounds', { category: 'pad', max_results: 3 }, 'muse')).result as any;
    expect(few.more).toMatch(/^7 more/);
    expect((await runTool(c, 'find_library_sounds', { category: 'pad', key: 'H minor' }, 'muse')).ok).toBe(false);
  });

  it('makes and fills a kit in one undo step; library sounds join Ideas with their credit and audio', async () => {
    const { c, adopted } = libCtx();
    const r = await runTool(c, 'fill_kit', { name: 'Dusty lo-fi', pads: [{ pad: 6, library_id: 'fs:1' }, { pad: 7, library_id: 'fs:3' }, { pad: 2, library_id: 'fs:4', label: 'Tape hat' }] }, 'muse');
    expect(r.ok).toBe(true);
    const s = c.store.get();
    const kit = Object.values(s.kits!)[0];
    expect(kit.name).toBe('Dusty lo-fi');
    expect([6, 7, 2].map((i) => s.sources[kit.pads[i].sample!.sourceId].name)).toEqual(['Dusty vinyl kick', 'Crusty snare', 'Tape hat']);
    expect(kit.pads[6].label).toBe('Dusty vinyl kick'); // a default-named pad takes the sound's name
    expect(adopted.map(([, ref]) => ref)).toEqual([{ library: 'fs:1' }, { library: 'fs:3' }, { library: 'fs:4' }]);
    expect(adopted.map(([id]) => id)).toEqual([6, 7, 2].map((i) => kit.pads[i].sample!.sourceId));
    const snare = s.sources[kit.pads[7].sample!.sourceId];
    expect(snare).toMatchObject({ origin: 'freesound' });
    expect(snare.credit).toContain('tapes');
    expect(s.sources[kit.pads[6].sample!.sourceId].credit).toBeUndefined(); // CC0
    expect(summarize(s)).toContain('Z dusty vinyl kick(36)=Dusty vinyl kick');

    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().kits ?? {}).toEqual({});
    expect(Object.keys(c.store.get().sources)).toHaveLength(3); // undo keeps sounds in Ideas (store.ts: audio stays loaded)
  });

  it('fills an existing kit, mixing library and session sounds; refuses bad input before loading audio', async () => {
    const { c, adopted } = libCtx();
    await runTool(c, 'add_sound', { source_id: 's-clap', name: 'My clap', duration: 0.3 }, 'user');
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    const r = await runTool(c, 'fill_kit', { kit_id: kitId, pads: [{ pad: 3, source_id: 's-clap' }, { pad: 6, library_id: 'fs:2' }] }, 'muse');
    expect(r.ok).toBe(true);
    expect((r.result as any).created).toBeUndefined();
    expect(Object.keys(c.store.get().kits!)).toEqual([kitId]);

    const n = adopted.length;
    expect((await runTool(c, 'fill_kit', { kit_id: kitId, pads: [{ pad: 1, library_id: 'fs:99' }] }, 'muse')).error).toMatch(/no library sound/);
    expect((await runTool(c, 'fill_kit', { kit_id: 'k99', pads: [{ pad: 1, library_id: 'fs:1' }] }, 'muse')).error).toMatch(/no kit/);
    expect((await runTool(c, 'fill_kit', { kit_id: kitId, pads: [{ pad: 1, library_id: 'fs:1', source_id: 's-clap' }] }, 'muse')).error).toMatch(/one of them/);
    expect((await runTool(c, 'fill_kit', { kit_id: kitId, pads: [{ pad: 1, library_id: 'fs:1' }, { pad: 1, library_id: 'fs:2' }] }, 'muse')).error).toMatch(/each pad once/);
    expect(adopted.length).toBe(n);
  });

  it('set_pad takes a library sound too', async () => {
    const { c } = libCtx();
    const kitId = ((await runTool(c, 'create_kit', {}, 'user')).result as any).kit_id;
    const r = await runTool(c, 'set_pad', { kit_id: kitId, pad: 7, library_id: 'fs:3' }, 'muse');
    expect(r.result).toMatchObject({ label: 'Crusty snare', sound: 'Crusty snare' });
    expect((await runTool(c, 'set_pad', { kit_id: kitId, pad: 7 }, 'muse')).error).toMatch(/source_id or library_id/);
  });
});
