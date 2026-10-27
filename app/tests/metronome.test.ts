import { describe, expect, it } from 'vitest';
import { barLength, beatLength, ClickScheduler, countInClicks, formatBarsBeats, formatTime, toBarsBeats } from '../src/core/metronome';

const m44 = { tempo: 120, timeSignature: [4, 4] as [number, number] };
const m68 = { tempo: 120, timeSignature: [6, 8] as [number, number] };

describe('metronome math', () => {
  it('beat and bar lengths', () => {
    expect(beatLength(m44)).toBe(0.5);
    expect(barLength(m44)).toBe(2);
    expect(beatLength(m68)).toBe(0.25); // 6/8 clicks eighth notes
    expect(barLength(m68)).toBe(1.5);
    expect(beatLength({ tempo: 90, timeSignature: [3, 4] })).toBeCloseTo(0.6667, 4);
  });

  it('seconds -> bars/beats/division (1-based, Logic-style)', () => {
    expect(toBarsBeats(0, m44)).toEqual({ bar: 1, beat: 1, division: 1 });
    expect(toBarsBeats(0.5, m44)).toEqual({ bar: 1, beat: 2, division: 1 });
    expect(toBarsBeats(2, m44)).toEqual({ bar: 2, beat: 1, division: 1 });
    expect(toBarsBeats(2.125, m44)).toEqual({ bar: 2, beat: 1, division: 2 });
    expect(formatBarsBeats(3.75, m44)).toBe('2 4 3');
    expect(formatTime(65.5)).toBe('1:05.50');
  });
});

describe('ClickScheduler (lookahead scheduling)', () => {
  function run(startPos: number, ticks: number[], meter = m44) {
    const clicks: [number, boolean][] = [];
    const s = new ClickScheduler((t, a) => clicks.push([Math.round(t * 1000) / 1000, a]), meter, 0.1);
    s.start(10, startPos, meter); // audio clock at 10 s == timeline startPos
    for (const t of ticks) s.tick(t);
    return clicks;
  }

  it('schedules each beat once, at exact audio times, accenting downbeats', () => {
    // ticks every 25 ms for 2.1 s of audio time (with jitter-free clock)
    const ticks = Array.from({ length: 85 }, (_, i) => 10 + i * 0.025);
    const clicks = run(0, ticks);
    expect(clicks.map((c) => c[0])).toEqual([10, 10.5, 11, 11.5, 12]);
    expect(clicks.map((c) => c[1])).toEqual([true, false, false, false, true]);
  });

  it('starting mid-bar waits for the next beat and keeps the bar phase', () => {
    const clicks = run(1.2, [10, 10.25, 10.5, 10.75, 11]); // beat 3 is at 1.0, next is 1.5 (beat 4), then 2.0 (bar 2)
    expect(clicks).toEqual([[10.3, false], [10.8, true]]);
  });

  it('only looks `lookahead` ahead and survives a late timer', () => {
    const clicks: number[] = [];
    const s = new ClickScheduler((t) => clicks.push(t), m44, 0.1);
    s.start(0, 0);
    expect(s.tick(0)).toBe(1); // beat at 0 only
    expect(s.tick(0.3)).toBe(0); // 0.5 is beyond 0.4
    expect(s.tick(0.45)).toBe(1); // 0.5 now inside
    s.tick(1.62); // timer stalled: 1.0 and 1.5 are in the past, 1.5 skipped as too late
    expect(clicks).toEqual([0, 0.5]);
    s.tick(1.95);
    expect(clicks).toEqual([0, 0.5, 2]);
  });

  it('stops', () => {
    const s = new ClickScheduler(() => {}, m44);
    s.start(0, 0);
    s.stop();
    expect(s.tick(5)).toBe(0);
  });

  it('count-in: one bar, downbeat accented', () => {
    expect(countInClicks(1, m44)).toEqual([
      { time: 1, accent: true },
      { time: 1.5, accent: false },
      { time: 2, accent: false },
      { time: 2.5, accent: false },
    ]);
  });
});
