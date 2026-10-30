// B1: suggest_moves (sound words -> knob moves). Following its "how" on the fx- scenario tracks
// must land every knob where the vocab says, with nothing clamped and no other track touched.
// B16 took suggest_moves off Muse's tool list (Muse acts on concrete instructions now); the tool
// and vocab.json stay, so these tests call it as the user. The moves are still applied as Muse
// would (actor 'muse'), which holds them to each knob's usual range.
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';

async function mix() {
  const c: ToolContext = { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
  for (const [id, name] of [['src-vocal', 'Vocal take'], ['src-bass', 'Bass DI'], ['src-drums', 'Drum loop'], ['src-pad', 'Pad']])
    await runTool(c, 'import_audio', { source_id: id, name, duration: 8 }, 'user'); // t1, t3, t5, t7
  return c;
}

type Move = { device: string; param: string; op: 'set' | 'add' | 'mul'; value: unknown };

/** Apply suggestions the way the tool's "how" says: one device per kind, set moves as insert params. */
async function apply(c: ToolContext, trackId: string, moves: Move[]) {
  const notes: string[] = [];
  const kinds = [...new Set(moves.map((m) => m.device))];
  for (const kind of kinds) {
    const sets = Object.fromEntries(moves.filter((m) => m.device === kind && m.op === 'set').map((m) => [m.param, m.value]));
    const ins = await runTool(c, 'insert_device', { track_id: trackId, device: kind, params: sets }, 'muse');
    expect(ins.ok, JSON.stringify(ins)).toBe(true);
    if ((ins.result as { clamped?: string[] }).clamped) notes.push(`${kind} clamped ${(ins.result as { clamped: string[] }).clamped}`);
    const id = (ins.result as { device_id: string }).device_id;
    for (const m of moves.filter((m) => m.device === kind && m.op !== 'set')) {
      const r = await runTool(c, 'set_param', { track_id: trackId, device_id: id, param: m.param, value: m.value, op: m.op }, 'muse');
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if ((r.result as { note?: string }).note) notes.push(`${kind}.${m.param}: ${(r.result as { note: string }).note}`);
    }
  }
  return notes;
}

describe('suggest_moves (B1)', () => {
  it('is not offered to Muse (B16), and is read-only', async () => {
    expect(museToolSpecs().map((t) => t.function.name)).not.toContain('suggest_moves');
    const c = await mix();
    expect(await runTool(c, 'suggest_moves', { words: ['muddy'], track_id: 't3' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
    const before = c.store.get();
    c.store.takeUserEdits();
    expect((await runTool(c, 'suggest_moves', { words: ['muddy'], track_id: 't3' }, 'user')).ok).toBe(true);
    expect(c.store.get()).toBe(before);
    expect(c.store.takeUserEdits()).toEqual([]); // quiet: not logged as a hand edit
  });

  const phrases: [string, string, string[], string[]][] = [
    // scenario, track, words, devices expected on that track
    ['stand-out', 't1', ['stand out'], ['eq', 'comp']],
    ['harsh', 't1', ['harsh'], ['eq']],
    ['sibilant', 't1', ['sibilant'], ['deess']],
    ['warm-bass', 't3', ['warmer'], ['eq', 'sat']],
    ['muddy-bass', 't3', ['muddy'], ['eq']],
    ['punchy-drums', 't5', ['punchier'], ['comp']],
    ['glue-drums', 't5', ['glue'], ['comp']],
    ['wide-pad', 't7', ['wider', 'spacious'], ['utility', 'reverb']],
    ['gritty-bass', 't3', ['grit'], ['sat']],
    ['telephone', 't1', ['phone'], ['eq', 'sat']],
  ];
  for (const [name, track, words, devices] of phrases) {
    it(`fx-${name}: the suggested moves apply cleanly to ${track} only`, async () => {
      const c = await mix();
      const r = await runTool(c, 'suggest_moves', { words, track_id: track }, 'user');
      expect(r.ok).toBe(true);
      const res = r.result as { suggestions: { moves?: Move[]; no_match?: true }[]; track_devices: unknown[] };
      expect(res.suggestions.every((s) => s.moves?.length), JSON.stringify(res)).toBe(true);
      expect(res.track_devices).toEqual([]);
      const notes = await apply(c, track, res.suggestions.flatMap((s) => s.moves!));
      expect(notes).toEqual([]); // nothing clamped
      const s = c.store.get();
      expect(S.getTrack(s, track).devices.map((d) => d.kind)).toEqual(devices);
      for (const t of s.tracks) if (t.id !== track) expect(t.devices, t.name).toEqual([]);
    });
  }

  it('punchy keeps a slow attack even though it sets a style', async () => {
    const c = await mix();
    const r = await runTool(c, 'suggest_moves', { words: ['punchy'], track_id: 't5' }, 'user');
    await apply(c, 't5', (r.result as { suggestions: { moves: Move[] }[] }).suggestions[0].moves);
    expect(S.getTrack(c.store.get(), 't5').devices[0].params).toMatchObject({ style: 'vca', attack: 25, release: 80, ratio: 4, thresh: -24 });
  });

  it('says when a word has no entry, and which devices mention it', async () => {
    const c = await mix();
    const r = await runTool(c, 'suggest_moves', { words: ['shimmer'], track_id: 't7' }, 'user');
    expect(r.result).toMatchObject({ source_type: 'pad', suggestions: [{ word: 'shimmer', no_match: true, devices_with_this_word: ['mod'] }] });
  });

  it('lists the devices the track already has, and scales by amount', async () => {
    const c = await mix();
    await runTool(c, 'insert_device', { track_id: 't3', device: 'sat' }, 'muse');
    const r = await runTool(c, 'suggest_moves', { words: ['gritty'], track_id: 't3', amount: 'a bit' }, 'user');
    expect(r.result).toMatchObject({ source_type: 'bass', amount: 'a bit', track_devices: [{ device: 'sat' }], suggestions: [{ moves: expect.arrayContaining([expect.objectContaining({ param: 'drive', value: 3 })]) }] });
  });
});

describe('measure_track (B9)', () => {
  const f = (over: Partial<import('../src/core/ears').Features> = {}) => ({
    seconds: 8, level_db: -20, peak_db: -6, crest_db: 14, spread_db: 6, brightness_hz: 2400, width: 0.3,
    bands: { sub: -50, low: -28, low_mid: -26, mid: -24, presence: -28, sibilance: -32, air: -40 }, ...over,
  });

  it('reports what the effects measurably change, largest first', async () => {
    const c = await mix();
    let asked: [string, number] | null = null;
    c.measureTrack = async (s, id) => ((asked = [id, s.tracks.find((t) => t.id === id)!.devices.length]), { dry: f(), wet: f({ brightness_hz: 1800, bands: { ...f().bands, air: -46 } }) });
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq', params: { hs_gain: -6 } }, 'muse');
    const r = await runTool(c, 'measure_track', { track_id: 't1' }, 'muse');
    expect(asked).toEqual(['t1', 1]); // measured the current session, chain included
    expect(r).toMatchObject({ ok: true, result: { chain: ['eq'], what_the_fx_do: ['air band -6 dB vs the least-changed band', 'brightness -25% (2400 -> 1800 Hz)'] } });
  });

  it('says there are no effects, and needs the app', async () => {
    const c = await mix();
    expect(await runTool(c, 'measure_track', { track_id: 't3' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/needs the app/) });
    c.measureTrack = async () => ({ dry: f(), wet: f() });
    expect(await runTool(c, 'measure_track', { track_id: 't3' }, 'muse')).toMatchObject({ ok: true, result: { what_the_fx_do: ['no effects on this track'] } });
  });
});
