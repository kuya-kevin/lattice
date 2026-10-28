import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import * as S from '../src/core/session';
import { MemoryChainLibrary } from '../src/fx/savedChains';

const ctx = async (): Promise<ToolContext> => {
  const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }), chains: new MemoryChainLibrary() };
  await runTool(c, 'import_audio', { source_id: 'a', name: 'Vox', duration: 4 }, 'user');
  await runTool(c, 'import_audio', { source_id: 'b', name: 'Synth', duration: 4 }, 'user');
  c.store.takeUserEdits();
  return c;
};

describe('saved chains (B10)', () => {
  it('are exposed to Muse', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['save_chain', 'load_chain', 'list_chains']));
  });

  it('save a track chain by name and load it onto another track with the same knobs', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq', params: { b3_gain: 4 } }, 'user');
    const comp = await runTool(c, 'insert_device', { track_id: 't1', device: 'comp', params: { thresh: -30 } }, 'user');
    await runTool(c, 'bypass_device', { track_id: 't1', device_id: (comp.result as { device_id: string }).device_id, on: false }, 'user');
    c.store.takeUserEdits();

    const s0 = c.store.get();
    const saved = await runTool(c, 'save_chain', { track_id: 't1', name: 'dark vocal' }, 'user');
    expect(saved).toMatchObject({ ok: true, result: { name: 'dark vocal', devices: ['eq', 'comp'], replaced: false } });
    expect(c.store.get()).toBe(s0); // saving leaves the session (and undo) alone
    expect(c.store.takeUserEdits()).toEqual(['save_chain {"track_id":"t1","name":"dark vocal"}']);

    const listed = await runTool(c, 'list_chains', {}, 'muse');
    expect(listed).toMatchObject({ ok: true, result: { chains: [{ name: 'dark vocal', devices: ['eq', 'comp'] }] } });

    const loaded = await runTool(c, 'load_chain', { track_id: 't3', name: 'dark vocal' }, 'muse');
    expect(loaded.ok).toBe(true);
    const [src, dst] = c.store.get().tracks.map((t) => t.devices);
    expect(dst.map((d) => [d.kind, d.on, d.params])).toEqual(src.map((d) => [d.kind, d.on, d.params]));
    expect(dst.map((d) => d.id)).not.toEqual(src.map((d) => d.id));
    expect(dst[0].params.b3_gain).toBe(4);

    // one undo step takes the whole load back
    c.store.undo();
    expect(c.store.get().tracks[1].devices).toEqual([]);
  });

  it('append by default, replace on request, and overwrite a name on re-save', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    await runTool(c, 'save_chain', { track_id: 't1', name: 'x' }, 'user');
    await runTool(c, 'insert_device', { track_id: 't1', device: 'comp' }, 'user');
    const again = await runTool(c, 'save_chain', { track_id: 't1', name: 'x' }, 'user');
    expect(again.result).toMatchObject({ replaced: true, devices: ['eq', 'comp'] });
    expect(c.chains!.list()).toHaveLength(1);

    await runTool(c, 'insert_device', { track_id: 't3', device: 'delay' }, 'user');
    await runTool(c, 'load_chain', { track_id: 't3', name: 'x' }, 'user');
    expect(c.store.get().tracks[1].devices.map((d) => d.kind)).toEqual(['delay', 'eq', 'comp']);
    await runTool(c, 'load_chain', { track_id: 't3', name: 'x', replace: true }, 'user');
    expect(c.store.get().tracks[1].devices.map((d) => d.kind)).toEqual(['eq', 'comp']);
  });

  it('give clear errors', async () => {
    const c = await ctx();
    expect(await runTool(c, 'save_chain', { track_id: 't1', name: 'empty' }, 'user')).toMatchObject({ ok: false, error: expect.stringMatching(/no devices/) });
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    expect(await runTool(c, 'save_chain', { track_id: 't1', name: '  ' }, 'user')).toMatchObject({ ok: false, error: expect.stringMatching(/name/) });
    expect(await runTool(c, 'load_chain', { track_id: 't3', name: 'nope' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no saved chain "nope"/) });
    for (let i = 0; i < 15; i++) await runTool(c, 'insert_device', { track_id: 't3', device: 'utility' }, 'user');
    await runTool(c, 'save_chain', { track_id: 't1', name: 'one' }, 'user');
    await runTool(c, 'load_chain', { track_id: 't3', name: 'one' }, 'user'); // 16th fits
    const before = c.store.get();
    expect(await runTool(c, 'load_chain', { track_id: 't3', name: 'one' }, 'user')).toMatchObject({ ok: false, error: expect.stringMatching(/16 devices/) });
    expect(c.store.get()).toBe(before);
  });

  it('show saved names in what Muse sees', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    await runTool(c, 'save_chain', { track_id: 't1', name: 'dark vocal' }, 'user');
    expect(S.summarize(c.store.get(), { savedChains: ['dark vocal', 'lofi'] })).toContain('Saved chains: "dark vocal", "lofi"');
    expect(S.summarize(c.store.get())).not.toContain('Saved chains');
    const lt = await runTool(c, 'list_tracks', {}, 'muse');
    expect((lt.result as { summary: string }).summary).toContain('Saved chains: "dark vocal"');
  });

  it('work without a library on the context (in-memory fallback)', async () => {
    const c = await ctx();
    delete c.chains;
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    expect((await runTool(c, 'save_chain', { track_id: 't1', name: 'a' }, 'user')).ok).toBe(true);
    expect((await runTool(c, 'load_chain', { track_id: 't3', name: 'a' }, 'user')).ok).toBe(true);
  });
});

describe('FileChainLibrary', () => {
  it('persists saves across instances and survives a missing or broken file', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileChainLibrary } = await import('../src/node/chainFile');
    const file = join(mkdtempSync(join(tmpdir(), 'lattice-chains-')), 'sub', 'chains.json');
    const a = new FileChainLibrary(file);
    expect(a.list()).toEqual([]);
    a.save({ name: 'x', devices: [{ kind: 'eq', on: true, params: { b3_gain: 2 } }], savedAt: '2026-10-27T00:00:00Z' });
    expect(new FileChainLibrary(file).get('x')?.devices[0].params.b3_gain).toBe(2);
    writeFileSync(file, '{not json');
    expect(new FileChainLibrary(file).list()).toEqual([]);
  });
});
