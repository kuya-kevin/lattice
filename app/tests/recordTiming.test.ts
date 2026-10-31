import { describe, expect, it } from 'vitest';
import { ctxTimeAt, cycleMicTake, foldMidiTake, heardPosition, onCycle, takeTrack, trimTake } from '../src/core/recordTiming';
import { addTrack, emptySession, select, setArm } from '../src/core/session';

// The transport plays timeline 4.0 s out of Web Audio at audio-clock 10.0 s.
const anchor = { ctxTime: 10, pos: 4 };

describe('heardPosition (what the player hears, for MIDI note times)', () => {
  it('is the transport position minus the output delay', () => {
    expect(heardPosition(10.5, anchor, 0)).toBeCloseTo(4.5, 9);
    // 20 ms to the speakers: at audio-clock 10.5 the player is hearing 4.48
    expect(heardPosition(10.5, anchor, 0.02)).toBeCloseTo(4.48, 9);
  });

  it('runs before the anchor too (notes played during the count-in)', () => {
    expect(heardPosition(9.9, anchor, 0)).toBeCloseTo(3.9, 9);
  });

  it('ctxTimeAt is its inverse (with no output delay)', () => {
    expect(ctxTimeAt(6, anchor)).toBe(12);
    expect(heardPosition(ctxTimeAt(6, anchor), anchor, 0)).toBe(6);
  });
});

describe('trimTake (lining a mic take up with what the player heard)', () => {
  it('cuts the lead-in plus the round trip out of the speakers and back in through the mic', () => {
    // recorder started 1.5 s before the take start left Web Audio (it ran during the count-in);
    // the take start reached the speakers 16 ms later and the mic adds 5 ms
    const t = trimTake({ anchor, recStart: 8.5, outputDelay: 0.016, inputDelay: 0.005 });
    expect(t.trim).toBeCloseTo(1.521, 9);
    expect(t.start).toBe(4);
  });

  it('a recorder that started late cannot be trimmed: the take moves later instead', () => {
    const t = trimTake({ anchor, recStart: 10.1, outputDelay: 0.02, inputDelay: 0 });
    expect(t.trim).toBe(0);
    expect(t.start).toBeCloseTo(4.08, 9);
  });
});

// Cycle 0-8 s (bars 1-4 at 120 BPM). Take positions are linear: they keep counting past the
// wrap, and these map them back onto the timeline the way the transport looped.
const cycle = { start: 0, end: 8 };

describe('onCycle', () => {
  it('leaves positions before the cycle end alone, and folds later ones back into the cycle', () => {
    expect(onCycle(6, cycle)).toBe(6);
    expect(onCycle(9.4, cycle)).toBeCloseTo(1.4, 9);
    expect(onCycle(17, cycle)).toBeCloseTo(1, 9);
    expect(onCycle(9.4, { start: 4, end: 8 })).toBeCloseTo(5.4, 9);
    expect(onCycle(9.4, null)).toBe(9.4);
  });
});

describe('foldMidiTake (cycle passes merge into one region, as in GarageBand)', () => {
  const n = (start: number, end: number | null) => ({ pitch: 60, velocity: 100, start, end });

  it('without a wrap, the region is the take as played', () => {
    expect(foldMidiTake([n(6.5, 7)], 6, 7.5, cycle)).toEqual({ start: 6, end: 7.5, played: [n(6.5, 7)] });
  });

  it('after a wrap, the region spans the cycle and later notes land inside it', () => {
    const r = foldMidiTake([n(6.5, 7), n(9.4, 9.6)], 6, 9.9, cycle);
    expect(r.start).toBe(0);
    expect(r.end).toBe(8);
    expect(r.played[0]).toEqual(n(6.5, 7));
    expect(r.played[1].start).toBeCloseTo(1.4, 9);
    expect(r.played[1].end).toBeCloseTo(1.6, 9);
  });

  it('a note held across the wrap is cut at the cycle end; a held note ends at the stop', () => {
    const r = foldMidiTake([n(7.5, 8.5), n(9, null)], 6, 9.5, cycle);
    expect(r.played[0]).toEqual(n(7.5, 8));
    expect(r.played[1].start).toBeCloseTo(1, 9);
    expect(r.played[1].end).toBeCloseTo(1.5, 9);
  });

  it('a take started before the cycle keeps its lead-in', () => {
    const r = foldMidiTake([], 2, 13, { start: 4, end: 8 });
    expect([r.start, r.end]).toEqual([2, 8]);
  });

  it('no cycle: unchanged', () => {
    expect(foldMidiTake([n(9.4, 9.6)], 6, 9.9, null)).toEqual({ start: 6, end: 9.9, played: [n(9.4, 9.6)] });
  });
});

describe('cycleMicTake (keeps the latest pass, as GarageBand shows the latest take)', () => {
  it('without a wrap, the whole take', () => {
    expect(cycleMicTake(6, 7.5, cycle, 0.5)).toEqual({ offset: 0, start: 6, duration: 1.5 });
  });

  it('after a wrap, the latest pass from the cycle start', () => {
    const r = cycleMicTake(6, 11, cycle, 0.5); // pass 2 runs 8..16 linear = 0..8 on the timeline
    expect(r).toEqual({ offset: 2, start: 0, duration: 3 });
  });

  it('a last pass shorter than a beat falls back to the previous full one', () => {
    expect(cycleMicTake(6, 8.2, cycle, 0.5)).toEqual({ offset: 0, start: 6, duration: 2 }); // the first, partial pass
    expect(cycleMicTake(6, 16.3, cycle, 0.5)).toEqual({ offset: 2, start: 0, duration: 8 });
  });
});

describe('takeTrack (which track a take records on)', () => {
  const two = () => {
    let s = emptySession();
    [s] = addTrack(s, 'Pluck FX 2890 - 03'); // empty, e.g. left by an undone take
    [s] = addTrack(s, 'Vocal');
    return s;
  };

  it('reuses an empty track named for the take instead of adding another (Oct 30, Cmd-K pluck)', () => {
    expect(takeTrack(two(), 'Pluck FX 2890 - 03')).toBe('t1');
  });

  it('else the top empty track, whatever its name (Oct 30: an empty "pad" track made for the take)', () => {
    const s = two();
    s.tracks[0].name = 'pad';
    expect(takeTrack(s, 'Electronic bouncy synth')).toBe('t1');
    s.tracks[0].clips.push({ id: 'c1' } as never);
    s.tracks[1].clips.push({ id: 'c2' } as never);
    expect(takeTrack(s, 'Keys')).toBeNull(); // no empty track: a new one
  });

  it('a track with regions on it is not reused by name', () => {
    const s = two();
    s.tracks[0].clips.push({ id: 'c1' } as never);
    expect(takeTrack(s, 'Pluck FX 2890 - 03')).toBe('t2'); // the empty Vocal track instead
  });

  it('the selected or armed track still wins', () => {
    expect(takeTrack(select(two(), 't2', null), 'Pluck FX 2890 - 03')).toBe('t2');
    expect(takeTrack(setArm(two(), 't2', true), 'Pluck FX 2890 - 03')).toBe('t2');
  });
});
