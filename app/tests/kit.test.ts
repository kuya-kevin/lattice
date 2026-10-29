// B12 drum pads: kits on the session, the pad tools, takes recorded on a kit, and what Muse sees.
import { describe, expect, it } from 'vitest';
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
