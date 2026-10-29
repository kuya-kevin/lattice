// B13: slice_drums cuts a drum loop at its hits and moves each slice to a track per drum; the
// slices abut, so together they play the clip exactly. find_sound tells Muse where a clip has
// sound, so it can trim dead space. Both analyses come from the sidecar.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as S from '../src/core/session';
import { StubSidecar, type DrumHit, type SoundRegionsResult } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { runTool, soundIn, type ToolContext } from '../src/core/tools';
import { runDrumHits, runSoundRegions } from '../src/node/engineer';
import { putAudio } from '../src/node/sourcePrep';

// kick, hat, snare, hat every 0.5 s; the kick on 1.0 has a hat on top
const HITS: DrumHit[] = [
  { time: 0.02, kind: 'kick' },
  { time: 0.5, kind: 'hat' },
  { time: 1.0, kind: 'snare' },
  { time: 1.5, kind: 'hat' },
  { time: 2.0, kind: 'kick', also: ['hat'] },
  { time: 2.5, kind: 'hat' },
  { time: 3.0, kind: 'snare' },
  { time: 3.5, kind: 'hat' },
];

class FakeSidecar extends StubSidecar {
  calls: string[] = [];
  override async drumHits(a: { sourceId: string }) {
    this.calls.push(a.sourceId);
    return { hits: HITS };
  }
  // sound from 0.6 s, a 0.5 s gap, and a 0.2 s gap before a last blip
  override async soundRegions(): Promise<SoundRegionsResult> {
    return { regions: [[0.6, 1.5], [2.0, 3.2], [3.4, 3.5]], threshold_db: -48 };
  }
}

async function session(sidecar: StubSidecar = new FakeSidecar()) {
  const c: ToolContext & { sidecar: StubSidecar } = { store: new SessionStore(), sidecar, searchFreesound: async () => ({ count: 0, results: [] }) };
  await runTool(c, 'import_audio', { source_id: 'src-d', name: 'Drum loop', duration: 4 }, 'user'); // t1, c2
  await runTool(c, 'import_audio', { source_id: 'src-v', name: 'Vocal', duration: 4 }, 'user'); // t3, c4
  c.store.takeUserEdits();
  return c;
}

/** every slice as [timeline start, end, source offset], sorted by start */
const slices = (s: S.Session, ids: string[]) =>
  ids
    .flatMap((id) => S.getTrack(s, id).clips)
    .map((c) => [c.start, +(c.start + c.duration).toFixed(3), c.offset])
    .sort((a, b) => a[0] - b[0]);

describe('slice_drums (B13)', () => {
  it('puts each drum on its own track under the loop, slices abutting so they replay the clip', async () => {
    const c = await session();
    await runTool(c, 'insert_device', { track_id: 't1', device: 'eq' }, 'user');
    await runTool(c, 'set_gain', { track_id: 't1', gain_db: -3 }, 'user');
    await runTool(c, 'move_clip', { clip_id: 'c2', start: 2 }, 'user');
    const r = await runTool(c, 'slice_drums', { clip_id: 'c2' }, 'muse');
    expect(r).toMatchObject({
      ok: true,
      result: {
        clip_id: 'c2',
        tracks: [
          { drum: 'kick', name: 'Drum loop Kick', slices: 2 },
          { drum: 'snare', name: 'Drum loop Snare', slices: 2 },
          { drum: 'hat', name: 'Drum loop Hat', slices: 4 },
        ],
        hits_with_another_drum: 1,
      },
    });
    const s = c.store.get();
    const ids = (r.result as { tracks: { track_id: string }[] }).tracks.map((t) => t.track_id);
    expect(s.tracks.map((t) => t.id)).toEqual(['t1', ...ids, 't3']); // right under the loop
    expect(S.getTrack(s, 't1').clips).toEqual([]);
    const kick = S.getTrack(s, ids[0]);
    expect(kick).toMatchObject({ gainDb: -3, devices: [{ kind: 'eq', on: true }] });
    expect(kick.devices[0].id).not.toBe(S.getTrack(s, 't1').devices[0].id);
    expect(kick.clips.map((x) => x.name)).toEqual(['Kick 1', 'Kick 2']);
    // the first slice starts at the clip's edge; each ends where the next hit starts
    expect(slices(s, ids)).toEqual([
      [2, 2.5, 0], [2.5, 3, 0.5], [3, 3.5, 1], [3.5, 4, 1.5], [4, 4.5, 2], [4.5, 5, 2.5], [5, 5.5, 3], [5.5, 6, 3.5],
    ]);
    expect(s.tracks.flatMap((t) => t.clips).every((x) => x.sourceId === 'src-d' || x.id === 'c4')).toBe(true);

    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(S.getTrack(c.store.get(), 't1').clips[0]).toMatchObject({ id: 'c2', start: 2, duration: 4 });
  });

  it('a trimmed clip keeps its edges; the part before the first hit in it goes with the drum ringing there', async () => {
    const c = await session();
    await runTool(c, 'trim_clip', { clip_id: 'c2', start: 0.7, end: 2.6 }, 'user'); // inside the hat at 0.5
    const r = await runTool(c, 'slice_drums', {}, 'muse'); // no clip: the selected one
    expect(r.ok).toBe(false);
    await runTool(c, 'select', { track_id: 't1', clip_id: 'c2' }, 'user');
    const ok = await runTool(c, 'slice_drums', {}, 'muse');
    const tracks = (ok.result as { tracks: { track_id: string; drum: string; slices: number }[] }).tracks;
    expect(tracks.map((t) => [t.drum, t.slices])).toEqual([['kick', 1], ['snare', 1], ['hat', 3]]);
    const s = c.store.get();
    expect(slices(s, tracks.map((t) => t.track_id))).toEqual([[0.7, 1, 0.7], [1, 1.5, 1], [1.5, 2, 1.5], [2, 2.5, 2], [2.5, 2.6, 2.5]]);
    expect(S.getTrack(s, tracks[2].track_id).clips[0]).toMatchObject({ start: 0.7, offset: 0.7 }); // the hat from 0.5
    expect(s.selection).toEqual({ trackId: tracks[0].track_id, clipId: null });
  });

  it('refuses MIDI clips and clips with no hits; the stub sidecar changes nothing and says stub', async () => {
    const c = await session();
    await runTool(c, 'trim_clip', { clip_id: 'c2', start: 3.6, end: 4 }, 'user'); // after the last hit
    expect(await runTool(c, 'slice_drums', { clip_id: 'c2' }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/no drum hits/) });
    const [withMidi, midi] = S.addMidiClip(c.store.get(), 't3', { name: 'Beat', midi: { instrument: 'drums', drum: true, notes: [] }, sourceDuration: 2 });
    c.store.set(withMidi);
    expect(await runTool(c, 'slice_drums', { clip_id: midi.id }, 'muse')).toMatchObject({ ok: false, error: expect.stringMatching(/MIDI/) });

    const stub = await session(new StubSidecar());
    const before = stub.store.get();
    expect(await runTool(stub, 'slice_drums', { clip_id: 'c2' }, 'muse')).toMatchObject({ ok: true, result: { stub: true, note: expect.stringMatching(/^stub/) } });
    expect(stub.store.get()).toBe(before);
  });

  it('runDrumHits: the mock pattern, and a missing upload is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-hits-'));
    const cfg = { script: '/nowhere/run.sh', workDir: dir };
    await expect(runDrumHits(cfg, 'nope', { mock: true })).rejects.toThrow(/no audio for source nope/);
    putAudio(cfg, 'src-d', new Uint8Array(44));
    const r = await runDrumHits(cfg, 'src-d', { mock: true });
    expect(r.hits.map((h) => h.kind)).toEqual(['kick', 'hat', 'snare', 'hat', 'kick', 'hat', 'snare', 'hat']);
    expect(r).not.toHaveProperty('stub');
  });

  it('find_sound gives the sound edges on the timeline and a trim that clears the dead space', async () => {
    const c = await session();
    await runTool(c, 'move_clip', { clip_id: 'c2', start: 4 }, 'user');
    c.store.takeUserEdits();
    const r = await runTool(c, 'find_sound', { clip_id: 'c2' }, 'user');
    expect(r).toMatchObject({
      ok: true,
      result: {
        clip_id: 'c2',
        clip: [4, 8],
        sound_starts_at: 4.6,
        sound_ends_at: 7.5,
        dead_space_s: { before: 0.6, after: 0.5 },
        silent_gaps: [[5.5, 6]], // the 0.2 s one is too short to list
        suggested_trim: { start: 4.59, end: 7.55 },
        silence_below_db: -48,
      },
    });
    expect(c.store.takeUserEdits()).toEqual([]); // a measurement, not an edit (not logged for Muse)
    const trim = (r.result as { suggested_trim: { start: number; end: number } }).suggested_trim;
    await runTool(c, 'trim_clip', { clip_id: 'c2', ...trim }, 'muse');
    expect(S.getTrack(c.store.get(), 't1').clips[0]).toMatchObject({ start: 4.59, offset: 0.59, duration: 2.96 });
    // measured again, the trimmed clip has no dead space left to speak of
    expect((await runTool(c, 'find_sound', { clip_id: 'c2' }, 'muse')).result).toMatchObject({ dead_space_s: { before: 0.01, after: 0.05 } });
  });

  it('soundIn: a window with no sound is silent; the stub says stub', async () => {
    const clip = { id: 'c1', sourceId: 's', name: 'x', start: 10, offset: 1.6, duration: 0.3 };
    expect(soundIn(clip, [[0.6, 1.5], [2.0, 3.2]])).toEqual({ clip: [10, 10.3], silent: true });
    expect(soundIn({ ...clip, duration: 1 }, [[0.6, 1.5], [2.0, 3.2]])).toMatchObject({ sound_starts_at: 10.4, dead_space_s: { before: 0.4, after: 0 } });
    const stub = await session(new StubSidecar());
    expect(await runTool(stub, 'find_sound', { clip_id: 'c2' }, 'muse')).toMatchObject({ ok: true, result: { stub: true, note: expect.stringMatching(/^stub/) } });
    const dir = mkdtempSync(join(tmpdir(), 'lattice-regions-'));
    putAudio({ script: '/nowhere/run.sh', workDir: dir }, 'src-d', new Uint8Array(44));
    expect(await runSoundRegions({ script: '/nowhere/run.sh', workDir: dir }, 'src-d', { mock: true })).toEqual({ regions: [[0.25, 1.75]], threshold_db: -50 });
  });
});
