// rename_track / delete_track / duplicate_clip: the session ops and the tools (undoable,
// visible to Muse), plus the Cmd-C / Cmd-V key mapping.
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { editShortcutFor } from '../src/renderer/shortcuts';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

/** t1 "Drums" with clip c2 (source s, 8 s), trimmed to 1-5 s; empty t3 "Bass". */
async function twoTracks() {
  const c = ctx();
  await runTool(c, 'import_audio', { source_id: 's', name: 'Drums', duration: 8 }, 'user');
  await runTool(c, 'trim_clip', { clip_id: 'c2', start: 1, end: 5 }, 'user');
  await runTool(c, 'add_track', { name: 'Bass' }, 'user');
  c.store.takeUserEdits();
  return c;
}

describe('track rename / delete', () => {
  it('renames a track (trimmed) and refuses an empty name', () => {
    const [s] = S.addTrack(S.emptySession(), 'Vox');
    expect(S.getTrack(S.renameTrack(s, 't1', '  Lead vox '), 't1').name).toBe('Lead vox');
    expect(() => S.renameTrack(s, 't1', '   ')).toThrow(S.SessionError);
    expect(() => S.renameTrack(s, 't9', 'x')).toThrow(/no track/);
  });

  it('deletes a track and clears selection and punch-in on it, keeping the sources', () => {
    let s = S.addSource(S.emptySession(), { id: 'src', name: 'Vox', duration: 4, origin: 'import' });
    const [s1, a] = S.addTrack(s, 'A');
    const [s2, b] = S.addTrack(s1, 'B');
    const [s3, clip] = S.addClip(s2, a.id, 'src', 0);
    s = S.armPunchIn(S.select(s3, a.id, clip.id), a.id, 1, 2);
    const out = S.deleteTrack(s, a.id);
    expect(out.tracks.map((t) => t.id)).toEqual([b.id]);
    expect(out.selection).toEqual({ trackId: null, clipId: null });
    expect(out.punchIn).toBeNull();
    expect(out.sources.src).toBeDefined();
    // a selection elsewhere survives
    const other = S.deleteTrack(S.select(s, b.id, null), a.id);
    expect(other.selection).toEqual({ trackId: b.id, clipId: null });
  });

  it('rename_track and delete_track are undoable, logged, and visible to Muse', async () => {
    const c = await twoTracks();
    expect(museToolSpecs().map((t) => t.function.name)).toEqual(expect.arrayContaining(['rename_track', 'delete_track', 'duplicate_clip']));

    expect(await runTool(c, 'rename_track', { track_id: 't1', name: 'Kit' }, 'muse')).toMatchObject({ ok: true, result: { name: 'Kit' } });
    expect((await runTool(c, 'rename_track', { track_id: 't1', name: ' ' }, 'muse')).error).toMatch(/empty/);
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    expect(await runTool(c, 'delete_track', { track_id: 't1' }, 'user')).toMatchObject({ ok: true, result: { deleted: 't1', clips: 1 } });
    expect(c.store.takeUserEdits()).toEqual(['deleted track t1 "Kit" (1 clip)']);
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t3']);
    expect(c.store.get().selection).toEqual({ trackId: null, clipId: null });

    await runTool(c, 'undo', {}, 'user'); // track and its trimmed clip come back
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(S.findClip(c.store.get(), 'c2').clip).toMatchObject({ start: 1, offset: 1, duration: 4 });
    await runTool(c, 'undo', {}, 'user'); // the rename
    expect(S.getTrack(c.store.get(), 't1').name).toBe('Drums');
    await runTool(c, 'redo', {}, 'user');
    await runTool(c, 'redo', {}, 'user');
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t3']);
  });
});

describe('duplicate_clip (copy / paste)', () => {
  it('copies source, trim and MIDI notes to a new id at the given start', () => {
    const [s0, t] = S.addTrack(S.emptySession(), 'Keys');
    const midi = { instrument: 'piano', notes: [{ pitch: 60, start: 0.5, duration: 0.5, velocity: 90 }] };
    const [s1, m] = S.addMidiClip(s0, t.id, { name: 'Chords', midi, sourceDuration: 4, offset: 0.5, duration: 2 });
    const [s2, copy] = S.duplicateClip(s1, m.id, 6.12345);
    expect(copy).toEqual({ ...m, id: copy.id, start: 6.123 });
    expect(copy.id).not.toBe(m.id);
    expect(S.getTrack(s2, t.id).clips).toHaveLength(2);
    expect(() => S.duplicateClip(s1, m.id, 0, 't9')).toThrow(/no track/);
  });

  it('pastes onto another track, selects the copy, twice, and undoes one paste at a time', async () => {
    const c = await twoTracks();
    const r1 = await runTool(c, 'duplicate_clip', { clip_id: 'c2', start: 4, track_id: 't3' }, 'user');
    expect(r1).toMatchObject({ ok: true, result: { from_clip: 'c2', track_id: 't3', start: 4 } });
    const r2 = await runTool(c, 'duplicate_clip', { clip_id: 'c2', start: 8, track_id: 't3' }, 'user');
    const s = c.store.get();
    const bass = S.getTrack(s, 't3').clips;
    expect(bass.map((x) => x.start)).toEqual([4, 8]);
    for (const x of bass) expect(x).toMatchObject({ sourceId: 's', offset: 1, duration: 4, name: 'Drums' });
    expect(new Set([...bass.map((x) => x.id), 'c2']).size).toBe(3);
    expect(s.selection).toEqual({ trackId: 't3', clipId: (r2.result as any).clip_id });
    expect(c.store.takeUserEdits()).toEqual([
      `copied clip c2 to t3 @4s as clip ${(r1.result as any).clip_id}`,
      `copied clip c2 to t3 @8s as clip ${(r2.result as any).clip_id}`,
    ]);

    await runTool(c, 'undo', {}, 'user');
    expect(S.getTrack(c.store.get(), 't3').clips.map((x) => x.start)).toEqual([4]);
    expect(c.store.get().selection.clipId).toBeNull(); // the undone copy is gone, so is its selection
    // without track_id the copy stays on the clip's own track
    expect(await runTool(c, 'duplicate_clip', { clip_id: 'c2', start: 0 }, 'muse')).toMatchObject({ ok: true, result: { track_id: 't1', start: 0 } });
    expect((await runTool(c, 'duplicate_clip', { clip_id: 'c99', start: 0 }, 'muse')).error).toMatch(/no clip/);
  });
});

describe('copy / paste keys', () => {
  const k = (key: string, o: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; tag: string }> = {}) => ({
    key, shiftKey: !!o.shiftKey, metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey, altKey: false,
    target: o.tag ? ({ tagName: o.tag.toUpperCase(), isContentEditable: false } as unknown as EventTarget) : null,
  });
  it('maps Cmd/Ctrl-C and -V, not while typing, and leaves plain C to cycle', () => {
    expect(editShortcutFor(k('c', { metaKey: true }))).toBe('copyClip');
    expect(editShortcutFor(k('v', { ctrlKey: true }))).toBe('pasteClip');
    expect(editShortcutFor(k('v', { metaKey: true, tag: 'textarea' }))).toBeNull();
    expect(editShortcutFor(k('c', { metaKey: true, tag: 'input' }))).toBeNull();
    expect(editShortcutFor(k('c'))).toBeNull();
    expect(editShortcutFor(k('V', { metaKey: true, shiftKey: true }))).toBeNull();
  });
});
