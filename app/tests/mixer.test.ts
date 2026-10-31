// The mixer's pan knob runs set_pan, the tool Muse pans with: a track's pan is its Utility
// device's Pan knob, so the knob, the device panel and setups (trackPan) share one value.
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { trackPan } from '../src/core/setups';
import { MemoryChainLibrary } from '../src/fx/savedChains';

const ctx = async (): Promise<ToolContext> => {
  const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }), chains: new MemoryChainLibrary() };
  await runTool(c, 'import_audio', { source_id: 'a', name: 'Vox', duration: 4 }, 'user');
  c.store.takeUserEdits();
  return c;
};
const track = (c: ToolContext) => c.store.get().tracks[0];

describe('set_pan (the mixer pan knob)', () => {
  it('adds a Utility at the end of the chain when the track has none, and pans on it', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    const r = await runTool(c, 'set_pan', { track_id: 't1', pan: -0.4 }, 'user');
    expect(r).toMatchObject({ ok: true, result: { track_id: 't1', pan: -0.4, inserted_utility: true } });
    expect(track(c).devices.map((d) => d.kind)).toEqual(['eq', 'utility']);
    expect(trackPan(track(c))).toBe(-0.4);
  });

  it('moves the existing switched-on Utility instead of adding another', async () => {
    const c = await ctx();
    const u = await runTool(c, 'insert_device', { track_id: 't1', device: 'utility', params: { gain: -3 } }, 'user');
    const id = (u.result as { device_id: string }).device_id;
    const r = await runTool(c, 'set_pan', { track_id: 't1', pan: 0.7 }, 'user');
    expect(r.result).toEqual({ track_id: 't1', pan: 0.7, device_id: id });
    expect(track(c).devices).toHaveLength(1);
    expect(track(c).devices[0].params).toMatchObject({ pan: 0.7, gain: -3 }); // the Utility's own gain is left alone
  });

  it('pans the switched-on Utility when an earlier one is bypassed (the one heard)', async () => {
    const c = await ctx();
    const off = await runTool(c, 'insert_device', { track_id: 't1', device: 'utility' }, 'user');
    await runTool(c, 'bypass_device', { track_id: 't1', device_id: (off.result as { device_id: string }).device_id, on: false }, 'user');
    await runTool(c, 'insert_device', { track_id: 't1', device: 'utility' }, 'user');
    await runTool(c, 'set_pan', { track_id: 't1', pan: 0.5 }, 'user');
    expect(track(c).devices.map((d) => d.params.pan)).toEqual([0, 0.5]);
    expect(trackPan(track(c))).toBe(0.5);
  });

  it('refuses values past hard left / right, is one undo step, and is logged as a hand edit', async () => {
    const c = await ctx();
    expect((await runTool(c, 'set_pan', { track_id: 't1', pan: 3 }, 'user')).ok).toBe(false);
    await runTool(c, 'set_pan', { track_id: 't1', pan: 1 }, 'user');
    expect(trackPan(track(c))).toBe(1);
    expect(c.store.takeUserEdits()).toEqual(['panned t1 to 100% right']);
    await runTool(c, 'undo', {}, 'user');
    expect(track(c).devices).toEqual([]);
  });

  it('is the same tool Muse pans with', () => {
    expect(museToolSpecs().map((t) => t.function.name)).toContain('set_pan');
  });
});
