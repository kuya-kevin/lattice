// Muse can set up the cycle ("set up a two-bar loop"): set_cycle, kept in the session.
import { describe, expect, it } from 'vitest';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';

const ctx = (): ToolContext => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) });

describe('set_cycle', () => {
  it('loops a bar range (inclusive) and shows it in the summary', async () => {
    const c = ctx(); // 120 BPM 4/4: a bar is 2 s
    await runTool(c, 'add_track', { name: 'Drums' }, 'user');
    const r = await runTool(c, 'set_cycle', { from_bar: 1, to_bar: 2 }, 'muse');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ on: true, start: 0, end: 4, from_bar: 1, to_bar: 2 });
    expect(c.store.get().cycle).toEqual({ on: true, start: 0, end: 4 });
    expect(S.summarize(c.store.get())).toContain('cycle on, bars 1-2');
    await runTool(c, 'set_cycle', { from_bar: 5, to_bar: 8 }, 'muse');
    expect(c.store.get().cycle).toEqual({ on: true, start: 8, end: 16 });
  });

  it('turns off keeping the area, and on again with it; on with no area is bars 1-4', async () => {
    const c = ctx();
    await runTool(c, 'add_track', { name: 'Drums' }, 'user');
    await runTool(c, 'set_cycle', { on: true }, 'user');
    expect(c.store.get().cycle).toEqual({ on: true, start: 0, end: 8 });
    await runTool(c, 'set_cycle', { start: 2, end: 6 }, 'user');
    await runTool(c, 'set_cycle', { on: false }, 'muse');
    expect(c.store.get().cycle).toEqual({ on: false, start: 2, end: 6 });
    expect(S.summarize(c.store.get())).not.toContain('cycle');
    await runTool(c, 'set_cycle', { on: true }, 'muse');
    expect(c.store.get().cycle).toEqual({ on: true, start: 2, end: 6 });
  });

  it('refuses an empty range; is not an undo step, and undo keeps it', async () => {
    const c = ctx();
    expect((await runTool(c, 'set_cycle', { from_bar: 3, to_bar: 2 }, 'muse')).ok).toBe(false);
    await runTool(c, 'add_track', { name: 'A' }, 'user');
    await runTool(c, 'set_cycle', { from_bar: 2, to_bar: 3 }, 'muse');
    await runTool(c, 'undo', {}, 'user'); // undoes add_track
    expect(c.store.get().tracks).toHaveLength(0);
    expect(c.store.get().cycle).toEqual({ on: true, start: 2, end: 6 });
  });

  it('stays on its bars when the tempo changes', async () => {
    const c = ctx();
    await runTool(c, 'set_cycle', { from_bar: 2, to_bar: 3 }, 'muse');
    await runTool(c, 'set_tempo', { bpm: 60 }, 'muse');
    expect(c.store.get().cycle).toEqual({ on: true, start: 4, end: 12 });
  });
});
