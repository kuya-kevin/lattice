import { describe, expect, it } from 'vitest';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { tapTempo } from '../src/core/tapTempo';
import { runTool, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

describe('delete_sound', () => {
  it('removes the sound and every clip that uses it, in one undo step', async () => {
    const c = ctx();
    await runTool(c, 'import_audio', { source_id: 'a', name: 'Kick', duration: 1 }, 'user');
    await runTool(c, 'import_audio', { source_id: 'b', name: 'Bass', duration: 2 }, 'user');
    const [t1, t2] = c.store.get().tracks;
    const kickClip = t1.clips[0].id;
    expect((await runTool(c, 'duplicate_clip', { clip_id: kickClip, start: 4, track_id: t2.id }, 'user')).ok).toBe(true);
    await runTool(c, 'select', { track_id: t1.id, clip_id: kickClip }, 'user');
    c.store.takeUserEdits();

    const r = await runTool(c, 'delete_sound', { source_id: 'a' }, 'user');
    expect(r).toMatchObject({ ok: true, result: { deleted: 'a', clips_removed: 2 } });
    const s = c.store.get();
    expect(s.sources.a).toBeUndefined();
    expect(s.sources.b).toBeDefined();
    expect(s.tracks.flatMap((t) => t.clips).map((x) => x.sourceId)).toEqual(['b']);
    expect(s.selection.clipId).toBeNull();
    expect(c.store.takeUserEdits().join('\n')).toMatch(/deleted sound "Kick"/);

    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().sources.a).toBeDefined();
    expect(c.store.get().tracks.flatMap((t) => t.clips)).toHaveLength(3);
  });

  it('MIDI takes played with the sound keep their notes and go back to the piano', async () => {
    const c = ctx();
    await runTool(c, 'import_audio', { source_id: 'a', name: 'Synth', duration: 2 }, 'user');
    const t = c.store.get().tracks[0];
    const notes = [{ pitch: 60, velocity: 100, start: 0, duration: 0.5 }];
    const rec = await runTool(c, 'record_midi', { track_id: t.id, start: 4, duration: 1, notes, instrument: 'Synth', sample: { source_id: 'a', offset: 0, duration: 2, root: 60 } }, 'user');
    expect(rec.ok).toBe(true);
    await runTool(c, 'delete_sound', { source_id: 'a' }, 'user');
    const clips = c.store.get().tracks.flatMap((x) => x.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0].midi).toEqual({ instrument: 'piano', notes });
  });

  it('rejects an unknown sound', async () => {
    const r = await runTool(ctx(), 'delete_sound', { source_id: 'nope' }, 'user');
    expect(r.ok).toBe(false);
  });
});

describe('add_sound and place_sound (Ideas before tracks)', () => {
  it('adds a sound on no track, then places it on a new track and on an existing one', async () => {
    const c = ctx();
    expect((await runTool(c, 'add_sound', { source_id: 'p', name: 'Pluck', duration: 1.5, origin: 'freesound', credit: 'by x' }, 'user')).ok).toBe(true);
    let s = c.store.get();
    expect(s.sources.p).toMatchObject({ name: 'Pluck', origin: 'freesound', credit: 'by x' });
    expect(s.tracks).toHaveLength(0);
    expect(c.store.takeUserEdits().join('\n')).toMatch(/added "Pluck".*not on a track/);

    const r = await runTool(c, 'place_sound', { source_id: 'p', start: 2 }, 'user');
    expect(r).toMatchObject({ ok: true, result: { start: 2 } });
    s = c.store.get();
    expect(s.tracks.map((t) => t.name)).toEqual(['Pluck']);
    expect(s.tracks[0].clips[0]).toMatchObject({ sourceId: 'p', start: 2, offset: 0, duration: 1.5 });
    expect(s.selection).toEqual({ trackId: s.tracks[0].id, clipId: s.tracks[0].clips[0].id });

    await runTool(c, 'place_sound', { source_id: 'p', track_id: s.tracks[0].id, start: 4 }, 'user');
    expect(c.store.get().tracks[0].clips.map((x) => x.start)).toEqual([2, 4]);
    await runTool(c, 'undo', {}, 'user');
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks).toHaveLength(0);
    expect(c.store.get().sources.p).toBeDefined();
  });

  it('place_sound rejects an unknown sound', async () => {
    const r = await runTool(ctx(), 'place_sound', { source_id: 'nope' }, 'user');
    expect(r.ok).toBe(false);
  });
});

describe('tapTempo', () => {
  it('needs two taps, then averages the recent intervals', () => {
    let st = tapTempo(undefined, 0);
    expect(st.bpm).toBeNull();
    st = tapTempo(st, 500);
    expect(st.bpm).toBe(120);
    st = tapTempo(st, 1000);
    st = tapTempo(st, 1520); // a slightly late tap barely moves it
    expect(st.bpm).toBe(118);
  });

  it('starts over after a 2 s pause, and clamps to 40-240', () => {
    let st = tapTempo(tapTempo(undefined, 0), 500);
    st = tapTempo(st, 3000);
    expect(st.bpm).toBeNull();
    st = tapTempo(st, 3100); // 600 BPM
    expect(st.bpm).toBe(240);
  });
});
