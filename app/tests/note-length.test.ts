// set_note_length (Oct 30: Muse said "I can't stretch MIDI notes longer with my current tools").
import { describe, expect, it } from 'vitest';
import type { MidiNote } from '../src/core/midi';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const ctx = (): ToolContext => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) });
const note = (pitch: number, start: number, duration = 0.2): MidiNote => ({ pitch, start, duration, velocity: 100 });

function midiClip(c: ToolContext, notes: MidiNote[], sourceDuration = 4) {
  const s0 = { ...c.store.get(), tempo: 120 }; // a beat is 0.5 s, a 4/4 bar 2 s
  const [s1, t] = S.addTrack(s0, 'Keys');
  const [s2, clip] = S.addMidiClip(s1, t.id, { name: 'Keys', midi: { instrument: 'piano', notes }, sourceDuration, start: 0 });
  c.store.set(S.select(s2, t.id, clip.id));
  return { clip, track: t };
}
const lengths = (c: ToolContext, id: string) => S.findClip(c.store.get(), id).clip.midi!.notes.map((n) => n.duration);

describe('set_note_length', () => {
  it('is a Muse tool', () => {
    expect(museToolSpecs().map((t) => t.function.name)).toContain('set_note_length');
  });

  it('beats: every note a bar long; notes past the region end are counted', async () => {
    const c = ctx();
    const { clip } = midiClip(c, [note(60, 0), note(64, 1), note(67, 3)]);
    const r = await runTool(c, 'set_note_length', { beats: 4 }, 'muse'); // the selected region
    expect(r).toMatchObject({ ok: true, result: { changed: 3, seconds: 2, cut_off_by_region_end: 1 } });
    expect(lengths(c, clip.id)).toEqual([2, 2, 2]);
    expect(c.store.canUndo()).toBe(true);
  });

  it('scale and legato, on chosen notes', async () => {
    const c = ctx();
    const { clip } = midiClip(c, [note(60, 0), note(64, 0), note(67, 1), note(72, 1.5)]);
    await runTool(c, 'set_note_length', { clip_id: clip.id, scale: 2, notes: [3] }, 'muse');
    expect(lengths(c, clip.id)).toEqual([0.2, 0.2, 0.2, 0.4]);
    await runTool(c, 'set_note_length', { clip_id: clip.id, legato: true }, 'muse');
    // a chord's notes both hold to the next start; the last keeps its length
    expect(lengths(c, clip.id)).toEqual([1, 1, 0.5, 0.4]);
  });

  it('track_id changes every MIDI region on the track; it needs exactly one of beats, scale, legato', async () => {
    const c = ctx();
    const { clip, track } = midiClip(c, [note(60, 0)]);
    const [s, b] = S.addMidiClip(c.store.get(), track.id, { name: 'Keys', midi: { instrument: 'piano', notes: [note(62, 0)] }, sourceDuration: 4, start: 4 });
    c.store.set(s);
    expect((await runTool(c, 'set_note_length', { track_id: track.id, beats: 1 }, 'muse')).result).toMatchObject({ clips: [clip.id, b.id], changed: 2 });
    expect([...lengths(c, clip.id), ...lengths(c, b.id)]).toEqual([0.5, 0.5]);
    expect((await runTool(c, 'set_note_length', { beats: 1, scale: 2 }, 'muse')).error).toMatch(/one of/);
    expect((await runTool(c, 'set_note_length', {}, 'muse')).error).toMatch(/one of/);
  });
});
