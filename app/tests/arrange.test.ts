// Clip moves across tracks, snap math, undo/redo, and the hand-edit log Muse reads.
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { cycleAround, gridSeconds, snapCycle, snapMove, snapTime } from '../src/core/snap';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

const m44 = { tempo: 120, timeSignature: [4, 4] as [number, number] };

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

async function twoTracks() {
  const c = ctx();
  await runTool(c, 'import_audio', { source_id: 'a', name: 'Drums', duration: 4 }, 'user'); // t1, c2
  await runTool(c, 'import_audio', { source_id: 'b', name: 'Bass', duration: 2 }, 'user'); // t3, c4
  c.store.takeUserEdits();
  return c;
}

describe('snap math', () => {
  it('computes grid sizes from tempo and meter', () => {
    expect(gridSeconds('beat', m44)).toBe(0.5);
    expect(gridSeconds('bar', m44)).toBe(2);
    expect(gridSeconds('off', m44)).toBe(0);
    expect(gridSeconds('bar', { tempo: 90, timeSignature: [6, 8] })).toBeCloseTo(2); // 6 eighths at 90 BPM
    expect(gridSeconds('beat', { tempo: 90, timeSignature: [6, 8] })).toBeCloseTo(1 / 3);
    expect(gridSeconds('sixteenth', m44)).toBe(0.125); // a quarter of a 120 BPM quarter note
    expect(gridSeconds('sixteenth', { tempo: 90, timeSignature: [6, 8] })).toBeCloseTo(1 / 6); // half an eighth
  });

  it('snaps to the nearest line and never before zero', () => {
    expect(snapTime(1.26, 'beat', m44)).toBe(1.5);
    expect(snapTime(1.24, 'beat', m44)).toBe(1);
    expect(snapTime(1.19, 'sixteenth', m44)).toBe(1.25);
    expect(snapTime(1.06, 'sixteenth', m44)).toBe(1.0);
    expect(snapTime(2.9, 'bar', m44)).toBe(2);
    expect(snapTime(3.1, 'bar', m44)).toBe(4);
    expect(snapTime(-0.7, 'bar', m44)).toBe(0);
    expect(snapTime(1.23456, 'off', m44)).toBe(1.235);
  });

  it('snaps the clip start, not the drag distance', () => {
    // a clip at 0.3 s dragged by 1 s lands on the beat nearest 1.3 s
    expect(snapMove(0.3, 1, 'beat', m44)).toBe(1.5);
    expect(snapMove(0.3, 1, 'off', m44)).toBe(1.3);
  });
});

describe('moving clips', () => {
  it('moves in time on the same track', () => {
    let s = S.addSource(S.emptySession(), { id: 'a', name: 'A', duration: 4, origin: 'import' });
    const [s1, t] = S.addTrack(s, 'A');
    const [s2, c] = S.addClip(s1, t.id, 'a', 1);
    s = S.moveClip(s2, c.id, 3.5);
    expect(S.findClip(s, c.id)).toMatchObject({ track: { id: t.id }, clip: { start: 3.5 } });
    expect(S.moveClip(s, c.id, -2).tracks[0].clips[0].start).toBe(0);
  });

  it('moves a clip onto another track, keeping id, trim and selection', async () => {
    const c = await twoTracks();
    await runTool(c, 'trim_clip', { clip_id: 'c2', start: 1, end: 3 }, 'user');
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    const r = await runTool(c, 'move_clip', { clip_id: 'c2', start: 6, track_id: 't3' }, 'user');
    expect(r).toMatchObject({ ok: true, result: { from_track: 't1', track_id: 't3', start: 6 } });
    const s = c.store.get();
    expect(s.tracks[0].clips).toHaveLength(0);
    expect(s.tracks[1].clips.map((x) => x.id)).toEqual(['c4', 'c2']);
    expect(S.findClip(s, 'c2').clip).toMatchObject({ start: 6, offset: 1, duration: 2 });
    expect(s.selection).toEqual({ trackId: 't3', clipId: 'c2' });
  });

  it('rejects unknown destination tracks', async () => {
    const c = await twoTracks();
    const r = await runTool(c, 'move_clip', { clip_id: 'c2', start: 1, track_id: 't99' }, 'user');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no track/);
    expect(c.store.get().tracks[0].clips).toHaveLength(1);
  });

  it('logs the move as a readable hand edit for Muse', async () => {
    const c = await twoTracks();
    await runTool(c, 'move_clip', { clip_id: 'c2', start: 2, track_id: 't3' }, 'user');
    await runTool(c, 'move_clip', { clip_id: 'c4', start: 4 }, 'user');
    expect(c.store.takeUserEdits()).toEqual(['moved clip c2 from t1 @0s to t3 @2s', 'moved clip c4 on t3 from 0s to 4s']);
  });

  it('lets Muse move clips too (light arranging)', () => {
    const spec = museToolSpecs().find((t) => t.function.name === 'move_clip')!;
    expect(Object.keys(spec.function.parameters.properties)).toEqual(['clip_id', 'start', 'track_id']);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes a cross-track move, keeping the transport', async () => {
    const c = await twoTracks();
    await runTool(c, 'move_clip', { clip_id: 'c2', start: 2, track_id: 't3' }, 'user');
    await runTool(c, 'play', { from: 1 }, 'user'); // transport is not part of undo
    const u = await runTool(c, 'undo', {}, 'user');
    expect(u).toMatchObject({ ok: true, result: { undone: 'moved clip c2 from t1 @0s to t3 @2s' } });
    let s = c.store.get();
    expect(S.findClip(s, 'c2')).toMatchObject({ track: { id: 't1' }, clip: { start: 0 } });
    expect(s.transport.playing).toBe(true);
    await runTool(c, 'redo', {}, 'user');
    s = c.store.get();
    expect(S.findClip(s, 'c2')).toMatchObject({ track: { id: 't3' }, clip: { start: 2 } });
    expect(c.store.takeUserEdits()).toContain('undo (moved clip c2 from t1 @0s to t3 @2s)');
  });

  it('skips quiet tools and reports when there is nothing to undo', async () => {
    const c = ctx();
    await runTool(c, 'go_to', { position: 3 }, 'user');
    const r = await runTool(c, 'undo', {}, 'user');
    expect(r).toMatchObject({ ok: false, error: 'nothing to undo' });
  });

  it('never reuses ids after an undo', async () => {
    const c = await twoTracks();
    await runTool(c, 'add_track', { name: 'X' }, 'user'); // t5
    await runTool(c, 'undo', {}, 'user');
    const r = await runTool(c, 'add_track', { name: 'Y' }, 'user');
    expect(r.result).toMatchObject({ track_id: 't6' });
  });
});

describe('placing library sounds and arming', () => {
  it('places audio on an existing track or a new one, with a credit', async () => {
    const c = await twoTracks();
    const on = await runTool(c, 'place_audio', { source_id: 'k', name: 'Kick', duration: 0.4, origin: 'freesound', track_id: 't1', start: 2 }, 'user');
    expect(on.result).toMatchObject({ track_id: 't1', start: 2 });
    const credit = '"Kick" by someone (https://freesound.org/x), licensed under CC-BY 4.0.';
    const fresh: any = await runTool(c, 'place_audio', { source_id: 'v', name: 'Vox', duration: 3, origin: 'freesound', credit }, 'user');
    const s = c.store.get();
    expect(s.tracks).toHaveLength(3);
    expect(s.tracks[2]).toMatchObject({ id: fresh.result.track_id, name: 'Vox' });
    expect(s.sources.v.credit).toBe(credit);
    expect(s.selection.clipId).toBe(fresh.result.clip_id);
    expect(c.store.takeUserEdits()[0]).toMatch(/^placed "Kick" \(freesound\) on t1 at 2s/);
  });

  it('arms one track at a time and shows it to Muse', async () => {
    const c = await twoTracks();
    await runTool(c, 'arm_track', { track_id: 't1' }, 'user');
    await runTool(c, 'arm_track', { track_id: 't3' }, 'user');
    const s = c.store.get();
    expect(s.tracks.map((t) => !!t.armed)).toEqual([false, true]);
    expect(S.summarize(s)).toContain('"Bass" gain 0 dB (record-armed)');
  });

  it('deletes a clip and clears it from the selection', async () => {
    const c = await twoTracks();
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    await runTool(c, 'delete_clip', { clip_id: 'c2' }, 'user');
    expect(c.store.get().tracks[0].clips).toHaveLength(0);
    expect(c.store.get().selection).toEqual({ trackId: 't1', clipId: null });
  });
});

describe('multi-select, group moves and track order', () => {
  async function threeClips() {
    const c = await twoTracks(); // t1:c2 at 0 (4 s), t3:c4 at 0 (2 s)
    await runTool(c, 'move_clip', { clip_id: 'c4', start: 1 }, 'user');
    await runTool(c, 'import_audio', { source_id: 'v', name: 'Vox', duration: 1 }, 'user'); // t5, c6
    c.store.takeUserEdits();
    return c;
  }

  it('select keeps several clips, the last clicked one primary', async () => {
    const c = await threeClips();
    await runTool(c, 'select', { track_id: 't3', clip_id: 'c4', clip_ids: ['c2', 'c4'] }, 'user');
    expect(c.store.get().selection).toEqual({ trackId: 't3', clipId: 'c4', clipIds: ['c2', 'c4'] });
    expect(S.selectedClipIds(c.store.get())).toEqual(['c2', 'c4']);
    expect(S.summarize(c.store.get())).toContain('selected clips c2, c4');
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    expect(c.store.get().selection).toEqual({ trackId: 't1', clipId: 'c2' });
  });

  it('moves the selected clips together, keeping their shape, in one undo step', async () => {
    const c = await threeClips();
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2', clip_ids: ['c2', 'c4'] }, 'user');
    const r = await runTool(c, 'move_clips', { delta: 2, track_offset: 1 }, 'user');
    expect(r.ok).toBe(true);
    const s = c.store.get();
    expect(S.findClip(s, 'c2')).toMatchObject({ track: { id: 't3' }, clip: { start: 2 } });
    expect(S.findClip(s, 'c4')).toMatchObject({ track: { id: 't5' }, clip: { start: 3 } });
    expect(s.selection).toMatchObject({ trackId: 't3', clipId: 'c2', clipIds: ['c2', 'c4'] });
    expect(c.store.takeUserEdits()).toEqual(['moved clips c2, c4 together by 2s and 1 track down']);
    await runTool(c, 'undo', {}, 'user');
    expect(S.findClip(c.store.get(), 'c4')).toMatchObject({ track: { id: 't3' }, clip: { start: 1 } });
  });

  it('clamps a group move so no clip leaves the timeline or the track list', () => {
    let s = S.addSource(S.emptySession(), { id: 'a', name: 'A', duration: 1, origin: 'import' });
    const [s1, t1] = S.addTrack(s, 'A');
    const [s2, t2] = S.addTrack(s1, 'B');
    const [s3, a] = S.addClip(s2, t1.id, 'a', 1);
    const [s4, b] = S.addClip(s3, t2.id, 'a', 3);
    s = S.moveClips(s4, [a.id, b.id], -5, 3);
    expect(S.findClip(s, a.id)).toMatchObject({ track: { id: t1.id }, clip: { start: 0 } });
    expect(S.findClip(s, b.id)).toMatchObject({ track: { id: t2.id }, clip: { start: 2 } });
  });

  it('deletes the selected clips at once', async () => {
    const c = await threeClips();
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2', clip_ids: ['c2', 'c6'] }, 'user');
    await runTool(c, 'delete_clips', {}, 'user');
    const s = c.store.get();
    expect(s.tracks.map((t) => t.clips.map((x) => x.id))).toEqual([[], ['c4'], []]);
    expect(S.selectedClipIds(s)).toEqual([]);
  });

  it('reorders tracks, and Muse can too', async () => {
    const c = await threeClips();
    const r = await runTool(c, 'move_track', { track_id: 't5', index: 0 }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { from: 2, index: 0 } });
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t5', 't1', 't3']);
    await runTool(c, 'move_track', { track_id: 't5', index: 99 }, 'user');
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t1', 't3', 't5']);
    expect(c.store.takeUserEdits()).toEqual(['moved track t5 from position 1 to 3']);
  });

  it('a moved track keeps its colour, and a new track takes the next one', async () => {
    const c = await threeClips();
    await runTool(c, 'move_track', { track_id: 't5', index: 0 }, 'user');
    expect(c.store.get().tracks.map((t) => t.color)).toEqual([2, 0, 1]);
    const [s] = S.addTrack(c.store.get());
    expect(s.tracks.map((t) => t.color)).toEqual([2, 0, 1, 3]);
    const s2 = S.addTrack(S.addTrack(S.emptySession())[0])[0];
    expect(s2.tracks.map((t) => t.color)).toEqual([0, 1]);
  });

  it('cycle area: whole bars around the selection, and ruler drags on the grid', () => {
    // Snap: Beat (0.5 s at 120 BPM): clips from beat 1.4 (1.5 s) to just before 2.4 (3.5 s)
    expect(cycleAround(1.5, 3.2, 'beat', m44)).toEqual({ start: 1.5, end: 3.5 });
    expect(cycleAround(1.6, 3.5, 'beat', m44)).toEqual({ start: 1.5, end: 3.5 }); // ends on a beat
    expect(cycleAround(2.3, 5.1, 'bar', m44)).toEqual({ start: 2, end: 6 });
    expect(cycleAround(0.1, 0.2, 'bar', m44)).toEqual({ start: 0, end: 2 });
    expect(cycleAround(1.3, 1.36, 'sixteenth', m44)).toEqual({ start: 1.25, end: 1.375 });
    expect(cycleAround(1.234, 2.5, 'off', m44)).toEqual({ start: 1.234, end: 2.5 });
    expect(snapCycle(2.1, 3.9, 'beat', m44)).toEqual({ start: 2, end: 4 });
    expect(snapCycle(2, 4, 'beat', m44)).toBeNull(); // already on the grid
    expect(snapCycle(2.1, 2.2, 'bar', m44)).toEqual({ start: 2, end: 4 }); // never collapses
    expect(snapCycle(2.1, 3.9, 'off', m44)).toBeNull();
  });
});
