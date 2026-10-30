// B16: the arrange / mix / track / edit tools for concrete instructions (core/editTools.ts), the
// bar arguments on move/copy/trim, exact knob values, and what the summary tells Muse so it can
// resolve "this", names and bars.
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { clipPart, deleteRange, insertTime, playoutFades } from '../src/core/editTools';
import { colorSlot, TRACK_COLOR_NAMES } from '../src/core/trackColors';
import { TRACK_COLORS } from '../src/renderer/TrackHeader';

/** 120 BPM 4/4 (a bar is 2 s): t1 "Drums" c2 0-8 s, t3 "Bass" c4 0-16 s, t5 "Vocal" c6 8-16 s. */
async function mix() {
  const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
  await runTool(c, 'import_audio', { source_id: 'src-d', name: 'Drums', duration: 8 }, 'user');
  await runTool(c, 'import_audio', { source_id: 'src-b', name: 'Bass', duration: 16 }, 'user');
  await runTool(c, 'import_audio', { source_id: 'src-v', name: 'Vocal', duration: 8 }, 'user');
  await runTool(c, 'move_clip', { clip_id: 'c6', start: 8 }, 'user');
  c.store.takeUserEdits();
  return c;
}
const muse = async (c: ToolContext, tool: string, args: Record<string, unknown>) => {
  const r = await runTool(c, tool, args, 'muse');
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.result as any;
};
const clips = (c: ToolContext, track: string) => S.getTrack(c.store.get(), track).clips.map((x) => [x.id, x.start, x.duration, x.offset]);

describe('Muse is offered a tool for each instruction family (B16)', () => {
  it('arrange, mix, tracks, edit and devices', () => {
    const names = new Set(museToolSpecs().map((t) => t.function.name));
    const families = {
      arrange: ['move_clip', 'move_clips', 'duplicate_clip', 'repeat_clip', 'delete_bars', 'insert_bars', 'copy_bars', 'split_clip'],
      mix: ['set_gain', 'set_pan', 'mute', 'solo'],
      tracks: ['add_track', 'duplicate_track', 'rename_track', 'set_track_color'],
      edit: ['quantize_midi', 'quantize_drums', 'transpose_midi', 'trim_clip', 'set_fade'],
      devices: ['insert_device', 'remove_device', 'set_param'],
    };
    for (const [f, tools] of Object.entries(families)) for (const t of tools) expect(names.has(t), `${f}: ${t}`).toBe(true);
    expect(names.has('suggest_moves')).toBe(false);
  });
});

describe('arrange', () => {
  it('split_clip at a bar: left keeps the id, the halves play the same audio', async () => {
    const c = await mix();
    const r = await muse(c, 'split_clip', { clip_id: 'c4', bar: 5 });
    expect(r).toMatchObject({ at: 8, bar: 5, parts: [{ left: 'c4' }] });
    expect(clips(c, 't3')).toEqual([['c4', 0, 8, 0], [r.parts[0].right, 8, 8, 8]]);
  });

  it('split_clip on a track splits every clip that crosses the position, and refuses a miss', async () => {
    const c = await mix();
    await muse(c, 'split_clip', { track_id: 't3', bar: 3 });
    expect(clips(c, 't3').map((x) => x[1])).toEqual([0, 4]);
    expect(await runTool(c, 'split_clip', { clip_id: 'c2', bar: 7 }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/does not cross/) });
    expect(await runTool(c, 'split_clip', { track_id: 't1', bar: 7 }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no clip on t1/) });
  });

  it('split_clip defaults to the selection ("split this at bar 6")', async () => {
    const c = await mix();
    await runTool(c, 'select', { track_id: 't5', clip_id: 'c6' }, 'user');
    await muse(c, 'split_clip', { bar: 6 });
    expect(clips(c, 't5').map((x) => x[1])).toEqual([8, 10]);
  });

  it('repeat_clip: copies butt together, or fill through a bar with the last one cut', async () => {
    const c = await mix();
    const r = await muse(c, 'repeat_clip', { clip_id: 'c2', times: 2 });
    expect(r).toMatchObject({ copies: [expect.any(String), expect.any(String)], through_bar: 12 });
    expect(clips(c, 't1').map((x) => x[1])).toEqual([0, 8, 16]);
    const c2 = await mix();
    const r2 = await muse(c2, 'repeat_clip', { clip_id: 'c2', until_bar: 10 }); // 0-8 + 8-16 + 16-20
    expect(r2.through_bar).toBe(10);
    expect(clips(c2, 't1').map((x) => [x[1], x[2]])).toEqual([[0, 8], [8, 8], [16, 4]]);
    const c3 = await mix();
    await muse(c3, 'repeat_clip', { clip_id: 'c2', times: 2, every_bars: 8 });
    expect(clips(c3, 't1').map((x) => x[1])).toEqual([0, 16, 32]);
  });

  it('delete_bars closes the gap on every track by default; one undo step', async () => {
    const c = await mix();
    const r = await muse(c, 'delete_bars', { from_bar: 3, to_bar: 4 }); // 4-8 s
    expect(r).toMatchObject({ cut: ['c2', 'c4'], removed: [] });
    expect(clips(c, 't1')).toEqual([['c2', 0, 4, 0]]);
    const bass = clips(c, 't3');
    expect(bass[0]).toEqual(['c4', 0, 4, 0]);
    expect(bass[1].slice(1)).toEqual([4, 8, 8]); // the rest of the bass, moved up
    expect(clips(c, 't5')).toEqual([['c6', 4, 8, 0]]);
    expect(await runTool(c, 'undo', {}, 'user')).toMatchObject({ ok: true });
    expect(clips(c, 't5')).toEqual([['c6', 8, 8, 0]]);
  });

  it('delete_bars without closing the gap, on one track, clears the selection of a removed clip', async () => {
    const c = await mix();
    await runTool(c, 'select', { track_id: 't5', clip_id: 'c6' }, 'user');
    await muse(c, 'delete_bars', { from_bar: 5, to_bar: 8, track_ids: ['t5'], close_gap: false });
    expect(clips(c, 't5')).toEqual([]);
    expect(clips(c, 't3')).toEqual([['c4', 0, 16, 0]]);
    expect(c.store.get().selection.clipId).toBeNull();
  });

  it('insert_bars pushes later material and splits clips across the point', async () => {
    const c = await mix();
    await muse(c, 'insert_bars', { at_bar: 3, count: 2 });
    expect(clips(c, 't1').map((x) => x.slice(1))).toEqual([[0, 4, 0], [8, 4, 4]]);
    expect(clips(c, 't5')[0][1]).toBe(12);
  });

  it('copy_bars copies a range, cutting clips at its edges', async () => {
    const c = await mix();
    const r = await muse(c, 'copy_bars', { from_bar: 3, to_bar: 6, dest_bar: 13 }); // 4-12 s -> 24 s
    expect(r.clips).toHaveLength(3);
    expect(clips(c, 't1').at(-1)!.slice(1)).toEqual([24, 4, 4]); // drums 4-8
    expect(clips(c, 't3').at(-1)!.slice(1)).toEqual([24, 8, 4]); // bass 4-12
    expect(clips(c, 't5').at(-1)!.slice(1)).toEqual([28, 4, 0]); // vocal 8-12
    expect(await runTool(c, 'copy_bars', { from_bar: 20, to_bar: 21, dest_bar: 1 }, 'muse')).toMatchObject({ ok: false, error: 'nothing plays in that range' });
  });

  it('move_clip, duplicate_clip and move_clips take bars', async () => {
    const c = await mix();
    await muse(c, 'move_clip', { clip_id: 'c6', bar: 9 });
    expect(clips(c, 't5')[0][1]).toBe(16);
    const d = await muse(c, 'duplicate_clip', { clip_id: 'c2', bar: 5 });
    expect(d.start).toBe(8);
    await muse(c, 'move_clips', { clip_ids: ['c6'], bars: -2 });
    expect(clips(c, 't5')[0][1]).toBe(12);
    expect(await runTool(c, 'move_clip', { clip_id: 'c6' }, 'muse')).toMatchObject({ ok: false, error: 'give start or bar' });
    expect(await runTool(c, 'move_clip', { clip_id: 'c6', bar: 0 }, 'muse')).toMatchObject({ ok: false, error: 'bars start at 1' });
  });

  it('bars follow the time signature and tempo', async () => {
    const c = await mix();
    await runTool(c, 'set_time_signature', { beats: 3, unit: 4 }, 'user'); // bar = 1.5 s
    await muse(c, 'move_clip', { clip_id: 'c6', bar: 3 });
    expect(clips(c, 't5')[0][1]).toBe(3);
  });
});

describe('pure range ops keep fades only on the clip\'s own edges', () => {
  it('clipPart', () => {
    const clip: S.Clip = { id: 'c1', sourceId: 's', name: 'x', start: 2, offset: 1, duration: 6, fadeIn: 0.5, fadeOut: 1 };
    expect(clipPart(clip, 0, 5)).toEqual({ id: 'c1', sourceId: 's', name: 'x', start: 2, offset: 1, duration: 3, fadeIn: 0.5 });
    expect(clipPart(clip, 5, 99)).toEqual({ id: 'c1', sourceId: 's', name: 'x', start: 5, offset: 4, duration: 3, fadeOut: 1 });
    expect(clipPart(clip, 9, 10)).toBeNull();
  });

  it('deleteRange and insertTime refuse empty ranges', () => {
    const s = S.emptySession();
    expect(() => deleteRange(s, 4, 4)).toThrow(/empty/);
    expect(() => insertTime(s, 4, 0)).toThrow(/some time/);
  });
});

describe('mix: set_pan', () => {
  it('adds a Utility device once and reuses it', async () => {
    const c = await mix();
    const r = await muse(c, 'set_pan', { track_id: 't5', pan: -0.3 });
    expect(r).toMatchObject({ pan: -0.3, inserted_utility: true });
    await runTool(c, 'insert_device', { track_id: 't5', device: 'eq' }, 'user');
    const r2 = await muse(c, 'set_pan', { track_id: 't5', pan: 1 });
    expect(r2.inserted_utility).toBeUndefined();
    expect(S.getTrack(c.store.get(), 't5').devices.map((d) => [d.kind, d.params.pan ?? null])).toEqual([['utility', 1], ['eq', null]]);
    expect(await runTool(c, 'set_pan', { track_id: 't5', pan: 2 }, 'muse')).toMatchObject({ ok: false });
  });

  it('is logged readably as a hand edit', async () => {
    const c = await mix();
    await runTool(c, 'set_pan', { track_id: 't5', pan: -0.3 }, 'user');
    expect(c.store.takeUserEdits()).toEqual(['panned t5 to 30% left']);
  });
});

describe('tracks', () => {
  it('duplicate_track: right below, new ids, same clips, devices and gain; others keep their colour', async () => {
    const c = await mix();
    await runTool(c, 'insert_device', { track_id: 't3', device: 'eq', params: { hs_gain: 2 } }, 'user');
    await runTool(c, 'set_gain', { track_id: 't3', gain_db: -4 }, 'user');
    const colors = c.store.get().tracks.map((t, i) => t.color ?? i);
    const r = await muse(c, 'duplicate_track', { track_id: 't3' });
    const s = c.store.get();
    expect(s.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Bass copy', 'Vocal']);
    const copy = s.tracks[2];
    expect(r).toMatchObject({ from: 't3', track_id: copy.id, name: 'Bass copy', devices: 1 });
    expect(copy.clips.map((x) => [x.sourceId, x.start, x.duration])).toEqual([['src-b', 0, 16]]);
    expect(copy.clips[0].id).not.toBe('c4');
    expect(copy.devices[0]).toMatchObject({ kind: 'eq', params: { hs_gain: 2 } });
    expect(copy.devices[0].id).not.toBe(s.tracks[1].devices[0].id);
    expect(copy.gainDb).toBe(-4);
    expect([s.tracks[0], s.tracks[1], s.tracks[3]].map((t) => t.color)).toEqual(colors);
    expect(new Set(s.tracks.map((t) => t.color)).size).toBe(4);
    await muse(c, 'duplicate_track', { track_id: 't1', with_clips: false });
    expect(c.store.get().tracks[1]).toMatchObject({ name: 'Drums copy', clips: [] });
  });

  it('set_track_color by name or alias; the names match the palette', async () => {
    expect(TRACK_COLOR_NAMES.length).toBe(TRACK_COLORS.length);
    expect(colorSlot('Red')).toBe(0);
    const c = await mix();
    expect(await muse(c, 'set_track_color', { track_id: 't1', color: 'blue' })).toEqual({ track_id: 't1', color: 'blue' });
    expect(S.getTrack(c.store.get(), 't1').color).toBe(3);
    expect(await runTool(c, 'set_track_color', { track_id: 't1', color: 'plaid' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no colour "plaid"/) });
  });
});

describe('edit', () => {
  it('trim_clip takes bars; a left-out edge stays', async () => {
    const c = await mix();
    await muse(c, 'trim_clip', { clip_id: 'c4', from_bar: 2, to_bar: 4 });
    expect(clips(c, 't3')).toEqual([['c4', 2, 6, 2]]);
    await muse(c, 'trim_clip', { clip_id: 'c4', end: 6 });
    expect(clips(c, 't3')).toEqual([['c4', 2, 4, 2]]);
    expect(await runTool(c, 'trim_clip', { clip_id: 'c4' }, 'muse')).toMatchObject({ ok: false });
  });

  it('set_fade sets, clamps to the clip, removes with 0, and the playout gets it', async () => {
    const c = await mix();
    await runTool(c, 'select', { track_id: 't5', clip_id: 'c6' }, 'user');
    expect(await muse(c, 'set_fade', { fade_out: 2 })).toEqual({ clips: [{ clip_id: 'c6', fade_in: 0, fade_out: 2 }] });
    await muse(c, 'set_fade', { clip_ids: ['c2', 'c6'], fade_in: 20 });
    expect(S.findClip(c.store.get(), 'c2').clip.fadeIn).toBe(8);
    await muse(c, 'set_fade', { clip_id: 'c6', fade_out: 0 });
    expect(S.findClip(c.store.get(), 'c6').clip).not.toHaveProperty('fadeOut');
    expect(await runTool(c, 'set_fade', { clip_id: 'c6' }, 'muse')).toMatchObject({ ok: false });
    expect(playoutFades(S.findClip(c.store.get(), 'c6').clip)).toEqual({ fadeIn: { duration: 8, type: 'linear' } });
    expect(playoutFades({ ...S.findClip(c.store.get(), 'c6').clip, duration: 3 })).toEqual({ fadeIn: { duration: 3, type: 'linear' } });
  });
});

describe('devices: exact values', () => {
  it('Muse is held to the usual range unless the user named the value', async () => {
    const c = await mix();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'comp' }, 'user');
    const held = await muse(c, 'set_param', { track_id: 't1', device_id: 'comp', param: 'thresh', value: -50 });
    expect(held).toMatchObject({ value: -40, note: expect.stringMatching(/usual range/) });
    const exact = await muse(c, 'set_param', { track_id: 't1', device_id: 'comp', param: 'thresh', value: -50, exact: true });
    expect(exact.value).toBe(-50);
    expect(exact.note).toBeUndefined();
    const ins = await muse(c, 'insert_device', { track_id: 't3', device: 'eq', params: { hs_gain: 12 }, exact: true });
    expect(ins.clamped).toBeUndefined();
    expect(S.getTrack(c.store.get(), 't3').devices[0].params.hs_gain).toBe(12);
  });
});

describe('summary: what Muse needs to resolve "this", names and bars', () => {
  it('shows bars, colours, fades, and names the selection', async () => {
    const c = await mix();
    await runTool(c, 'set_fade', { clip_id: 'c6', fade_in: 0.5 }, 'user');
    await runTool(c, 'select', { track_id: 't5', clip_id: 'c6' }, 'user');
    const sum = S.summarize(c.store.get());
    expect(sum).toContain('Bars are 1-based: bar n starts at 2 * (n-1) s');
    expect(sum).toContain('- (coral) t1 "Drums" gain 0 dB: c2 "Drums" 0-8s (bar 1 to 5)');
    expect(sum).toContain('- (green) t5 "Vocal" gain 0 dB: c6 "Vocal" 8-16s (bar 5 to 9; fade in 0.5s)');
    expect(sum).toContain('selected clip c6 ("Vocal" on t5 "Vocal"); stopped at 0s, bar 1');
    await runTool(c, 'select', { track_id: 't3' }, 'user');
    expect(S.summarize(c.store.get())).toContain('selected track t3 "Bass"');
  });
});
