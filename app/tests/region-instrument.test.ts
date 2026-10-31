// set_region_instrument (Oct 30: "can a MIDI region be turned into a different sound?"): the
// region's notes stay, the instrument changes: piano, built-in drums, a session sound as a
// sampler, a library sound, or a sample pad.
import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '../src/core/library';
import type { MidiNote } from '../src/core/midi';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { museSummary, museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const pluck: LibraryEntry = { id: 'fs:7', set: 'freesound', category: 'pluck', name: 'Glass pluck', tags: [], duration: 1.5, license: 'CC0' } as LibraryEntry;
const ctx = (): ToolContext => ({
  store: new SessionStore(),
  sidecar: new StubSidecar(),
  searchFreesound: async () => ({ count: 0, results: [] }),
  listLibrary: async () => [pluck],
  adoptAudio: () => {},
});
const note = (pitch: number, start: number): MidiNote => ({ pitch, start, duration: 0.25, velocity: 100 });

async function take(c: ToolContext) {
  await runTool(c, 'add_sound', { source_id: 's-bell', name: 'Bell', duration: 2, origin: 'record' }, 'user');
  const [s1, t] = S.addTrack(c.store.get(), 'Keys');
  const [s2, clip] = S.addMidiClip(s1, t.id, { name: 'MIDI take 1', midi: { instrument: 'piano', notes: [note(60, 0), note(64, 0.5), note(36, 1)] }, sourceDuration: 2 });
  c.store.set(S.select({ ...s2, tracks: s2.tracks.map((x) => (x.id === t.id ? { ...x, clips: x.clips.map((k) => (k.id === clip.id ? { ...k, key: 'C major' } : k)) } : x)) }, t.id, clip.id));
  return clip.id;
}
const midiOf = (c: ToolContext, id: string) => S.findClip(c.store.get(), id).clip.midi!;

describe('set_region_instrument', () => {
  it('is a Muse tool', () => {
    expect(museToolSpecs().map((t) => t.function.name)).toContain('set_region_instrument');
  });

  it('an Ideas sound plays the selected region as a sampler; its notes and key stay; undoable', async () => {
    const c = ctx();
    const id = await take(c);
    const notes = midiOf(c, id).notes;
    const r = await runTool(c, 'set_region_instrument', { source_id: 's-bell' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { clip_id: id, instrument: 'Bell', was: 'piano', source_id: 's-bell' } });
    expect(midiOf(c, id)).toEqual({ instrument: 'Bell', sample: { sourceId: 's-bell', offset: 0, duration: 2, root: 60 }, notes });
    expect(S.findClip(c.store.get(), id).clip.key).toBe('C major');
    expect(museSummary(c)).toContain('Bell');
    c.store.undo();
    expect(midiOf(c, id).instrument).toBe('piano');
  });

  it('a library sound is loaded first; a sample pad and the built-ins work too', async () => {
    const c = ctx();
    const id = await take(c);
    const lib = await runTool(c, 'set_region_instrument', { clip_id: id, library_id: 'fs:7' }, 'muse');
    expect(lib.result).toMatchObject({ instrument: 'Glass pluck' });
    expect(c.store.get().sources[(lib.result as { source_id: string }).source_id]).toMatchObject({ name: 'Glass pluck', origin: 'freesound' });

    const kit = (await runTool(c, 'create_kit', { name: 'Lo-fi' }, 'user')).result as { kit_id: string };
    const k = await runTool(c, 'set_region_instrument', { clip_id: id, kit_id: kit.kit_id }, 'muse');
    expect(k.result).toMatchObject({ instrument: 'Lo-fi', notes_not_on_a_pad: 2 }); // C4 and E4; C2 is the kick pad
    expect(midiOf(c, id)).toMatchObject({ drum: true, kit: kit.kit_id });

    const p = await runTool(c, 'set_region_instrument', { clip_id: id, instrument: 'piano' }, 'muse');
    expect(p.result).toMatchObject({ instrument: 'piano', note: expect.stringMatching(/pitches/) });
    expect(midiOf(c, id)).toEqual({ instrument: 'piano', notes: midiOf(c, id).notes });
    await runTool(c, 'set_region_instrument', { clip_id: id, instrument: 'drums' }, 'user');
    expect(midiOf(c, id)).toMatchObject({ instrument: 'drums', drum: true });
  });

  it('needs exactly one instrument and a MIDI region', async () => {
    const c = ctx();
    const id = await take(c);
    expect((await runTool(c, 'set_region_instrument', { clip_id: id }, 'muse')).error).toMatch(/one of/);
    expect((await runTool(c, 'set_region_instrument', { clip_id: id, instrument: 'piano', kit_id: 'k1' }, 'muse')).error).toMatch(/one of/);
    expect((await runTool(c, 'set_region_instrument', { clip_id: id, source_id: S.findClip(c.store.get(), id).clip.sourceId }, 'muse')).error).toMatch(/MIDI clip, not audio/);
    const [s, a] = S.addClip(c.store.get(), 't1', 's-bell', 4);
    c.store.set(s);
    expect((await runTool(c, 'set_region_instrument', { clip_id: a.id, instrument: 'piano' }, 'muse')).error).toMatch(/audio/);
  });
});
