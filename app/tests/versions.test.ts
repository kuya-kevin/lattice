import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MuseAgent, type ChatFn } from '../src/core/agent';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import * as S from '../src/core/session';
import { loggedVersions, MemoryVersionLibrary, shownVersions } from '../src/core/versions';
import { changeStat, diffSessions, type Change } from '../src/core/versionDiff';
import { FileVersionLibrary, loadAutosave, SessionAutosave, SourceAudioFiles } from '../src/node/projectFiles';

const ctx = async (): Promise<ToolContext> => {
  const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }), versions: new MemoryVersionLibrary() };
  await runTool(c, 'import_audio', { source_id: 'a', name: 'Vox', duration: 4 }, 'user');
  c.store.takeUserEdits();
  return c;
};
const tmp = () => mkdtempSync(join(tmpdir(), 'lattice-project-'));
const kinds = (c: ToolContext) => c.store.get().tracks[0].devices.map((d) => d.kind);

describe('versions (B11)', () => {
  it('are exposed to Muse, except new_session', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['save_version', 'restore_version', 'list_versions']));
    expect(names).not.toContain('new_session');
  });

  it('save two versions, restore the first by name or id; restore is one undo step', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    const v1 = await runTool(c, 'save_version', { name: 'clean' }, 'user');
    expect(v1).toMatchObject({ ok: true, result: { id: 'v1', name: 'clean' } });
    await runTool(c, 'insert_device', { track_id: 't1', device: 'sat' }, 'user');
    await runTool(c, 'save_version', { name: 'dirty' }, 'muse');
    const tracksAt1 = c.versions!.get('v1')!.session.tracks;

    const r = await runTool(c, 'restore_version', { version: 'clean' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { restored: 'v1', name: 'clean' } });
    expect(c.store.get().tracks).toEqual(tracksAt1);
    c.store.undo();
    expect(kinds(c)).toEqual(['eq', 'sat']);
    await runTool(c, 'restore_version', { version: 'v1' }, 'user');
    expect(kinds(c)).toEqual(['eq']);
  });

  it('restore keeps ids fresh and the transport where it is', async () => {
    const c = await ctx();
    await runTool(c, 'save_version', { name: 'a' }, 'user');
    await runTool(c, 'add_track', { name: 'B' }, 'user');
    await runTool(c, 'go_to', { position: 3 }, 'user');
    const seq = c.store.get().seq;
    await runTool(c, 'restore_version', { version: 'a' }, 'user');
    expect(c.store.get().seq).toBe(seq);
    expect(c.store.get().transport.position).toBe(3);
    expect(c.store.get().tracks).toHaveLength(1);
  });

  it('list newest first with named/auto flags; errors are clear', async () => {
    const c = await ctx();
    expect(await runTool(c, 'save_version', { name: ' ' }, 'user')).toMatchObject({ ok: false, error: expect.stringMatching(/name/) });
    expect(await runTool(c, 'restore_version', { version: 'nope' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no version "nope"/) });
    await runTool(c, 'save_version', { name: 'one' }, 'user');
    c.versions!.save({ name: 'Before Muse: "x"', auto: true, session: c.store.get() });
    const l = await runTool(c, 'list_versions', {}, 'muse');
    expect(l).toMatchObject({ ok: true, result: { versions: [{ id: 'v2', auto: true }, { id: 'v1', name: 'one', auto: false }] } });
    const s0 = c.store.get();
    await runTool(c, 'save_version', { name: 'two' }, 'user');
    expect(c.store.get()).toBe(s0); // saving leaves the session and undo alone
  });

  it('new_session saves the old one as an auto version and starts empty (undoable)', async () => {
    const c = await ctx();
    const r = await runTool(c, 'new_session', {}, 'user');
    expect(r).toMatchObject({ ok: true, result: { saved_as: 'v1' } });
    expect(c.store.get().tracks).toEqual([]);
    expect(c.versions!.list()[0]).toMatchObject({ auto: true, name: 'Before new session' });
    c.store.undo();
    expect(c.store.get().tracks).toHaveLength(1);
  });

  it('Muse gets an auto version before each turn (not when nothing changed) and sees versions in its summary', async () => {
    const c = await ctx();
    const seen: string[] = [];
    const chat: ChatFn = async ({ messages }) => {
      seen.push(String(messages[messages.length - 1].content));
      return { message: { content: 'ok' }, finish_reason: 'stop' };
    };
    const agent = new MuseAgent(c, chat);
    await runTool(c, 'save_version', { name: 'clean' }, 'user');
    await runTool(c, 'insert_device', { track_id: 't1', device: 'sat' }, 'user');
    await agent.send('add more drive please, a lot more than before');
    await agent.send('again');
    const autos = c.versions!.list().filter((v) => v.auto);
    expect(autos).toHaveLength(1);
    expect(autos[0].name).toBe('Before Muse: "add more drive please, a lot more…"');
    expect(seen[0]).toContain('Versions: "clean"; 1 auto (list_versions shows them).');
  });

  it('hand edits after a Muse turn get their own row, apart from what Muse did', async () => {
    const c = await ctx();
    let n = 0;
    const chat: ChatFn = async () =>
      n++ === 0
        ? { message: { content: '', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'set_gain', arguments: JSON.stringify({ track_id: 't1', gain_db: -3 }) } }] }, finish_reason: 'tool_calls' }
        : { message: { content: 'done' }, finish_reason: 'stop' };
    const agent = new MuseAgent(c, chat);
    await agent.send('turn it down');
    expect(c.versions!.list().map((v) => v.name)).toEqual(['After Muse: "turn it down"', 'Before Muse: "turn it down"']);
    await runTool(c, 'insert_device', { track_id: 't1', device: 'sat' }, 'user');
    const r = (await runTool(c, 'list_versions', { changes: true }, 'user')) as any;
    const [after, before] = r.result.versions;
    expect(after.changes.map((x: Change) => x.text)).toEqual([expect.stringContaining('on ')]);
    expect(before.changes.map((x: Change) => x.text)).toEqual([expect.stringContaining('volume 0 dB → −3 dB')]);
    expect(loggedVersions(r.result.versions)).toHaveLength(2);
    // the next turn starts from an unchanged "After Muse": both rows stay, the empty one is hidden in the log
    await runTool(c, 'undo', {}, 'user');
    await agent.send('again');
    const rows = ((await runTool(c, 'list_versions', { changes: true }, 'user')) as any).result.versions;
    expect(rows.map((v: any) => v.name)).toContain('Before Muse: "again"');
  });
});

it('the Versions list shows named versions and the newest 20 auto ones', () => {
  const lib = new MemoryVersionLibrary();
  lib.save({ name: 'keep', auto: false, session: S.emptySession() });
  for (let i = 0; i < 25; i++) lib.save({ name: `auto ${i}`, auto: true, session: S.emptySession() });
  const { shown, hidden } = shownVersions(lib.list(), false);
  expect(shown).toHaveLength(21);
  expect(shown[0].name).toBe('auto 24');
  expect(shown.at(-1)!.name).toBe('keep');
  expect(hidden).toBe(5);
  expect(shownVersions(lib.list(), true).shown).toHaveLength(26);
});

describe('project files (Electron)', () => {
  it('FileVersionLibrary keeps versions across instances and loads bodies on demand', () => {
    const dir = join(tmp(), 'versions');
    const a = new FileVersionLibrary(dir);
    const s = { ...S.emptySession(), tempo: 97 };
    expect(a.save({ name: 'x', auto: false, session: s }).id).toBe('v1');
    a.save({ name: 'y', auto: true, session: S.emptySession() });
    const b = new FileVersionLibrary(dir);
    expect(b.list().map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(b.get('v1')!.session.tempo).toBe(97);
    expect(b.save({ name: 'z', auto: false, session: s }).id).toBe('v3');
  });

  it('autosave writes the session after edits settle and loadAutosave reads it back', async () => {
    const file = join(tmp(), 'session.json');
    const store = new SessionStore();
    const auto = new SessionAutosave(file, store, 20);
    const c: ToolContext = { store, sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
    await runTool(c, 'import_audio', { source_id: 'a', name: 'Vox', duration: 4 }, 'user');
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    expect(loadAutosave(file)).toBeNull(); // not yet: debounced
    await new Promise((r) => setTimeout(r, 60));
    const back = loadAutosave(file)!;
    expect(back.tracks).toEqual(store.get().tracks);
    expect(back.transport.playing).toBe(false);
    auto.dispose();
    writeFileSync(file, '{broken');
    expect(loadAutosave(file)).toBeNull();
  });

  it('SourceAudioFiles: imports by path, recordings as WAVs in the folder, library by id', () => {
    const dir = tmp();
    const orig = join(dir, 'take.wav');
    writeFileSync(orig, 'RIFF-import');
    const a = new SourceAudioFiles(join(dir, 'audio'));
    a.keep('s1', { path: orig });
    a.keep('s2', { bytes: new TextEncoder().encode('RIFF-rec') });
    a.keep('s3', { library: 'fs:123' });
    const b = new SourceAudioFiles(join(dir, 'audio'));
    expect(b.ref('s1')).toEqual({ path: orig });
    expect(new TextDecoder().decode(b.read('s1')!)).toBe('RIFF-import');
    expect(new TextDecoder().decode(b.read('s2')!)).toBe('RIFF-rec');
    expect(b.ref('s3')).toEqual({ library: 'fs:123' });
    expect(b.read('missing')).toBeNull();
  });
});

describe('version changes (Versions log)', () => {
  it('lists tracks, devices, knobs, clips and tempo in plain words', async () => {
    const c = await ctx();
    const before = c.store.get();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    await runTool(c, 'set_gain', { track_id: 't1', gain_db: -3 }, 'user');
    await runTool(c, 'add_track', { name: 'pad' }, 'user');
    await runTool(c, 'set_tempo', { bpm: 90 }, 'user');
    const changes = diffSessions(before, c.store.get());
    const texts = changes.map((x) => `${x.op} ${x.text}`);
    expect(texts).toEqual(expect.arrayContaining(['+ Channel EQ on Vox', '~ Vox volume 0 dB → −3 dB', '+ track “pad”', '~ tempo 120 → 90 BPM']));
    expect(changeStat(changes)).toMatchObject({ '+': 2, '-': 0, '~': 2 });
    // view state is not a change
    await runTool(c, 'select', { track_id: 't1' }, 'user');
    expect(diffSessions(c.store.get(), { ...c.store.get(), selection: { trackId: null, clipId: null } })).toEqual([]);
  });

  it('a knob move names the knob and both values; removing names what went', async () => {
    const c = await ctx();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'utility' }, 'user');
    const a = c.store.get();
    const dev = a.tracks[0].devices[0];
    const b = { ...a, tracks: [{ ...a.tracks[0], devices: [{ ...dev, params: { ...dev.params, gain: 6 } }], clips: [] }] };
    const texts = diffSessions(a, b).map((x) => `${x.op} ${x.text}`);
    expect(texts.find((t) => t.startsWith('~ Vox Utility: Gain'))).toMatch(/Gain .*0.* → .*6/);
    expect(texts).toContain('- clip “Vox” on Vox');
  });

  it('list_versions with changes: each version lists what came after it, the newest up to now', async () => {
    const c = await ctx();
    await runTool(c, 'save_version', { name: 'bare' }, 'user');
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    await runTool(c, 'save_version', { name: 'eq' }, 'user');
    await runTool(c, 'add_track', { name: 'pad' }, 'user');
    const r = await runTool(c, 'list_versions', { changes: true }, 'user');
    const v = (r.result as any).versions;
    expect(v.map((x: any) => x.name)).toEqual(['eq', 'bare']);
    expect(v[0].changes.map((x: Change) => x.text)).toEqual(['track “pad”']);
    expect(v[1].changes.map((x: Change) => x.text)).toEqual(['Channel EQ on Vox']);
    // without the flag the list stays short (what Muse usually reads)
    expect(((await runTool(c, 'list_versions', {}, 'user')).result as any).versions[0].changes).toBeUndefined();
  });
});
