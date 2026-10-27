// Musical Typing's sampler: the selected audio clip is the instrument (A = its own pitch), and a
// take recorded with it keeps the sample (record_midi's optional `sample`), through undo,
// duplicate_clip and quantize_midi.
import { describe, expect, it } from 'vitest';
import { describeMidi, midiSignature, sampleRateFor, type MidiData } from '../src/core/midi';
import { SAMPLE_ROOT, keyAction, pitchAt, DEFAULT_BASE, typingInstrument } from '../src/core/musicalTyping';
import * as S from '../src/core/session';
import { StubSidecar } from '../src/core/sidecar';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';

function ctx(): ToolContext {
  return { store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) };
}

/** t1 "Lead Hit 5th" with audio clip c2 (source s, 2 s) trimmed to 0.5-1.5 s; empty t3 "Keys". */
async function withSample() {
  const c = ctx();
  await runTool(c, 'import_audio', { source_id: 's', name: 'Lead Hit 5th', duration: 2 }, 'user');
  await runTool(c, 'trim_clip', { clip_id: 'c2', start: 0.5, end: 1.5 }, 'user');
  await runTool(c, 'add_track', { name: 'Keys' }, 'user');
  return c;
}

const notes = [
  { pitch: 60, velocity: 100, start: 0.1, duration: 0.3 },
  { pitch: 67, velocity: 80, start: 0.53, duration: 0.2 },
];
const sampleArg = { source_id: 's', offset: 0.5, duration: 1, root: 60 };

describe('sampler pitch math', () => {
  it('plays the root unchanged, an octave up at 2x, a fifth up at 2^(7/12)', () => {
    expect(SAMPLE_ROOT).toBe(60);
    expect(sampleRateFor(60, 60)).toBe(1);
    expect(sampleRateFor(72, 60)).toBe(2);
    expect(sampleRateFor(48, 60)).toBe(0.5);
    expect(sampleRateFor(67, 60)).toBeCloseTo(1.4983, 4);
    expect(sampleRateFor(61, 60)).toBeCloseTo(1.05946, 5);
  });

  it('the A key at the default octave is the root', () => {
    const a = keyAction('KeyA');
    expect(a).toEqual({ type: 'note', offset: 0 });
    expect(pitchAt(DEFAULT_BASE, 0)).toBe(SAMPLE_ROOT);
  });
});

describe('typingInstrument', () => {
  it('is the selected audio clip (its audible region), else the selected track’s first clip, else the piano', async () => {
    const c = await withSample();
    let s = S.select(c.store.get(), 't1', 'c2');
    expect(typingInstrument(s)).toEqual({ name: 'Lead Hit 5th', sample: { sourceId: 's', offset: 0.5, duration: 1, root: 60 } });
    s = S.select(s, 't1', null);
    expect(typingInstrument(s)?.sample.sourceId).toBe('s');
    expect(typingInstrument(S.select(s, 't3', null))).toBeNull(); // empty track
    expect(typingInstrument(S.select(s, null, null))).toBeNull();
  });

  it('a MIDI clip: its sample if recorded with one, else the piano', async () => {
    const c = await withSample();
    await runTool(c, 'record_midi', { track_id: 't3', start: 0, duration: 1, notes, instrument: 'Lead Hit 5th', sample: sampleArg }, 'user');
    const sampled = c.store.get();
    expect(typingInstrument(sampled)).toEqual({ name: 'Lead Hit 5th', sample: { sourceId: 's', offset: 0.5, duration: 1, root: 60 } });
    await runTool(c, 'record_midi', { track_id: 't3', start: 2, duration: 1, notes }, 'user');
    expect(typingInstrument(c.store.get())).toBeNull(); // selected: the piano take
  });
});

describe('record_midi with a sample', () => {
  it('stores the sample on the clip; undo removes it; duplicate and quantize keep it', async () => {
    const c = await withSample();
    const r = await runTool(c, 'record_midi', { track_id: 't3', start: 0, duration: 1, notes, instrument: 'Lead Hit 5th', sample: sampleArg }, 'user');
    expect(r).toMatchObject({ ok: true, result: { instrument: 'Lead Hit 5th', notes: 2 } });
    const clip = c.store.get().tracks[1].clips[0];
    expect(clip.midi).toEqual({ instrument: 'Lead Hit 5th', sample: { sourceId: 's', offset: 0.5, duration: 1, root: 60 }, notes });
    expect(S.summarize(c.store.get())).toContain('[MIDI sampler "Lead Hit 5th", 2 notes C4-G4]');

    await runTool(c, 'duplicate_clip', { clip_id: clip.id, start: 4 }, 'user');
    const copy = c.store.get().tracks[1].clips[1];
    expect(copy.midi!.sample).toEqual(clip.midi!.sample);

    await runTool(c, 'quantize_midi', { clip_id: clip.id, grid: '1/4' }, 'user');
    const q = c.store.get().tracks[1].clips[0];
    expect(q.midi!.notes.map((n) => n.start)).toEqual([0, 0.5]);
    expect(q.midi!.sample).toEqual(clip.midi!.sample);
    expect(q.midi!.instrument).toBe('Lead Hit 5th');

    await runTool(c, 'undo', {}, 'user'); // quantize
    expect(c.store.get().tracks[1].clips[0].midi).toEqual(clip.midi);
    await runTool(c, 'undo', {}, 'user'); // duplicate
    await runTool(c, 'undo', {}, 'user'); // the take
    expect(c.store.get().tracks[1].clips).toEqual([]);
    await runTool(c, 'redo', {}, 'user');
    expect(c.store.get().tracks[1].clips[0].midi!.sample).toEqual(clip.midi!.sample);
  });

  it('defaults the label to the source name; without a sample it is the piano', async () => {
    const c = await withSample();
    await runTool(c, 'record_midi', { track_id: 't3', start: 0, duration: 1, notes, sample: sampleArg }, 'user');
    expect(c.store.get().tracks[1].clips[0].midi!.instrument).toBe('Lead Hit 5th');
    await runTool(c, 'record_midi', { track_id: 't3', start: 2, duration: 1, notes }, 'user');
    expect(c.store.get().tracks[1].clips[1].midi).toEqual({ instrument: 'piano', notes });
  });

  it('rejects a missing or MIDI source, a region outside the source, a bad root, a label alone', async () => {
    const c = await withSample();
    const take = (extra: object) => runTool(c, 'record_midi', { track_id: 't3', start: 0, duration: 1, notes, ...extra }, 'user');
    expect((await take({ sample: { ...sampleArg, source_id: 'nope' } })).error).toMatch(/not found/);
    expect((await take({ sample: { ...sampleArg, offset: 1.5 } })).error).toMatch(/outside/);
    expect((await take({ sample: { ...sampleArg, duration: 0 } })).error).toMatch(/outside/);
    expect((await take({ sample: { ...sampleArg, offset: -1 } })).error).toMatch(/outside/);
    expect((await take({ sample: { ...sampleArg, root: 60.5 } })).error).toMatch(/root/);
    expect((await take({ sample: { ...sampleArg, root: 200 } })).error).toMatch(/root/);
    expect((await take({ sample: { ...sampleArg, root: 'C4' } })).error).toMatch(/numeric/);
    expect((await take({ sample: 'Lead' })).error).toMatch(/must be a object/);
    expect((await take({ instrument: 'Lead' })).error).toMatch(/needs a sample/);
    // a MIDI clip's source is not audio
    await take({});
    const midiSrc = c.store.get().tracks[1].clips[0].sourceId;
    expect((await take({ sample: { ...sampleArg, source_id: midiSrc, offset: 0, duration: 0.5 } })).error).toMatch(/MIDI clip/);
    expect(c.store.get().tracks[1].clips).toHaveLength(1);
  });
});

describe('midiSignature / describeMidi', () => {
  it('a sample (or its region) changes the signature, so the render is redone', () => {
    const piano: MidiData = { instrument: 'piano', notes };
    const sampled: MidiData = { instrument: 'piano', sample: { sourceId: 's', offset: 0, duration: 1, root: 60 }, notes };
    const moved: MidiData = { ...sampled, sample: { ...sampled.sample!, offset: 0.25 } };
    const sigs = new Set([midiSignature(piano, 2), midiSignature(sampled, 2), midiSignature(moved, 2)]);
    expect(sigs.size).toBe(3);
    expect(midiSignature(sampled, 2)).toBe(midiSignature({ ...sampled, notes: [...notes] }, 2));
    expect(describeMidi({ ...sampled, instrument: 'Hit', notes: [] })).toBe('MIDI sampler "Hit", empty');
  });
});
