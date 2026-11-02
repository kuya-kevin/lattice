// B3: cleanup_noise and quantize_drums replace a track's audio with the sidecar's processed
// take (one undo step); a stub sidecar changes nothing and says stub.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { StubSidecar, type QuantizeDrumsArgs } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';
import { engineerArgs, runEngineer } from '../src/node/engineer';

class FakeSidecar extends StubSidecar {
  calls: { op: string; args: object }[] = [];
  before?: () => void; // runs while the "sidecar" works, to change the session meanwhile
  override async cleanupNoise(a: { sourceId: string; newSourceId: string }) {
    this.calls.push({ op: 'cleanup', args: a });
    this.before?.();
    return { method: 'noisereduce', noise_floor_db: { before: -42, after: -58 }, level_change_db: -0.1 };
  }
  override async quantizeDrums(a: QuantizeDrumsArgs) {
    this.calls.push({ op: 'quantize', args: a });
    return { hits: 20, moved: 15, max_shift_ms: 22, off_grid_ms: { before: 14, after: 1.5 } };
  }
}

async function session(sidecar = new FakeSidecar()) {
  const c: ToolContext & { sidecar: FakeSidecar } = { store: new SessionStore(), sidecar, searchFreesound: async () => ({ count: 0, results: [] }) };
  await runTool(c, 'import_audio', { source_id: 'src-v', name: 'Vocal take', duration: 12 }, 'user'); // t1, c2
  await runTool(c, 'import_audio', { source_id: 'src-d', name: 'Drum loop', duration: 8 }, 'user'); // t3, c4
  c.store.takeUserEdits();
  return c;
}

describe('cleanup_noise / quantize_drums (B3)', () => {
  it('cleanup swaps the track to a processed source in one undo step, and Muse sees it', async () => {
    const c = await session();
    const r = await runTool(c, 'cleanup_noise', { track_id: 't1' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { track_id: 't1', source_id: 'src-v', method: 'noisereduce' } });
    expect(r.result).not.toHaveProperty('stub');
    const newId = (r.result as { new_source_id: string }).new_source_id;
    expect(c.sidecar.calls[0]).toEqual({ op: 'cleanup', args: { sourceId: 'src-v', newSourceId: newId } });
    const s = c.store.get();
    expect(S.getTrack(s, 't1').clips[0]).toMatchObject({ id: 'c2', sourceId: newId, start: 0, offset: 0, duration: 12 });
    expect(s.sources[newId]).toMatchObject({ name: 'Vocal take', duration: 12, origin: 'processed', derivedFrom: 'src-v', processed: 'noise cleaned (noisereduce)' });
    expect(s.sources['src-v']).toBeDefined(); // the original stays, for undo
    expect(S.summarize(s)).toContain('c2 "Vocal take" 0-12s [audio: noise cleaned (noisereduce); original src-v]');

    await runTool(c, 'undo', {}, 'user');
    expect(S.getTrack(c.store.get(), 't1').clips[0].sourceId).toBe('src-v');
  });

  it('quantize puts the grid on the session bars and stacks the description on a cleaned take', async () => {
    const c = await session();
    await runTool(c, 'set_tempo', { bpm: 96 }, 'user');
    await runTool(c, 'trim_clip', { clip_id: 'c4', start: 0.5, end: 8 }, 'user'); // offset 0.5 into the source, at 0.5 s
    await runTool(c, 'move_clip', { clip_id: 'c4', start: 2 }, 'user');
    await runTool(c, 'cleanup_noise', { track_id: 't3' }, 'muse');
    const r = await runTool(c, 'quantize_drums', { track_id: 't3', grid: '1/16', strength: 0.8 }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { bpm: 96, grid: '1/16', strength: 0.8, hits: 20, off_grid_ms: { after: 1.5 } } });
    const clip = S.getTrack(c.store.get(), 't3').clips[0];
    expect(c.sidecar.calls[1]).toMatchObject({ op: 'quantize', args: { grid: 16, strength: 0.8, bpm: 96, phase: clip.offset - clip.start } });
    expect(clip.offset - clip.start).toBeCloseTo(-1.5, 6);
    expect(c.store.get().sources[clip.sourceId].processed).toBe('noise cleaned (noisereduce); drums quantized to 1/16 at 96 BPM, strength 0.8');
    expect((await runTool(c, 'quantize_drums', { track_id: 't3', grid: '1/12', strength: 1 }, 'muse')).ok).toBe(false);
  });

  it('use_audio_version goes back to the original and forward again, one undo step each', async () => {
    const c = await session();
    await runTool(c, 'add_track', { name: 'Double' }, 'user'); // t5
    await runTool(c, 'duplicate_clip', { clip_id: 'c2', track_id: 't5', start: 4 }, 'user');
    const cleaned = ((await runTool(c, 'cleanup_noise', { track_id: 't1' }, 'muse')).result as { new_source_id: string }).new_source_id;
    const quantized = ((await runTool(c, 'quantize_drums', { track_id: 't1', grid: '1/16', strength: 1 }, 'muse')).result as { new_source_id: string }).new_source_id;
    let s = c.store.get();
    expect(S.rootSource(s, quantized)).toBe('src-v');
    expect(S.sourceVersions(s, cleaned).map((v) => v.id)).toEqual(['src-v', cleaned, quantized]);
    expect(S.sourceVersions(s, 'src-d').map((v) => v.id)).toEqual(['src-d']);

    // back to the original on t1 only: t5 already plays it
    const r = await runTool(c, 'use_audio_version', { source_id: 'src-v', track_id: 't1' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { version: 'original', clips: ['c2'] } });
    s = c.store.get();
    expect(S.getTrack(s, 't1').clips[0]).toMatchObject({ sourceId: 'src-v', start: 0, duration: 12 });
    // forward to the cleaned take everywhere (t1 and t5)
    expect(await runTool(c, 'use_audio_version', { source_id: cleaned }, 'user')).toMatchObject({ ok: true, result: { clips: ['c2', 'c6'] } });
    expect(c.store.takeUserEdits().join('\n')).toMatch(/switched c2, c6 to .* \(noise cleaned/);
    expect((await runTool(c, 'use_audio_version', { source_id: cleaned }, 'user')).ok).toBe(false); // nothing to switch
    await runTool(c, 'undo', {}, 'user');
    expect(S.getTrack(c.store.get(), 't5').clips[0].sourceId).toBe('src-v');
    expect(S.getTrack(c.store.get(), 't1').clips[0].sourceId).toBe('src-v');
  });

  it('only that track changes; the same source on another track keeps the original', async () => {
    const c = await session();
    await runTool(c, 'add_track', { name: 'Double' }, 'user'); // t5
    expect(await runTool(c, 'duplicate_clip', { clip_id: 'c2', track_id: 't5', start: 0 }, 'user')).toMatchObject({ ok: true });
    await runTool(c, 'cleanup_noise', { track_id: 't1' }, 'muse');
    expect(S.getTrack(c.store.get(), 't1').clips[0].sourceId).not.toBe('src-v');
    expect(S.getTrack(c.store.get(), 't5').clips[0].sourceId).toBe('src-v');
    expect(S.getTrack(c.store.get(), 't3').clips[0].sourceId).toBe('src-d');
  });

  it('a source deleted while the sidecar ran is left alone', async () => {
    const sidecar = new FakeSidecar();
    const c = await session(sidecar);
    sidecar.before = () => c.store.set(S.deleteSource(c.store.get(), 'src-v'));
    const r = await runTool(c, 'cleanup_noise', { track_id: 't1' }, 'muse');
    expect(r.ok).toBe(true);
    expect(r.result).not.toHaveProperty('new_source_id');
    expect(Object.values(c.store.get().sources).some((x) => x.origin === 'processed')).toBe(false);
  });

  it('the stub sidecar changes nothing and says stub', async () => {
    const c = await session(new StubSidecar() as FakeSidecar);
    const before = c.store.get();
    const r = await runTool(c, 'cleanup_noise', { track_id: 't1' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { stub: true } });
    expect(c.store.get()).toBe(before);
  });

  it('needs audio clips on the track', async () => {
    const c = await session();
    await runTool(c, 'add_track', { name: 'Empty' }, 'user');
    expect(await runTool(c, 'cleanup_noise', { track_id: 't5' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no audio clips/) });
  });
});

describe('engineer sidecar runner (node)', () => {
  it('passes the grid on the command line', () => {
    expect(engineerArgs({ op: 'cleanup', sourceId: 'a' })).toEqual([]);
    expect(engineerArgs({ op: 'quantize', sourceId: 'a', grid: 16, strength: 0.5, bpm: 92, phase: -1.25 })).toEqual(['--bpm', '92', '--grid', '16', '--strength', '0.5', '--phase', '-1.25']);
  });

  it('mock mode returns the uploaded audio unchanged', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'lattice-eng-'));
    const cfg = { script: '/nowhere/run.sh', workDir };
    await expect(runEngineer(cfg, { op: 'cleanup', sourceId: 'src-x' }, { mock: true })).rejects.toThrow(/no audio for source src-x/);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(workDir, 'sources'), { recursive: true });
    writeFileSync(join(workDir, 'sources', 'src-x.wav'), new Uint8Array([1, 2, 3]));
    const r = await runEngineer(cfg, { op: 'cleanup', sourceId: 'src-x' }, { mock: true });
    expect([...r.wav]).toEqual([1, 2, 3]);
    expect(r.result.method).toMatch(/mock/);
  });
});

describe('split_stems', () => {
  class StemSidecar extends StubSidecar {
    override async splitStems(a: { sourceId: string; newSourceId: string }) {
      const stem = (name: string, share: number) => ({ name, share, source_id: `${a.newSourceId}-${name}` });
      return { model: 'htdemucs_6s', stems: [stem('drums', 0.7), stem('bass', 0.3)], dropped: ['piano'], seconds: 9 };
    }
  }
  const session = async (sidecar: StubSidecar) => {
    const c: ToolContext = { store: new SessionStore(), sidecar, searchFreesound: async () => ({ count: 0, results: [] }) };
    await runTool(c, 'import_audio', { source_id: 'src-j', name: 'Jam', duration: 12 }, 'user'); // t1, c2
    await runTool(c, 'trim_clip', { clip_id: 'c2', start: 1, end: 9 }, 'user');
    c.store.takeUserEdits();
    return c;
  };

  it('adds a lined-up audio track per stem, mutes the original, and undoes in one step', async () => {
    const c = await session(new StemSidecar());
    const r: any = await runTool(c, 'split_stems', { clip_id: 'c2' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { from_clip: 'c2', model: 'Meta Demucs htdemucs_6s', muted_original: 't1', dropped: ['piano'] } });
    const s = c.store.get();
    expect(S.getTrack(s, 't1').muted).toBe(true);
    const { track_id, stem } = r.result.tracks[0];
    expect(stem).toBe('drums');
    const t = S.getTrack(s, track_id);
    expect(t.name).toBe('Jam drums');
    const orig = S.getTrack(s, 't1').clips[0];
    expect(t.clips[0]).toMatchObject({ start: orig.start, offset: orig.offset, duration: orig.duration });
    expect(s.sources[t.clips[0].sourceId]).toMatchObject({ origin: 'processed', duration: 12 });
    expect(S.sourceVersions(s, t.clips[0].sourceId)).toHaveLength(1); // a stem is not a version of the take
    expect(S.summarize(s)).toContain('drums stem (Meta Demucs)');
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks).toHaveLength(1);
    expect(S.getTrack(c.store.get(), 't1').muted).toBe(false);
  });

  it('leaves the track playing when other clips share it', async () => {
    const c = await session(new StemSidecar());
    await runTool(c, 'duplicate_clip', { clip_id: 'c2', start: 20 }, 'user');
    const r: any = await runTool(c, 'split_stems', { clip_id: 'c2' }, 'muse');
    expect(r.result.muted_original).toBeNull();
    expect(S.getTrack(c.store.get(), 't1').muted).toBe(false);
  });

  it('the stub says stub and changes nothing', async () => {
    const c = await session(new StubSidecar());
    const r = await runTool(c, 'split_stems', { clip_id: 'c2' }, 'muse');
    expect(r).toMatchObject({ ok: true, result: { stub: true, tracks: [] } });
    expect(c.store.get().tracks).toHaveLength(1);
  });
});

describe('extract_midi on chords', () => {
  it('an audio-only stem adds no track, and the result says it stays audio', async () => {
    const stems = [{ name: 'keys', role: 'keys', is_drum: false, transcriber: 'none', audio_only: true, midi: null, range: null, confidence: 0, notes: [] }];
    class Keys extends StubSidecar {
      override async extractMidi() {
        return { version: 1, input: 'x', duration: 12, content: 'keys', tempo: null, key: null, warnings: [], stems } as any;
      }
    }
    const c: ToolContext = { store: new SessionStore(), sidecar: new Keys(), searchFreesound: async () => ({ count: 0, results: [] }) };
    await runTool(c, 'import_audio', { source_id: 'k', name: 'Keys', duration: 12 }, 'user');
    const r: any = await runTool(c, 'extract_midi', { clip_id: 'c2' }, 'muse');
    expect(r.result.tracks).toEqual([]);
    expect(r.result.skipped[0]).toMatch(/stays audio/);
  });
});
