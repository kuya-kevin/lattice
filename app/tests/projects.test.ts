// Oct 30: several projects (new, open, rename, delete; Electron's on disk) and the producer's
// setups learned on Save (the vocal setup: centre + 40% L/R with their chains).
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museSummary, museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { MemoryProjectLibrary } from '../src/core/projects';
import { isVocalTrack, MemorySetupLibrary } from '../src/core/setups';
import { MemoryVersionLibrary } from '../src/core/versions';
import { FileProjectLibrary, loadAutosave } from '../src/node/projectFiles';
import { FileSetupLibrary } from '../src/node/setupFile';
import * as S from '../src/core/session';

const ctx = (): ToolContext => {
  const versions = new MemoryVersionLibrary();
  return {
    store: new SessionStore(),
    sidecar: new StubSidecar(),
    searchFreesound: async () => ({ count: 0, results: [] }),
    versions,
    projects: new MemoryProjectLibrary(versions),
    setups: new MemorySetupLibrary(),
  };
};
const ok = async (c: ToolContext, tool: string, args: Record<string, unknown> = {}, by: 'user' | 'muse' = 'user') => {
  const r = await runTool(c, tool, args, by);
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r.result as any;
};
const names = (c: ToolContext) => c.store.get().tracks.map((t) => t.name);

/** The user's vocals by hand: Vocal centre, Vocal L/R 40% out, each with EQ + compressor. */
async function vocalSetup(c: ToolContext) {
  for (const [name, pan] of [['Vocal', 0], ['Vocal L', -0.4], ['Vocal R', 0.4]] as const) {
    const { track_id } = await ok(c, 'add_track', { name });
    await ok(c, 'insert_device', { track_id, device: 'eq', params: { b3_gain: 2 } });
    await ok(c, 'insert_device', { track_id, device: 'comp' });
    if (pan) await ok(c, 'insert_device', { track_id, device: 'utility', params: { pan } });
  }
}

describe('projects (Oct 30)', () => {
  it('new_project keeps the open one; open_project brings it back with its own versions', async () => {
    const c = ctx();
    await ok(c, 'add_track', { name: 'Keys' });
    await ok(c, 'save_version', { name: 'first' });
    await ok(c, 'rename_project', { name: 'Demo song' });
    const made = await ok(c, 'new_project', { name: 'Second' });
    expect(made).toMatchObject({ project_id: 'p2', name: 'Second' });
    expect(c.store.get().tracks).toEqual([]);
    expect(c.versions!.list()).toEqual([]); // its own versions
    expect(c.store.canUndo()).toBe(false); // no undo back into Demo song
    await ok(c, 'add_track', { name: 'Bass' });

    const list = (await ok(c, 'list_projects')).projects;
    expect(list.map((p: any) => [p.name, p.open, p.tracks])).toEqual([['Second', true, 1], ['Demo song', false, 1]]);

    await ok(c, 'open_project', { project: 'Demo song' });
    expect(names(c)).toEqual(['Keys']);
    expect(c.versions!.list().map((v) => v.name)).toEqual(['first']);
    await ok(c, 'open_project', { project: 'p2' });
    expect(names(c)).toEqual(['Bass']);
  });

  it('ids never repeat across projects (the renderer keys audio by them)', async () => {
    const c = ctx();
    await ok(c, 'add_track', { name: 'A' }); // t1
    await ok(c, 'new_project', {});
    const { track_id } = await ok(c, 'add_track', { name: 'B' });
    expect(track_id).not.toBe('t1');
    await ok(c, 'open_project', { project: 'p1' });
    const again = await ok(c, 'add_track', { name: 'C' });
    expect([track_id, 't1']).not.toContain(again.track_id);
  });

  it('only the user switches projects; Muse sees which one is open', async () => {
    const c = ctx();
    const muse = museToolSpecs().map((t) => t.function.name);
    expect(muse).toContain('list_projects');
    for (const t of ['new_project', 'open_project', 'delete_project', 'save_project']) expect(muse).not.toContain(t);
    expect((await runTool(c, 'new_project', {}, 'muse')).ok).toBe(false);
    await ok(c, 'rename_project', { name: 'Demo song' });
    expect(museSummary(c)).toContain('\nProject: "Demo song"');
  });

  it('new names are unique; the open project cannot be deleted', async () => {
    const c = ctx();
    await ok(c, 'new_project', {});
    expect((await ok(c, 'list_projects')).projects.map((p: any) => p.name)).toEqual(['Untitled 2', 'Untitled']);
    expect((await runTool(c, 'delete_project', { project: 'p2' }, 'user')).error).toMatch(/is open/);
    await ok(c, 'delete_project', { project: 'Untitled' });
    expect((await ok(c, 'list_projects')).projects).toHaveLength(1);
  });

  it('on disk: each project in its own folder, the first where the single project was', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-projects-'));
    const lib = new FileProjectLibrary(root);
    expect(lib.dir()).toBe(join(root, 'project'));
    const one = { ...S.emptySession(), tracks: [] };
    const [withTrack] = S.addTrack(one, 'Vox');
    lib.versions().save({ name: 'v', auto: false, session: withTrack });
    const { meta } = lib.create('Next', withTrack);
    expect(lib.dir()).toBe(join(root, 'projects', meta.id));
    expect(loadAutosave(join(root, 'project', 'session.json'))?.tracks[0].name).toBe('Vox');

    const again = new FileProjectLibrary(root); // a relaunch
    expect(again.current().id).toBe(meta.id);
    const back = again.open('p1', S.emptySession());
    expect(back.session?.tracks[0].name).toBe('Vox');
    expect(back.versions.list().map((v) => v.name)).toEqual(['v']);
    again.remove(meta.id);
    expect(existsSync(join(root, 'projects', meta.id))).toBe(false);
  });
});

describe('setups learned on Save (Oct 30)', () => {
  it('Save offers the vocal setup; saving it keeps names, pans and chains, and the chain', async () => {
    const c = ctx();
    await vocalSetup(c);
    const saved = await ok(c, 'save_project');
    expect(saved.name).toMatch(/^Saved /);
    expect(saved.setup_offer).toMatchObject({ name: 'Vocal setup', replaces: false });
    expect(saved.setup_offer.tracks.map((t: any) => `${t.name} ${t.pan}`)).toEqual(['Vocal centre', 'Vocal L 40% L', 'Vocal R 40% R']);
    expect(saved.setup_offer.tracks[0].devices).toEqual(['Channel EQ', 'Compressor']);

    const r = await ok(c, 'save_setup', { track_ids: saved.setup_offer.track_ids });
    expect(r).toMatchObject({ name: 'Vocal setup', chain_saved: 'Vocal chain' });
    expect(c.chains!.get('Vocal chain')!.devices.map((d) => d.kind)).toEqual(['eq', 'comp']);
    expect((await ok(c, 'save_project')).setup_offer).toBeUndefined(); // nothing new to learn
    expect(museSummary(c)).toContain('"Vocal setup": Vocal (centre, Channel EQ, Compressor), Vocal L (40% L, Channel EQ, Compressor)');
  });

  it('no offer without a vocal setup; a changed one offers to replace', async () => {
    const c = ctx();
    await ok(c, 'add_track', { name: 'Lead Vocal' });
    expect((await ok(c, 'save_project')).setup_offer).toBeUndefined(); // one bare vocal track
    await vocalSetup(c);
    await ok(c, 'save_setup', {});
    await ok(c, 'set_param', { track_id: 't5', device_id: 'utility', param: 'pan', value: -0.6 });
    expect((await ok(c, 'save_project')).setup_offer).toMatchObject({ replaces: true });
  });

  it('in a new project, apply_setup sets up the vocal track and makes the doubles (one undo step)', async () => {
    const c = ctx();
    await vocalSetup(c);
    await ok(c, 'save_setup', {});
    await ok(c, 'new_project', {});
    await ok(c, 'add_track', { name: 'Vox' });
    const r = await ok(c, 'apply_setup', {}, 'muse');
    expect(r.tracks.map((t: any) => [t.name, t.made])).toEqual([['Vox', false], ['Vocal L', true], ['Vocal R', true]]);
    const s = c.store.get();
    expect(s.tracks.map((t) => t.devices.map((d) => d.kind))).toEqual([['eq', 'comp'], ['eq', 'comp', 'utility'], ['eq', 'comp', 'utility']]);
    expect(s.tracks[1].devices[2].params.pan).toBe(-0.4);
    c.store.undo();
    expect(names(c)).toEqual(['Vox']);
  });

  it('setups span projects and relaunches (setups.json)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lattice-setups-')), 'setups.json');
    const c = { ...ctx(), setups: new FileSetupLibrary(file) };
    await vocalSetup(c);
    await ok(c, 'save_setup', {});
    expect(new FileSetupLibrary(file).get('vocal setup')?.tracks).toHaveLength(3);
    await ok(c, 'forget_setup', { name: 'Vocal setup' });
    expect(new FileSetupLibrary(file).list()).toEqual([]);
  });

  it('vocal tracks by whole words', () => {
    const s = S.emptySession();
    const t = (name: string) => ({ ...S.addTrack(s, name)[1] });
    for (const n of ['Vocal', 'Vox L', 'Lead Vocals', 'BGV 2', 'Double R', 'Harmony']) expect(isVocalTrack(s, t(n)), n).toBe(true);
    for (const n of ['Vocoder', 'Lead Synth', 'Voxel pad', 'Keys']) expect(isVocalTrack(s, t(n)), n).toBe(false);
  });
});
