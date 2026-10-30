// B17 sound shelves and B18 dry / wet: the tools, with a fake renderer (tests have no audio).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drySession, dryDevices, gatedRmsDb, heardSession, matchingGainDb, stemName, trimTrailingSilence, type RenderJob } from '../src/core/mixView';
import { MemorySoundShelf } from '../src/core/shelf';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museSummary, museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { FileSoundShelf } from '../src/node/shelfFile';

const wav = (tag: number) => new Uint8Array([82, 73, 70, 70, tag]);

function ctx(shelf = new MemorySoundShelf()) {
  const jobs: RenderJob[] = [];
  const adopted = new Map<string, unknown>();
  const saved: { set: string; name: string }[][] = [];
  const c: ToolContext = {
    store: new SessionStore(),
    sidecar: new StubSidecar(),
    searchFreesound: async () => ({ count: 0, results: [] }),
    shelf,
    render: (async (_s: unknown, job: RenderJob) => {
      jobs.push(job);
      if (job.kind === 'source') return { wav: wav(1), duration: 0.5, sampleRate: 48000 };
      if (job.kind === 'sound') return { wav: wav(2), dry: wav(3), duration: 3.2, dryDuration: 2, tail: 1.2, sampleRate: 48000 };
      if (job.kind === 'stems') return { stems: c.store.get().tracks.map((t) => ({ trackId: t.id, name: t.name, wav: wav(4) })), duration: 2, sampleRate: 48000 };
      return { wetDb: -14, dryDb: -18.5 };
    }) as ToolContext['render'],
    adoptAudio: (id, ref) => void adopted.set(id, ref),
    findLibrary: async (id) => (id === 'fs:1' ? { id: 'fs:1', set: 'freesound', category: 'kick', name: 'Dusty kick', tags: [], duration: 0.4, license: 'CC-BY-4.0', author: 'someone' } : undefined),
    saveFiles: async (files) => (saved.push(files.map(({ set, name }) => ({ set, name }))), { savedTo: '/tmp/x', files: files.map((f) => `${f.set}/${f.name}`) }),
  };
  return { c, jobs, adopted, saved };
}

async function withTrack(c: ToolContext) {
  await runTool(c, 'import_audio', { source_id: 'src-vox', name: 'Vox', duration: 2 }, 'user');
  await runTool(c, 'insert_device', { track_id: 't1', device: 'eq', params: { b3_gain: 4 } }, 'user');
  await runTool(c, 'insert_device', { track_id: 't1', device: 'utility', params: { gain: -3, pan: 0.4, width: 50 } }, 'user');
  await runTool(c, 'insert_device', { track_id: 't1', device: 'comp', params: { thresh: -30 } }, 'user');
  c.store.takeUserEdits();
}

describe('sound shelves (B17)', () => {
  it('are tools Muse can call', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['star_sound', 'unstar_sound', 'export_sound', 'find_sound_in_shelf', 'use_shelf_sound', 'reopen_sound', 'set_mix_view', 'export_stems']));
  });

  it('star a library sound once, and unstar it', async () => {
    const { c } = ctx();
    const r = await runTool(c, 'star_sound', { library_id: 'fs:1' }, 'user');
    expect(r).toMatchObject({ ok: true, result: { name: 'Dusty kick', shelf: 'Starred', from: 'library' } });
    expect((r.result as { credit: string }).credit).toMatch(/Dusty kick.*someone.*CC-BY/);
    const again = await runTool(c, 'star_sound', { library_id: 'fs:1' }, 'user');
    expect(again.result).toMatchObject({ already: true });
    expect(c.shelf!.list()).toHaveLength(1);
    expect(c.shelf!.audio(c.shelf!.list()[0].id)).toBeNull(); // the library holds the audio
    expect((await runTool(c, 'unstar_sound', { shelf_id: (r.result as { shelf_id: string }).shelf_id }, 'user')).ok).toBe(true);
    expect(c.shelf!.list()).toEqual([]);
    expect((await runTool(c, 'star_sound', { library_id: 'nope' }, 'user')).error).toMatch(/no library item/);
  });

  it('star an Ideas sound and a pad: its audio is kept on the shelf; the session is untouched', async () => {
    const { c, jobs } = ctx();
    await runTool(c, 'add_sound', { source_id: 's-kick', name: 'Kick', duration: 0.5, origin: 'record' }, 'user');
    const kit = (await runTool(c, 'create_kit', {}, 'user')).result as { kit_id: string };
    await runTool(c, 'set_pad', { kit_id: kit.kit_id, pad: 6, source_id: 's-kick' }, 'user');
    const s0 = c.store.get();
    const r = await runTool(c, 'star_sound', { kit_id: kit.kit_id, pad: 6 }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { name: 'Kick', from: 'pad' } });
    expect(jobs).toEqual([{ kind: 'source', sourceId: 's-kick' }]);
    expect(c.shelf!.audio((r.result as { shelf_id: string }).shelf_id)).toEqual(wav(1));
    expect(c.store.get()).toBe(s0);
    expect((await runTool(c, 'star_sound', { source_id: 's-kick' }, 'user')).result).toMatchObject({ already: true });
    expect((await runTool(c, 'star_sound', { kit_id: kit.kit_id, pad: 0 }, 'user')).error).toMatch(/no sound on it/);
  });

  it('export a track through its effects to My Sounds, with how it was made', async () => {
    const { c, jobs } = ctx();
    await withTrack(c);
    const r = await runTool(c, 'export_sound', { track_id: 't1', name: 'Big vox' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { name: 'Big vox', shelf: 'My Sounds', from: 'export', reopenable: true, chain: ['eq', 'utility', 'comp'], effect_tail_s: 1.2, duration: 3.2 } });
    expect(jobs).toEqual([{ kind: 'sound', trackId: 't1' }]);
    const id = (r.result as { shelf_id: string }).shelf_id;
    expect(c.shelf!.audio(id)).toEqual(wav(2));
    expect(c.shelf!.recipeAudio(id)).toEqual(wav(3));
    expect(museSummary(c)).toMatch(/Shelves .*My Sounds: sh-\w+ "Big vox"/);
  });

  it('export the selected region by default, and a recording as it is', async () => {
    const { c, jobs } = ctx();
    await withTrack(c);
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    expect((await runTool(c, 'export_sound', {}, 'user')).result).toMatchObject({ from_clip: 'c2', from_track: 't1' });
    expect(jobs.at(-1)).toEqual({ kind: 'sound', trackId: 't1', clipIds: ['c2'] });
    await runTool(c, 'add_sound', { source_id: 's-take', name: 'Take 3', duration: 0.5, origin: 'record' }, 'user');
    expect((await runTool(c, 'export_sound', { source_id: 's-take' }, 'user')).result).toMatchObject({ name: 'Take 3', from: 'recording', shelf: 'My Sounds' });
    const empty = (await runTool(c, 'add_track', {}, 'user')).result as { track_id: string };
    expect((await runTool(c, 'export_sound', { track_id: empty.track_id }, 'user')).error).toMatch(/no regions/);
  });

  it('find a sound, then put the starred kick on pad Q', async () => {
    const { c, adopted } = ctx();
    await runTool(c, 'star_sound', { library_id: 'fs:1' }, 'user');
    await withTrack(c);
    await runTool(c, 'export_sound', { track_id: 't1' }, 'user');
    const found = await runTool(c, 'find_sound_in_shelf', { query: 'kick' }, 'muse');
    expect(found).toMatchObject({ ok: true, result: { count: 1, sounds: [{ name: 'Dusty kick', shelf: 'Starred' }] } });
    expect((await runTool(c, 'find_sound_in_shelf', { shelf: 'mine' }, 'muse')).result).toMatchObject({ count: 1, sounds: [{ name: 'Vox' }] });
    const kit = (await runTool(c, 'create_kit', {}, 'muse')).result as { kit_id: string };
    const shelfId = (found.result as { sounds: { shelf_id: string }[] }).sounds[0].shelf_id;
    const before = c.store.get();
    const used = await runTool(c, 'use_shelf_sound', { shelf_id: shelfId, kit_id: kit.kit_id, pad: 0 }, 'muse');
    expect(used).toMatchObject({ ok: true, result: { name: 'Dusty kick', kit_id: kit.kit_id, pad: 0 } });
    const sourceId = (used.result as { source_id: string }).source_id;
    expect(adopted.get(sourceId)).toEqual({ library: 'fs:1' });
    const s = c.store.get();
    expect(s.sources[sourceId]).toMatchObject({ name: 'Dusty kick', duration: 0.4, origin: 'freesound' });
    expect(s.kits![kit.kit_id].pads[0].sample?.sourceId).toBe(sourceId);
    // one undo step brings it all back
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().kits).toEqual(before.kits);
    expect(c.store.get().sources[sourceId]).toBeDefined(); // audio stays loaded (store.restored)
  });

  it('use_shelf_sound can place a sound on a new track', async () => {
    const { c, adopted } = ctx();
    await withTrack(c);
    const exp = (await runTool(c, 'export_sound', { track_id: 't1' }, 'user')).result as { shelf_id: string };
    const r = await runTool(c, 'use_shelf_sound', { shelf_id: exp.shelf_id, place: true, start: 2 }, 'user');
    expect(r).toMatchObject({ ok: true, result: { track_id: 't6', start: 2 } });
    expect(adopted.get((r.result as { source_id: string }).source_id)).toEqual({ bytes: wav(2) });
  });

  it('reopen an export: its source on a new track with the same chain', async () => {
    const { c, adopted } = ctx();
    await withTrack(c);
    const exp = (await runTool(c, 'export_sound', { track_id: 't1' }, 'user')).result as { shelf_id: string };
    const r = await runTool(c, 'reopen_sound', { shelf_id: exp.shelf_id }, 'muse');
    expect(r.ok).toBe(true);
    const { track_id, source_id } = r.result as { track_id: string; source_id: string };
    expect(adopted.get(source_id)).toEqual({ bytes: wav(3) });
    const s = c.store.get();
    const [a, b] = [s.tracks[0], s.tracks.find((t) => t.id === track_id)!];
    expect(b.devices.map((d) => [d.kind, d.on, d.params])).toEqual(a.devices.map((d) => [d.kind, d.on, d.params]));
    expect(b.clips).toMatchObject([{ sourceId: source_id, start: 0 }]);
    expect(s.sources[source_id]).toMatchObject({ name: 'Vox (source)', duration: 2 }); // the audio before the effects, not the export's length
    // a starred library sound has no recipe
    await runTool(c, 'star_sound', { library_id: 'fs:1' }, 'user');
    const star = c.shelf!.list('starred')[0];
    expect((await runTool(c, 'reopen_sound', { shelf_id: star.id }, 'user')).error).toMatch(/only exports/);
  });

  it('keep the shelves on disk across launches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-shelf-'));
    const { c } = ctx(new FileSoundShelf(dir));
    await withTrack(c);
    await runTool(c, 'star_sound', { library_id: 'fs:1' }, 'user');
    const exp = (await runTool(c, 'export_sound', { track_id: 't1' }, 'user')).result as { shelf_id: string };
    const again = new FileSoundShelf(dir); // next launch
    expect(again.list().map((i) => [i.shelf, i.name])).toEqual([['mine', 'Vox'], ['starred', 'Dusty kick']]);
    expect(again.audio(exp.shelf_id)).toEqual(wav(2));
    expect(again.recipeAudio(exp.shelf_id)).toEqual(wav(3));
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).items).toHaveLength(2);
  });
});

describe('dry / wet (B18)', () => {
  it('set_mix_view bypasses every effect in what is heard, keeping devices, gain and pan', async () => {
    const { c, jobs } = ctx();
    await withTrack(c);
    const devices = c.store.get().tracks[0].devices;
    const r = await runTool(c, 'set_mix_view', { mode: 'dry' }, 'user');
    expect(r).toMatchObject({ ok: true, result: { mode: 'dry', match_loudness: true, dry_gain_db: 4.5, devices_changed: false } });
    expect(jobs).toEqual([{ kind: 'loudness' }]);
    const s = c.store.get();
    expect(s.tracks[0].devices).toBe(devices); // the session's devices are unchanged
    expect(s.mixView).toEqual({ mode: 'dry', matchLoudness: true, dryGainDb: 4.5 });
    const heard = heardSession(s).tracks[0].devices;
    expect(heard.map((d) => d.kind)).toEqual(['utility', 'utility']); // the track's utility (gain + pan only) and the match gain
    expect(heard[0].params).toMatchObject({ gain: -3, pan: 0.4, width: 100 });
    expect(heard[1].params).toMatchObject({ gain: 4.5 });
    expect(c.store.canUndo()).toBe(true);
    // a listening switch is not an edit: no undo step, and undo keeps it
    const label = c.store.undo();
    expect(label).toMatch(/insert_device/);
    expect(c.store.get().mixView?.mode).toBe('dry');
    expect(museSummary(c)).toMatch(/Listening: DRY.*\+4\.5 dB/);
    await runTool(c, 'set_mix_view', { mode: 'wet' }, 'user');
    expect(heardSession(c.store.get())).toBe(c.store.get());
    expect(museSummary(c)).not.toMatch(/Listening/);
  });

  it('match_loudness false plays dry unmatched', async () => {
    const { c, jobs } = ctx();
    await withTrack(c);
    await runTool(c, 'set_mix_view', { mode: 'dry', match_loudness: false }, 'user');
    expect(jobs).toEqual([]);
    expect(heardSession(c.store.get()).tracks[0].devices).toHaveLength(1);
  });

  it('export_stems renders a dry and a wet set, one file per track', async () => {
    const { c, jobs, saved } = ctx();
    await withTrack(c);
    await runTool(c, 'import_audio', { source_id: 'src-gtr', name: 'Gtr: left/right', duration: 2 }, 'user');
    const r = await runTool(c, 'export_stems', {}, 'muse');
    expect(r).toMatchObject({ ok: true, result: { sets: ['dry', 'wet'], tracks: 2 } });
    expect(jobs).toEqual([{ kind: 'stems', set: 'dry' }, { kind: 'stems', set: 'wet' }]);
    expect(saved[0]).toEqual([
      { set: 'dry', name: '01 Vox.wav' }, { set: 'dry', name: '02 Gtr_ left_right.wav' },
      { set: 'wet', name: '01 Vox.wav' }, { set: 'wet', name: '02 Gtr_ left_right.wav' },
    ]);
  });

  it('signal helpers: trim trailing silence, gated loudness, matching gain', () => {
    const sr = 1000;
    const a = new Float32Array(1000);
    a.fill(0.5, 0, 300);
    const [t] = trimTrailingSilence([a], sr, { padS: 0.01, fadeS: 0.005 });
    expect(t.length).toBe(310);
    expect(t[309]).toBe(0);
    expect(gatedRmsDb([a], sr)).toBeCloseTo(10 * Math.log10((0.25 * 300) / 400), 1); // the silent blocks are gated out
    expect(matchingGainDb({ wetDb: -12, dryDb: -16 })).toBe(4);
    expect(matchingGainDb({ wetDb: -Infinity, dryDb: -16 })).toBe(0);
    expect(stemName(0, 'a/b')).toBe('01 a_b');
    const s = { tracks: [{ devices: [], gainDb: 0 }] } as never;
    expect(drySession(s).tracks[0].devices).toEqual([]);
    expect(dryDevices({ devices: [] } as never, 3)).toHaveLength(1);
  });
});
