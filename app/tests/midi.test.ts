// [S3 midi] MIDI clips: import of the source-prep manifest, quantize, tools, undo, WAV upload.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeMidi, midiSignature, noteName, quantizeNotes, stemToMidi, type MidiNote, type PrepManifest } from '../src/core/midi';
import { importManifest } from '../src/core/midiTools';
import * as S from '../src/core/session';
import { StubSidecar, type ExtractMidiArgs } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { encodeWavMono } from '../src/core/wav';
import { prepArgs, runSourcePrep, sourcePrepConfig } from '../src/node/sourcePrep';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/source_prep/manifest.json');
const manifest = (): PrepManifest => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const n = (pitch: number, start: number, duration: number, velocity = 100): MidiNote => ({ pitch, start, duration, velocity });

class FakeSidecar extends StubSidecar {
  calls: ExtractMidiArgs[] = [];
  override async extractMidi(a: ExtractMidiArgs) {
    this.calls.push(a);
    return manifest();
  }
}

function ctx(sidecar = new FakeSidecar()): ToolContext & { sidecar: FakeSidecar } {
  return { store: new SessionStore(), sidecar, searchFreesound: async () => ({ count: 0, results: [] }) };
}

async function withVoiceNote(c = ctx()) {
  await runTool(c, 'import_audio', { source_id: 'vn', name: 'voice note', duration: 2 }, 'user');
  return c;
}

describe('quantizeNotes', () => {
  it('snaps starts and ends to the grid at the tempo', () => {
    // 120 BPM: a 1/16 step is 0.125 s
    const q = quantizeNotes([n(60, 0.13, 0.2), n(62, 0.49, 0.26)], 120, '1/16');
    expect(q.map((x) => [x.start, x.duration])).toEqual([[0.125, 0.25], [0.5, 0.25]]);
  });
  it('moves part way with strength < 1, and keeps a minimum length', () => {
    const [half] = quantizeNotes([n(60, 0.1, 0.2)], 120, '1/8', 0.5, 0, false);
    expect(half.start).toBeCloseTo(0.05, 4); // halfway from 0.1 to 0
    const [short] = quantizeNotes([n(60, 0.0, 0.01)], 120, '1/16');
    expect(short.duration).toBeCloseTo(0.125, 4);
  });
  it('honours the grid origin (a clip that starts mid-bar) and sorts', () => {
    const q = quantizeNotes([n(64, 0.3, 0.1), n(60, 0.04, 0.1)], 60, '1/4', 1, 0.25, false);
    expect(q.map((x) => x.start)).toEqual([0.25, 0.25]); // both snap to the beat at origin 0.25
    expect(q.map((x) => x.pitch)).toEqual([60, 64]);
  });
  it('rejects unknown grids', () => {
    expect(() => quantizeNotes([n(60, 0, 1)], 120, '1/5')).toThrow(/unknown grid/);
  });
});

describe('manifest import', () => {
  it('turns stems into piano / drum MIDI', () => {
    const m = manifest();
    const mel = stemToMidi(m.stems[0]);
    expect(mel).toMatchObject({ instrument: 'piano', notes: [{ pitch: 57, start: 0, duration: 0.5, velocity: 90 }, expect.anything(), expect.anything(), expect.anything()] });
    expect(stemToMidi(m.stems[1])).toMatchObject({ instrument: 'drums', drum: true });
    expect(describeMidi(mel)).toBe('MIDI piano, 4 notes A3-E4');
    expect(describeMidi(stemToMidi(m.stems[1]))).toBe('MIDI drums, 3 hits (kick 2, snare 1, hat 0)');
    expect(noteName(61)).toBe('C#4');
  });

  it('adds one MIDI track per non-empty stem, aligned with the audio clip, and takes tempo/key', () => {
    let s = S.emptySession();
    s = S.addSource(s, { id: 'vn', name: 'vn', duration: 2, origin: 'record' });
    const [s1, t] = S.addTrack(s, 'vn');
    let [s2, c] = S.addClip(s1, t.id, 'vn', 1);
    s2 = S.trimClip(s2, c.id, 1.5, 3); // trimmed: offset 0.5
    c = S.findClip(s2, c.id).clip;
    const r = importManifest(s2, c.id, manifest(), undefined);
    expect(r.added.map((a) => a.stem)).toEqual(['melody', 'drums']);
    expect(r.skipped).toEqual(['bass (no notes)']);
    const mc = S.findClip(r.session, r.added[0].clip_id).clip;
    expect(mc).toMatchObject({ start: 1.5, offset: 0.5, duration: 1.5 });
    expect(mc.midi!.notes).toHaveLength(4);
    expect(r.session.tempo).toBe(120);
    expect(r.session.key).toBe('A minor');
    expect(r.session.selection).toEqual({ trackId: r.added[0].track_id, clipId: r.added[0].clip_id });
    expect(S.summarize(r.session)).toContain('[MIDI piano, 4 notes A3-E4]');
  });

  it('leaves tempo alone when the session already has other material or the tempo was unsure', () => {
    let s = S.emptySession();
    s = S.addSource(s, { id: 'a', name: 'a', duration: 2, origin: 'import' });
    s = S.addSource(s, { id: 'b', name: 'b', duration: 2, origin: 'import' });
    const [s1, t] = S.addTrack(s, 'x');
    const [s2, c] = S.addClip(s1, t.id, 'a', 0);
    const [s3] = S.addClip(s2, t.id, 'b', 3);
    expect(importManifest(s3, c.id, manifest(), undefined).session.tempo).toBe(120); // default tempo, unchanged
    const unsure = { ...manifest(), tempo: { bpm: 97, confidence: 0.2, quantized: false } };
    const [s4, t2] = S.addTrack(S.addSource(S.emptySession(), { id: 'a', name: 'a', duration: 2, origin: 'import' }), 'y');
    const [s5, c2] = S.addClip(s4, t2.id, 'a', 0);
    expect(importManifest(s5, c2.id, unsure, undefined).applied).toEqual([]);
  });
});

describe('extract_midi / quantize_midi tools', () => {
  it('runs the sidecar on the selected clip, adds tracks, and undoes in one step', async () => {
    const c = await withVoiceNote();
    const clipId = c.store.get().tracks[0].clips[0].id;
    await runTool(c, 'select', { track_id: 't1', clip_id: clipId }, 'user');
    const r = await runTool(c, 'extract_midi', { mode: 'hum', grid: '1/8' }, 'muse');
    expect(r.ok).toBe(true);
    expect(c.sidecar.calls[0]).toEqual({ sourceId: 'vn', mode: 'hum', grid: '1/8', separate: 'auto', keySnap: true });
    expect((r.result as any).tracks.map((t: any) => t.stem)).toEqual(['melody', 'drums']);
    expect(c.store.get().tracks).toHaveLength(3);
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks).toHaveLength(1);
  });

  it('passes the session tempo when asked and refuses MIDI clips as input', async () => {
    const c = await withVoiceNote();
    const clipId = c.store.get().tracks[0].clips[0].id;
    await runTool(c, 'set_tempo', { bpm: 90 }, 'user');
    await runTool(c, 'extract_midi', { clip_id: clipId, use_session_tempo: true }, 'user');
    expect(c.sidecar.calls[0].bpm).toBe(90);
    const midiClip = c.store.get().tracks[1].clips[0].id;
    const r = await runTool(c, 'extract_midi', { clip_id: midiClip }, 'user');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already MIDI/) });
  });

  it('quantize_midi snaps notes to the session grid; undo restores the played timing', async () => {
    const c = await withVoiceNote();
    const clipId = c.store.get().tracks[0].clips[0].id;
    await runTool(c, 'extract_midi', { clip_id: clipId, set_tempo: false }, 'user');
    const mid = c.store.get().tracks[1].clips[0];
    const loose = { ...mid.midi!, notes: [n(60, 0.07, 0.4), n(62, 0.52, 0.4)] };
    c.store.set(S.setClipMidi(c.store.get(), mid.id, loose));
    const r = await runTool(c, 'quantize_midi', { clip_id: mid.id, grid: '1/4' }, 'muse');
    expect(r.ok).toBe(true);
    expect(S.findClip(c.store.get(), mid.id).clip.midi!.notes.map((x) => x.start)).toEqual([0, 0.5]);
    await runTool(c, 'undo', {}, 'user');
    expect(S.findClip(c.store.get(), mid.id).clip.midi!.notes.map((x) => x.start)).toEqual([0.07, 0.52]);
    expect((await runTool(c, 'quantize_midi', { clip_id: clipId, grid: '1/4' }, 'user')).ok).toBe(false);
  });

  it('is visible to Muse', () => {
    const names = museToolSpecs().map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['extract_midi', 'quantize_midi']));
  });
});

describe('sidecar plumbing', () => {
  it('encodes a mono 16-bit WAV (stereo averaged)', () => {
    const wav = new DataView(encodeWavMono([new Float32Array([1, 0.5]), new Float32Array([0, -0.5])], 22050));
    expect(String.fromCharCode(...new Uint8Array(wav.buffer, 0, 4))).toBe('RIFF');
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(22050);
    expect(wav.getUint32(40, true)).toBe(4);
    expect(wav.getInt16(44, true)).toBe(16384);
    expect(wav.getInt16(46, true)).toBe(0);
  });

  it('maps tool args to prep.py options and reads the mock manifest', async () => {
    expect(prepArgs({ mode: 'drums', separate: 'none', grid: 'off', keySnap: false, bpm: 92 })).toEqual(
      ['--mode', 'drums', '--separate', 'none', '--grid', 'off', '--no-key-snap', '--bpm', '92'],
    );
    const cfg = sourcePrepConfig('/repo', { LATTICE_SIDECAR_MOCK: FIXTURE, LATTICE_BIGDISK: '/big' });
    expect(cfg.workDir).toBe('/big/out-k/app');
    expect(cfg.script).toBe('/repo/spikes/k_source_prep/run.sh');
    const m = await runSourcePrep(cfg, { sourceId: 'x', mode: 'auto', grid: '1/16', separate: 'auto', keySnap: true });
    expect(m.stems).toHaveLength(3);
    await expect(runSourcePrep({ ...cfg, mockManifest: undefined }, { sourceId: '../etc', mode: 'auto', grid: '1/16', separate: 'auto', keySnap: true })).rejects.toThrow(/bad source id/);
  });

  it('gives a stable signature that changes with the notes', () => {
    const m = stemToMidi(manifest().stems[0]);
    expect(midiSignature(m, 2)).toBe(midiSignature(structuredClone(m), 2));
    expect(midiSignature({ ...m, notes: m.notes.slice(1) }, 2)).not.toBe(midiSignature(m, 2));
  });
});
