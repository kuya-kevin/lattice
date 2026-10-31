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
import { familyOf, MemorySetupLibrary, shapeOf, trackGroups } from '../src/core/setups';
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
async function vocalSetup(c: ToolContext, names: readonly string[] = ['Vocal', 'Vocal L', 'Vocal R'], width = 0.4) {
  for (const [name, pan] of [[names[0], 0], [names[1], -width], [names[2], width]] as const) {
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
  it('offers a setup once it is done the same way in two projects (names and knobs may differ)', async () => {
    const c = ctx();
    await vocalSetup(c);
    expect((await ok(c, 'save_project')).setup_offers).toBeUndefined(); // once is not a habit
    expect((await ok(c, 'save_project')).setup_offers).toBeUndefined(); // saving again is the same project
    await ok(c, 'new_project', {});
    await vocalSetup(c, ['Vox', 'Vox Dbl L', 'Vox Dbl R']);
    await ok(c, 'set_param', { track_id: c.store.get().tracks[0].id, device_id: 'eq', param: 'b3_gain', value: 5 }); // a different EQ is still this setup
    const [offer, ...more] = (await ok(c, 'save_project')).setup_offers;
    expect(more).toEqual([]);
    expect(offer).toMatchObject({ name: 'Vocal setup', family: 'vocal', projects: 2, replaces: false });
    expect(offer.tracks.map((t: any) => `${t.name} ${t.pan}`)).toEqual(['Vox centre', 'Vox Dbl L 40% L', 'Vox Dbl R 40% R']);
    expect(offer.tracks[0].devices).toEqual(['Channel EQ', 'Compressor']);

    const r = await ok(c, 'save_setup', { name: offer.name, track_ids: offer.track_ids });
    expect(r).toMatchObject({ name: 'Vocal setup', chain_saved: 'Vocal chain' });
    expect(c.chains!.get('Vocal chain')!.devices.map((d) => d.kind)).toEqual(['eq', 'comp']);
    expect((await ok(c, 'save_project')).setup_offers).toBeUndefined(); // known now
    expect(museSummary(c)).toContain('"Vocal setup": Vox (centre, Channel EQ, Compressor), Vox Dbl L (40% L, Channel EQ, Compressor)');
  });

  it('works for any kind of track, and the count is a setting', async () => {
    const c = ctx();
    await ok(c, 'set_setup_learning', { after: 1 });
    await vocalSetup(c, ['Gtr', 'Gtr L', 'Gtr R'], 0.8);
    const { track_id } = await ok(c, 'add_track', { name: 'Audio 1' }); // says nothing: no group
    await ok(c, 'insert_device', { track_id, device: 'eq' });
    const offers = (await ok(c, 'save_project')).setup_offers;
    expect(offers.map((o: any) => [o.name, o.projects])).toEqual([['Guitar setup', 1]]);
    expect(offers[0].tracks.map((t: any) => t.pan)).toEqual(['centre', '80% L', '80% R']);
  });

  it('"Not now" waits for another project; a changed habit offers to update', async () => {
    const c = ctx();
    await ok(c, 'set_setup_learning', { after: 1 });
    await vocalSetup(c);
    const [offer] = (await ok(c, 'save_project')).setup_offers;
    await ok(c, 'decline_setup', { family: offer.family, shape: offer.shape, projects: offer.projects });
    expect((await ok(c, 'save_project')).setup_offers).toBeUndefined();
    await ok(c, 'new_project', {});
    await vocalSetup(c);
    expect((await ok(c, 'save_project')).setup_offers).toHaveLength(1); // seen in a second project
    await ok(c, 'save_setup', { name: 'Vocal setup' });

    await ok(c, 'new_project', {});
    await vocalSetup(c, undefined, 0.3); // the user now goes 30% out
    expect((await ok(c, 'save_project')).setup_offers).toMatchObject([{ name: 'Vocal setup', replaces: true, projects: 1 }]);
  });

  it('in a new project, apply_setup sets up the bare track and makes the others (one undo step)', async () => {
    const c = ctx();
    await vocalSetup(c);
    await ok(c, 'save_setup', { name: 'Vocal setup' });
    await ok(c, 'new_project', {});
    await ok(c, 'add_track', { name: 'Lead Vox' });
    const r = await ok(c, 'apply_setup', { name: 'vocal' }, 'muse');
    expect(r.tracks.map((t: any) => [t.name, t.made])).toEqual([['Lead Vox', false], ['Vocal L', true], ['Vocal R', true]]);
    const s = c.store.get();
    expect(s.tracks.map((t) => t.devices.map((d) => d.kind))).toEqual([['eq', 'comp'], ['eq', 'comp', 'utility'], ['eq', 'comp', 'utility']]);
    expect(s.tracks[1].devices[2].params.pan).toBe(-0.4);
    c.store.undo();
    expect(names(c)).toEqual(['Lead Vox']);
  });

  it('setups and what Lattice has seen span relaunches (setups.json)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lattice-setups-')), 'setups.json');
    const c = { ...ctx(), setups: new FileSetupLibrary(file) };
    await vocalSetup(c);
    await ok(c, 'save_project');
    expect(trackGroups(c.store.get()).map((g) => g.family)).toEqual(['vocal']);
    expect(new FileSetupLibrary(file).see('vocal', 'p2', shapeOf(trackGroups(c.store.get())[0].tracks))).toBe(2); // p1's Save was kept
    await ok(c, 'set_setup_learning', { after: 3 });
    await ok(c, 'save_setup', { name: 'Vocal setup' });
    const again = new FileSetupLibrary(file);
    expect(again.get('vocal setup')?.tracks).toHaveLength(3);
    expect(again.learnAfter).toBe(3);
    await ok(c, 'forget_setup', { name: 'Vocal setup' });
    expect(new FileSetupLibrary(file).list()).toEqual([]);
  });

  it('a track\'s kind: its last word that is not a side, number or take, one spelling', () => {
    const cases: [string, string | null][] = [
      ['Vocal', 'vocal'], ['Vox L', 'vocal'], ['Lead Vocals', 'vocal'], ['BGV 2', 'vocal'], ['Vocal Double R', 'vocal'],
      ['Gtr L', 'guitar'], ['Acoustic Guitar', 'guitar'], ['Kick', 'kick'], ['Drums', 'drum'], ['Lead Synth', 'synth'],
      ['Vocoder', 'vocoder'], ['Audio 1', null], ['Track 3', null], ['L', null],
    ];
    for (const [n, f] of cases) expect(familyOf(n), n).toBe(f);
  });
});
