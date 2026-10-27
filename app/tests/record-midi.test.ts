// record_midi: a Musical Typing take becomes a MIDI clip (undoable, user-only), built from the
// note stream with takeToNotes.
import { describe, expect, it } from 'vitest';
import { takeToNotes } from '../src/core/musicalTyping';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

describe('record_midi', () => {
  it('adds the take as a selected MIDI clip at the take start; undo removes it', async () => {
    const c = ctx();
    await runTool(c, 'add_track', { name: 'Keys' }, 'user');
    // played A (C4) then S (D4) from 2.0 s; D4 still held when the take stops at 3.5 s
    const notes = takeToNotes(
      [
        { pitch: 60, velocity: 100, start: 2.1, end: 2.5 },
        { pitch: 62, velocity: 80, start: 2.6, end: null },
      ],
      2,
      3.5,
    );
    const r = await runTool(c, 'record_midi', { track_id: 't1', start: 2, duration: 1.5, notes }, 'user');
    expect(r.ok).toBe(true);
    const s = c.store.get();
    const clip = s.tracks[0].clips[0];
    expect(clip).toMatchObject({ start: 2, duration: 1.5, name: 'MIDI take 1' });
    expect(clip.midi!.notes).toEqual([
      { pitch: 60, velocity: 100, start: 0.1, duration: 0.4 },
      { pitch: 62, velocity: 80, start: 0.6, duration: 0.9 },
    ]);
    expect(s.selection).toEqual({ trackId: 't1', clipId: clip.id });

    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks[0].clips).toEqual([]);
  });

  it('drops notes outside the take and bad pitches, clamps velocity', async () => {
    const c = ctx();
    await runTool(c, 'add_track', { name: 'Keys' }, 'user');
    const r = await runTool(
      c,
      'record_midi',
      {
        track_id: 't1',
        start: 0,
        duration: 1,
        notes: [
          { pitch: 60, velocity: 200, start: 0.5, duration: 2 }, // clipped to the take end
          { pitch: 61, velocity: 90, start: 1.2, duration: 0.1 }, // after the take
          { pitch: 130, velocity: 90, start: 0.1, duration: 0.1 }, // not a MIDI pitch
        ],
      },
      'user',
    );
    expect(r.ok && (r.result as any).notes).toBe(1);
    expect(c.store.get().tracks[0].clips[0].midi!.notes).toEqual([{ pitch: 60, velocity: 127, start: 0.5, duration: 0.5 }]);
  });

  it('is a user tool, hidden from Muse', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toContain('quantize_midi');
    expect(names).not.toContain('record_midi');
  });
});
