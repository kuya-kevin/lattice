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

  it('rejects an unknown sound', async () => {
    const r = await runTool(ctx(), 'delete_sound', { source_id: 'nope' }, 'user');
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
