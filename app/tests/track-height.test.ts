// Per-track lane height: a view setting stored as a scale of the global track height. Quiet
// (no undo entry, not logged for Muse) and kept as it is through undo/redo.
import { describe, expect, it } from 'vitest';
import { laneHeight } from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

describe('set_track_height', () => {
  it('stores a scale per track, resets with no scale, and is hidden from Muse', async () => {
    const c = ctx();
    await runTool(c, 'add_track', { name: 'Drums' }, 'user');
    await runTool(c, 'set_track_height', { track_id: 't1', scale: 1.5 }, 'user');
    expect(c.store.get().tracks[0].heightScale).toBe(1.5);
    await runTool(c, 'set_track_height', { track_id: 't1' }, 'user');
    expect(c.store.get().tracks[0]).not.toHaveProperty('heightScale');
    expect((await runTool(c, 'set_track_height', { track_id: 't1', scale: 0 }, 'user')).ok).toBe(false);
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toContain('rename_track');
    expect(names).not.toContain('set_track_height');
  });

  it('is not an undo step, and undo/redo of other edits keep the heights', async () => {
    const c = ctx();
    await runTool(c, 'add_track', { name: 'Drums' }, 'user');
    await runTool(c, 'add_track', { name: 'Bass' }, 'user');
    await runTool(c, 'set_track_height', { track_id: 't1', scale: 2 }, 'user');
    await runTool(c, 'undo', {}, 'user'); // undoes adding Bass, not the height
    let s = c.store.get();
    expect(s.tracks.map((t) => [t.name, t.heightScale])).toEqual([['Drums', 2]]);
    await runTool(c, 'redo', {}, 'user');
    s = c.store.get();
    expect(s.tracks.map((t) => [t.name, t.heightScale])).toEqual([['Drums', 2], ['Bass', undefined]]);
  });
});

describe('laneHeight', () => {
  it('scales the global height, leaves unscaled tracks to it, and clamps', () => {
    expect(laneHeight(undefined, 84)).toBeUndefined();
    expect(laneHeight(1, 84)).toBeUndefined();
    expect(laneHeight(1.5, 84)).toBe(126);
    expect(laneHeight(0.1, 84)).toBe(24);
    expect(laneHeight(10, 84)).toBe(384);
  });
});
