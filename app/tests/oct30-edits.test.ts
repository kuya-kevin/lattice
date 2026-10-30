// Oct 30 bug list: a MIDI region's end extends past its notes; Quantize only the selected notes.
import { describe, expect, it } from 'vitest';
import type { MidiNote } from '../src/core/midi';
import { StubSidecar } from '../src/core/sidecar';
import * as S from '../src/core/session';
import { SessionStore } from '../src/core/store';
import { runTool, type ToolContext } from '../src/core/tools';

const ctx = (): ToolContext => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }) });

function midiClip(c: ToolContext, notes: MidiNote[], sourceDuration = 2) {
  const [s1, t] = S.addTrack(c.store.get(), 'Keys');
  const [s2, clip] = S.addMidiClip(s1, t.id, { name: 'Keys', midi: { instrument: 'piano', notes }, sourceDuration, start: 4 });
  c.store.set(s2);
  return clip;
}

describe('extending a region', () => {
  it('a MIDI region extends past its notes; its source grows with it (one undo)', async () => {
    const c = ctx();
    const clip = midiClip(c, [{ pitch: 60, start: 0, duration: 0.5, velocity: 100 }]);
    const r = await runTool(c, 'trim_clip', { clip_id: clip.id, start: 4, end: 10 }, 'user');
    expect(r.ok).toBe(true);
    const s = c.store.get();
    expect(S.findClip(s, clip.id).clip).toMatchObject({ start: 4, offset: 0, duration: 6 });
    expect(s.sources[clip.sourceId].duration).toBe(6);
    await runTool(c, 'undo', {}, 'user');
    expect(S.findClip(c.store.get(), clip.id).clip.duration).toBe(2);
  });

  it('an audio region still stops at the end of its recording', async () => {
    const c = ctx();
    const s0 = S.addSource(c.store.get(), { id: 'src-a', name: 'Take', duration: 3, origin: 'record' });
    const [s1, t] = S.addTrack(s0, 'Vox');
    const [s2, clip] = S.addClip(s1, t.id, 'src-a', 0);
    c.store.set(s2);
    await runTool(c, 'trim_clip', { clip_id: clip.id, start: 0, end: 9 }, 'user');
    expect(S.findClip(c.store.get(), clip.id).clip.duration).toBe(3);
  });
});

describe('quantize_midi notes', () => {
  it('quantizes only the given notes', async () => {
    const c = ctx(); // 120 BPM: a 1/16 is 0.125 s; the clip starts at 4 s (on the grid)
    const clip = midiClip(c, [
      { pitch: 60, start: 0.03, duration: 0.2, velocity: 100 },
      { pitch: 62, start: 0.53, duration: 0.2, velocity: 100 },
      { pitch: 64, start: 1.03, duration: 0.2, velocity: 100 },
    ]);
    const r = await runTool(c, 'quantize_midi', { clip_id: clip.id, grid: '1/16', notes: [1] }, 'user');
    expect(r.ok).toBe(true);
    expect((r.result as any).quantized).toBe(1);
    expect(S.findClip(c.store.get(), clip.id).clip.midi!.notes.map((n) => n.start)).toEqual([0.03, 0.5, 1.03]);
    await runTool(c, 'quantize_midi', { clip_id: clip.id, grid: '1/16' }, 'user'); // no notes: all
    expect(S.findClip(c.store.get(), clip.id).clip.midi!.notes.map((n) => n.start)).toEqual([0, 0.5, 1]);
  });
});
