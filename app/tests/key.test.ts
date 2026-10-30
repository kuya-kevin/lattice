// B20: detect a clip's key from its notes, keep it on the clip, and adopt it as the session key.
import { describe, expect, it } from 'vitest';
import { detectKey, scoreKeys } from '../src/core/key';
import type { MidiNote } from '../src/core/midi';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';

const seq = (pitches: number[], len = 0.5, vel = 100): MidiNote[] => pitches.map((pitch, i) => ({ pitch, start: i * len, duration: len, velocity: vel }));
const chord = (pitches: number[], start: number, len = 2): MidiNote[] => pitches.map((pitch) => ({ pitch, start, duration: len, velocity: 90 }));

const C_MAJOR_SCALE = seq([60, 62, 64, 65, 67, 69, 71, 72]);
// Am - Dm - E - Am (harmonic minor: the G# leading tone)
const A_MINOR_PROGRESSION = [...chord([57, 60, 64], 0), ...chord([62, 65, 69], 2), ...chord([56, 59, 64], 4), ...chord([57, 60, 64], 6, 4)];

describe('detectKey', () => {
  it('reads a C major scale as C major', () => {
    expect(detectKey(C_MAJOR_SCALE)?.key).toBe('C major');
  });

  it('reads an A minor progression with its leading tone as A minor', () => {
    const g = detectKey(A_MINOR_PROGRESSION)!;
    expect(g.key).toBe('A minor');
    expect(g.certainty).not.toBe('unsure');
  });

  it('names the relative key as a close second when only the shared notes are played', () => {
    // every white note once, evenly: C major or A minor
    const g = detectKey(seq([60, 62, 64, 65, 67, 69, 71]))!;
    expect(g.key).toBe('C major');
    expect(g.runnerUp?.key).toBe('A minor');
    expect(g.certainty).not.toBe('clear');
    // a melody that keeps landing on A is A minor, clearly
    expect(detectKey(seq([69, 72, 76, 74, 72, 71, 69, 67, 69]))).toMatchObject({ key: 'A minor', certainty: 'clear' });
  });

  it('weights long, loud notes more than short, quiet ones', () => {
    // a G major triad held, with quick quiet passing notes from C minor's scale
    const held = chord([55, 59, 62], 0, 4);
    const passing = seq([60, 63, 67, 68, 70], 0.05, 20);
    expect(detectKey([...held, ...passing])?.key).toBe('G major');
  });

  it('transposes: the same scale up a fifth is G major', () => {
    expect(detectKey(C_MAJOR_SCALE.map((n) => ({ ...n, pitch: n.pitch + 7 })))?.key).toBe('G major');
  });

  it('gives up on fewer than 3 different notes', () => {
    expect(detectKey(seq([60, 72, 64, 60]).slice(0, 2))).toBeNull();
    expect(scoreKeys(C_MAJOR_SCALE)).toHaveLength(24);
  });
});

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

function midiClip(c: ToolContext, name: string, notes: MidiNote[], opts: { drum?: boolean; start?: number } = {}) {
  let s = c.store.get();
  const [s1, t] = S.addTrack(s, name);
  const [s2, clip] = S.addMidiClip(s1, t.id, { name, midi: { instrument: opts.drum ? 'drums' : 'piano', ...(opts.drum ? { drum: true } : {}), notes }, sourceDuration: 8, start: opts.start ?? 0 });
  s = S.select(s2, t.id, clip.id);
  c.store.set(s);
  return clip.id;
}

describe('detect_key tool', () => {
  it('keeps the key on the clip, shows it to Muse, and leaves the session key alone', async () => {
    const c = ctx();
    const id = midiClip(c, 'Chords', A_MINOR_PROGRESSION);
    const r = await runTool(c, 'detect_key', {}, 'muse'); // the selected clip
    expect(r.ok).toBe(true);
    expect((r.result as any).key).toBe('A minor');
    expect(S.findClip(c.store.get(), id).clip.key).toBe('A minor');
    expect(c.store.get().key).toBeNull();
    expect(S.summarize(c.store.get())).toContain('[key A minor, detected]');
  });

  it('adopts it as the session key in one undo step', async () => {
    const c = ctx();
    midiClip(c, 'Lead', C_MAJOR_SCALE.map((n) => ({ ...n, pitch: n.pitch + 2 }))); // D major
    const r = await runTool(c, 'detect_key', { set_session_key: true }, 'user');
    expect((r.result as any).session_key).toBe('D major');
    expect(c.store.get().key).toBe('D major');
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().key).toBeNull();
  });

  it('drops the detected key when the notes change', async () => {
    const c = ctx();
    const id = midiClip(c, 'Lead', C_MAJOR_SCALE);
    await runTool(c, 'detect_key', { clip_id: id }, 'muse');
    await runTool(c, 'transpose_midi', { clip_id: id, semitones: 2 }, 'muse');
    expect(S.findClip(c.store.get(), id).clip.key).toBeUndefined();
  });

  it('reads an audio clip through its extracted stems, and refuses drums or a clip with no notes', async () => {
    const c = ctx();
    let s = S.addSource(c.store.get(), { id: 'src-vn', name: 'Hum', duration: 8, origin: 'record' });
    const [s1, t] = S.addTrack(s, 'Hum');
    const [s2, audio] = S.addClip(s1, t.id, 'src-vn', 0);
    c.store.set(s2);
    expect((await runTool(c, 'detect_key', { clip_id: audio.id }, 'muse')).error).toMatch(/extract_midi/);

    midiClip(c, 'Hum melody', A_MINOR_PROGRESSION);
    midiClip(c, 'Hum drums', seq([36, 38, 42]), { drum: true });
    const r = await runTool(c, 'detect_key', { clip_id: audio.id }, 'muse');
    expect((r.result as any).key).toBe('A minor');
    expect((r.result as any).from_clips).toHaveLength(1);
    s = c.store.get();
    expect(S.findClip(s, audio.id).clip.key).toBe('A minor');

    const drums = s.tracks.find((tr) => tr.name === 'Hum drums')!.clips[0].id;
    expect((await runTool(c, 'detect_key', { clip_id: drums }, 'muse')).error).toMatch(/drums have no key/);
  });
});
