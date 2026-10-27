import { describe, expect, it } from 'vitest';
import { buildFilter, toHit } from '../src/core/freesound';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, TOOLS, validateArgs, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return {
    store: new SessionStore(),
    sidecar: new StubSidecar(),
    searchFreesound: async (q) => ({ count: 1, results: [toHit({ id: 1, name: q, tags: ['a'], license: 'http://creativecommons.org/publicdomain/zero/1.0/', duration: 1.234, previews: { 'preview-hq-mp3': 'x.mp3' }, brightness: 12.34 })] }),
  };
}

async function withTrack(c = ctx()) {
  await runTool(c, 'import_audio', { source_id: 's', name: 'Drums', duration: 8 }, 'user');
  c.store.takeUserEdits();
  return c;
}

describe('tool layer', () => {
  it('exposes only Muse tools with valid schemas', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['list_tracks', 'trim_clip', 'set_gain', 'mute', 'solo', 'arm_punch_in', 'play', 'stop', 'quantize_drums', 'cleanup_noise', 'search_freesound', 'generate_mrt2', 'set_synth_knobs', 'fit_synth_to_reference', 'add_track']));
    expect(names).not.toContain('import_audio');
    for (const t of TOOLS) {
      expect(t.parameters.type).toBe('object');
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('validates arguments', () => {
    const schema = TOOLS.find((t) => t.name === 'set_gain')!.parameters;
    expect(validateArgs(schema, { track_id: 't1' })).toMatch(/missing/);
    expect(validateArgs(schema, { track_id: 't1', gain_db: '3' })).toMatch(/number/);
    expect(validateArgs(schema, { track_id: 't1', gain_db: 3, x: 1 })).toMatch(/unknown/);
    expect(validateArgs(schema, { track_id: 't1', gain_db: 3 })).toBeNull();
  });

  it('runs session tools and returns errors as data', async () => {
    const c = await withTrack();
    expect((await runTool(c, 'set_gain', { track_id: 't1', gain_db: -3 }, 'muse')).ok).toBe(true);
    expect(c.store.get().tracks[0].gainDb).toBe(-3);
    const bad = await runTool(c, 'set_gain', { track_id: 't9', gain_db: -3 }, 'muse');
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('no track') });
    expect(await runTool(c, 'import_audio', { source_id: 'x', name: 'x', duration: 1 }, 'muse')).toMatchObject({ ok: false });
  });

  it('trims the selected clip when no clip_id is given', async () => {
    const c = await withTrack();
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    const r = await runTool(c, 'trim_clip', { start: 1, end: 4 }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { clip_id: 'c2', start: 1, end: 4 } });
  });

  it('logs user edits (not Muse edits, not transport) as feedback', async () => {
    const c = await withTrack();
    await runTool(c, 'set_gain', { track_id: 't1', gain_db: -1 }, 'muse');
    await runTool(c, 'play', {}, 'user');
    await runTool(c, 'trim_clip', { clip_id: 'c2', start: 0.5, end: 3 }, 'user');
    expect(c.store.takeUserEdits()).toEqual(['trim_clip {"clip_id":"c2","start":0.5,"end":3}']);
    expect(c.store.takeUserEdits()).toEqual([]);
  });

  it('stubs are marked and plausible', async () => {
    const c = await withTrack();
    const q = await runTool(c, 'quantize_drums', { track_id: 't1', grid: '1/16', strength: 0.5 }, 'muse');
    expect(q).toMatchObject({ ok: true, result: { stub: true, moved: 14 } });
    const k = await runTool(c, 'set_synth_knobs', { patch: { cutoff: 99999, drive: 0.4 } }, 'muse');
    expect(k).toMatchObject({ ok: true, result: { patch: { cutoff: 16000, drive: 0.4 }, clamped: ['cutoff'] } });
    expect((await runTool(c, 'quantize_drums', { track_id: 't1', grid: '1/5', strength: 1 }, 'muse')).error).toMatch(/one of/);
  });

  it('builds Freesound filters and trims hits', async () => {
    expect(buildFilter({ brightness: { max: 40 }, duration: { min: 0.5, max: 5 }, note_name: 'A' })).toBe('brightness:[* TO 40] duration:[0.5 TO 5] note_name:"A"');
    const r = await runTool(ctx(), 'search_freesound', { query: 'bass', filters: { warmth: { min: 60 } } }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { results: [{ license: 'CC0', duration: 1.2, timbre: { brightness: 12.3 } }] } });
  });

  it('tempo/key/click tools, and quantize uses the session tempo', async () => {
    const c = await withTrack();
    expect(await runTool(c, 'set_tempo', { bpm: 92 }, 'muse')).toMatchObject({ ok: true, result: { tempo: 92 } });
    expect(await runTool(c, 'set_key', { key: 'Gm' }, 'muse')).toMatchObject({ ok: true, result: { key: 'G minor' } });
    expect(await runTool(c, 'set_time_signature', { beats: 3, unit: 4 }, 'muse')).toMatchObject({ ok: true, result: { time_signature: '3/4' } });
    expect(await runTool(c, 'set_metronome', { on: true, count_in: true }, 'user')).toMatchObject({ ok: true, result: { on: true, countIn: true } });
    expect(c.store.takeUserEdits()).toEqual(['set_metronome {"on":true,"count_in":true}']);
    expect((await runTool(c, 'set_tempo', { bpm: 10 }, 'muse')).error).toMatch(/40-240/);
    const q = await runTool(c, 'quantize_drums', { track_id: 't1', grid: '1/8', strength: 1 }, 'muse');
    expect(q).toMatchObject({ ok: true, result: { bpm: 92, stub: true } });
    expect((await runTool(c, 'quantize_drums', { track_id: 't1', grid: '1/8', strength: 1, bpm: 100 }, 'muse')).error).toMatch(/unknown argument/);
  });

  it('go_to moves the playhead without changing play state', async () => {
    const c = await withTrack();
    await runTool(c, 'play', { from: 3 }, 'muse');
    await runTool(c, 'go_to', { position: 0 }, 'user');
    expect(c.store.get().transport).toMatchObject({ playing: true, position: 0, command: 'locate' });
  });
});
