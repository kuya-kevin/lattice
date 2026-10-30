// The Piano Roll's note selection lives in the session: Muse sees it, "these notes" act on it, and
// it follows its notes when an edit re-sorts them.
import { describe, expect, it } from 'vitest';
import type { MidiNote } from '../src/core/midi';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const ctx = (): ToolContext => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) });
const note = (pitch: number, start: number, velocity = 100): MidiNote => ({ pitch, start, duration: 0.2, velocity });

function midiClip(c: ToolContext, notes: MidiNote[]) {
  const [s1, t] = S.addTrack(c.store.get(), 'Keys');
  const [s2, clip] = S.addMidiClip(s1, t.id, { name: 'Keys', midi: { instrument: 'piano', notes }, sourceDuration: 2, start: 0 });
  c.store.set(S.select(s2, t.id, clip.id));
  return clip;
}
const notesOf = (c: ToolContext, id: string) => S.findClip(c.store.get(), id).clip.midi!.notes;
const selectedPitches = (c: ToolContext, id: string) => S.selectedNotes(c.store.get()).map((i) => notesOf(c, id)[i].pitch);

describe('note selection', () => {
  it('select_notes is a quiet user tool; the summary names the notes and their indexes', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0), note(64, 0.5), note(67, 1)]);
    expect(museToolSpecs().map((t) => t.function.name)).not.toContain('select_notes');
    expect(await runTool(c, 'select_notes', { clip_id: clip.id, notes: [2, 0, 9] }, 'user')).toMatchObject({ ok: true });
    expect(c.store.canUndo()).toBe(false);
    expect(S.selectedNotes(c.store.get())).toEqual([0, 2]);
    const line = S.summarize(c.store.get()).split('\n').pop()!;
    expect(line).toContain('2 of its 3 notes selected in the Piano Roll (C4 bar 1, G4 bar 1.5');
    expect(line).toContain('"these notes" = notes [0,2]');
    await runTool(c, 'select_notes', { clip_id: clip.id, notes: [] }, 'user');
    expect(S.summarize(c.store.get())).not.toContain('Piano Roll');
  });

  it('selecting another region drops the note selection; re-selecting the same one keeps it', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0), note(64, 0.5)]);
    await runTool(c, 'select_notes', { clip_id: clip.id, notes: [1] }, 'user');
    const t = c.store.get().selection.trackId;
    await runTool(c, 'select', { track_id: t, clip_id: clip.id }, 'user');
    expect(S.selectedNotes(c.store.get())).toEqual([1]);
    await runTool(c, 'select', { track_id: t, clip_id: null }, 'user');
    await runTool(c, 'select', { track_id: t, clip_id: clip.id }, 'user');
    expect(S.selectedNotes(c.store.get())).toEqual([]);
  });

  it('follows its notes when quantize re-sorts them', async () => {
    const c = ctx(); // 120 BPM, 1/4 = 0.5 s: D4 at 0.3 snaps to 0.5, after E4 at 0.45 (which stays)
    const clip = midiClip(c, [note(60, 0), note(62, 0.3), note(64, 0.45)]);
    await runTool(c, 'select_notes', { clip_id: clip.id, notes: [1] }, 'user');
    await runTool(c, 'quantize_midi', { clip_id: clip.id, grid: '1/4', notes: [1] }, 'muse');
    expect(notesOf(c, clip.id).map((n) => n.pitch)).toEqual([60, 64, 62]);
    expect(selectedPitches(c, clip.id)).toEqual([62]);
  });

  it('quantize with notes and no clip_id uses the selected region', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0.03), note(62, 0.53)]);
    expect(await runTool(c, 'quantize_midi', { grid: '1/16', notes: [1] }, 'muse')).toMatchObject({ ok: true, result: { quantized: 1 } });
    expect(notesOf(c, clip.id).map((n) => n.start)).toEqual([0.03, 0.5]);
  });

  it('follows its notes through a transpose and a Piano Roll edit', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0), note(64, 0)]);
    await runTool(c, 'select_notes', { clip_id: clip.id, notes: [1] }, 'user');
    await runTool(c, 'transpose_midi', { clip_id: clip.id, semitones: -7, notes: [1] }, 'muse'); // E4 -> A3, now first
    expect(notesOf(c, clip.id).map((n) => n.pitch)).toEqual([57, 60]);
    expect(selectedPitches(c, clip.id)).toEqual([57]);
    // the Piano Roll sends its notes in its own order, with what stays selected
    await runTool(c, 'edit_midi_notes', { clip_id: clip.id, notes: [note(72, 1), note(60, 0)], selected: [0] }, 'user');
    expect(selectedPitches(c, clip.id)).toEqual([72]);
    expect(S.selectedNotes(c.store.get())).toEqual([1]);
  });

  it('set_note_velocity and delete_midi_notes act on the given notes', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0, 100), note(62, 0.5, 100), note(64, 1, 120)]);
    await runTool(c, 'select_notes', { clip_id: clip.id, notes: [1, 2] }, 'user');
    await runTool(c, 'set_note_velocity', { clip_id: clip.id, change: -30, notes: [1, 2] }, 'muse');
    expect(notesOf(c, clip.id).map((n) => n.velocity)).toEqual([100, 70, 90]);
    expect(S.selectedNotes(c.store.get())).toEqual([1, 2]);
    await runTool(c, 'set_note_velocity', { clip_id: clip.id, velocity: 127 }, 'muse');
    expect(notesOf(c, clip.id).map((n) => n.velocity)).toEqual([127, 127, 127]);
    expect(await runTool(c, 'set_note_velocity', { clip_id: clip.id }, 'muse')).toMatchObject({ ok: false });
    await runTool(c, 'delete_midi_notes', { clip_id: clip.id, notes: [1, 2] }, 'muse');
    expect(notesOf(c, clip.id).map((n) => n.pitch)).toEqual([60]);
    expect(S.selectedNotes(c.store.get())).toEqual([]);
  });

  it('undo keeps the selection (a view setting) but never points past the last note', async () => {
    const c = ctx();
    const clip = midiClip(c, [note(60, 0)]);
    await runTool(c, 'edit_midi_notes', { clip_id: clip.id, notes: [note(60, 0), note(62, 0.5)], selected: [1] }, 'user');
    expect(S.selectedNotes(c.store.get())).toEqual([1]);
    await runTool(c, 'undo', {}, 'user');
    expect(notesOf(c, clip.id)).toHaveLength(1);
    expect(S.selectedNotes(c.store.get())).toEqual([]);
  });
});
