import { describe, expect, it } from 'vitest';
import { barLength, beatLength, ClickScheduler, planCountIn, formatBarsBeats, formatTime, nextBarLine, prevBarLine, toBarsBeats } from '../src/core/metronome';

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

});

describe('planCountIn (one bar on the bar grid, ending where the take starts)', () => {
  const pos = (p: ReturnType<typeof planCountIn>, at: number) => p.clicks.map((c) => ({ pos: Math.round((at - (p.downbeat - c.time)) * 1000) / 1000, accent: c.accent }));

  it('from a bar line: the bar before it, downbeat accented, first click `lead` from now', () => {
    const p = planCountIn(4, m44, 10, 0.05);
    expect(p.clicks.map((c) => Math.round(c.time * 1e6) / 1e6)).toEqual([10.05, 10.55, 11.05, 11.55]);
    expect(p.downbeat).toBeCloseTo(12.05, 9); // the take starts one beat after the last click
    expect(pos(p, 4)).toEqual([
      { pos: 2, accent: true },
      { pos: 2.5, accent: false },
      { pos: 3, accent: false },
      { pos: 3.5, accent: false },
    ]);
  });

  it('from mid-beat: clicks stay on the grid, so the transport click carries straight on', () => {
    const p = planCountIn(19.151, m44, 0, 0.05);
    expect(pos(p, 19.151)).toEqual([
      { pos: 17.5, accent: false },
      { pos: 18, accent: true }, // bar 10 downbeat
      { pos: 18.5, accent: false },
      { pos: 19, accent: false },
    ]);
    expect(p.clicks[0].time).toBeCloseTo(0.05, 9);
    expect(p.downbeat - p.clicks[3].time).toBeCloseTo(0.151, 9); // 19 -> 19.151
  });

  it('from the very top: the count-in bar is before zero', () => {
    const p = planCountIn(0, m44, 1, 0);
    expect(pos(p, 0)).toEqual([
      { pos: -2, accent: true },
      { pos: -1.5, accent: false },
      { pos: -1, accent: false },
      { pos: -0.5, accent: false },
    ]);
    expect(p.downbeat).toBeCloseTo(3, 9);
  });

  it('6/8 counts six eighths', () => {
    const p = planCountIn(1.5, m68, 0, 0);
    expect(p.clicks).toHaveLength(6);
    expect(p.clicks.map((c) => c.accent)).toEqual([true, false, false, false, false, false]);
    expect(p.downbeat).toBeCloseTo(1.5, 9);
  });
});

describe('prevBarLine / nextBarLine (the , and . keys, as in Logic and GarageBand)', () => {
  const m = { tempo: 120, timeSignature: [4, 4] as [number, number] }; // 2 s bars

  it('go to the bar line before / after the playhead', () => {
    expect(nextBarLine(1.196, m)).toBe(2);
    expect(prevBarLine(3.196, m)).toBe(2);
  });

  it('from a bar line, move a whole bar', () => {
    expect(nextBarLine(2, m)).toBe(4);
    expect(prevBarLine(4, m)).toBe(2);
    expect(prevBarLine(4.0000001, m)).toBe(2); // float noise on a bar line counts as on it
  });

  it('stop at the start', () => {
    expect(prevBarLine(0.5, m)).toBe(0);
    expect(prevBarLine(0, m)).toBe(0);
  });

  it('follow the meter', () => {
    expect(nextBarLine(1, { tempo: 120, timeSignature: [6, 8] })).toBe(1.5);
  });
});
