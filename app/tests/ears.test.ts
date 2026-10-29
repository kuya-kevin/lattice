// B9: measured features on signals with known answers, so a tool result Muse reads is right.
import { describe, expect, it } from 'vitest';
import { compare, measure } from '../src/core/ears';

const SR = 48000;
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const noise = (sec: number, amp = 0.1) => Float32Array.from({ length: sec * SR }, () => amp * rand());
const sine = (sec: number, hz: number, amp = 0.5) => Float32Array.from({ length: sec * SR }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const gain = (x: Float32Array, g: number) => x.map((v) => v * g);
/** one-pole low-pass, about 6 dB/octave above fc */
function lowpass(x: Float32Array, fc: number) {
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  const y = new Float32Array(x.length);
  for (let i = 0, p = 0; i < x.length; i++) y[i] = p = (1 - a) * x[i] + a * p;
  return y;
}

describe('ears: measured features', () => {
  it('reads level, peak and crest of a sine', () => {
    const f = measure([sine(2, 1000, 0.5)], SR);
    expect(f.level_db).toBeCloseTo(-9.0, 0); // 0.5 amplitude: -6 dB peak, -9 dB RMS
    expect(f.peak_db).toBeCloseTo(-6.0, 1);
    expect(f.crest_db).toBeCloseTo(0, 0); // a steady tone: its loudest 10 ms is its level
    expect(f.brightness_hz).toBeGreaterThan(950);
    expect(f.brightness_hz).toBeLessThan(1050);
    expect(f.bands.mid).toBeCloseTo(f.level_db, 0); // all its energy is in 500-2000 Hz
    expect(f.width).toBe(0);
  });

  it('a gain change reads as level, not as EQ', () => {
    const x = noise(2);
    const lines = compare(measure([x], SR), measure([gain(x, 0.5)], SR));
    expect(lines[0]).toMatch(/^level -6(\.0)? dB/);
    expect(lines.join('\n')).not.toMatch(/band|brightness/);
  });

  it('a low-pass reads as darker, with less air', () => {
    const x = noise(2);
    const before = measure([x], SR);
    const after = measure([lowpass(x, 1000)], SR);
    expect(after.brightness_hz).toBeLessThan(before.brightness_hz * 0.5);
    const text = compare(before, after).join('\n');
    expect(text).toMatch(/brightness -\d+%/);
    expect(text).toMatch(/air band -\d+(\.\d)? dB vs the least-changed band/);
    expect(text).not.toMatch(/(sub|low|low-mid) band \+/); // the untouched lows don't read as boosted
  });

  it('a cut in the low mids shows in that band', () => {
    const hi = sine(2, 3000, 0.3);
    const x = sine(2, 350, 0.3).map((v, i) => v + hi[i]);
    const y = sine(2, 350, 0.15).map((v, i) => v + hi[i]); // 350 Hz -6 dB
    const text = compare(measure([x], SR), measure([y], SR)).join('\n');
    expect(text).toMatch(/low-mid band -\d/);
  });

  it('flattening decaying hits lowers the crest (peaks flattened); a few spikes do not raise it', () => {
    const hits = (shape: (env: number) => number) =>
      Float32Array.from({ length: 2 * SR }, (_, i) => 0.5 * shape(Math.exp(-((i % (SR / 4)) / SR) * 30)) * Math.sin((2 * Math.PI * 200 * i) / SR));
    const punchy = hits((e) => e);
    const squashed = hits((e) => e ** 0.3);
    const text = compare(measure([punchy], SR), measure([squashed], SR)).join('\n');
    expect(text).toMatch(/crest -\d+(\.\d)? dB .*peaks flattened/);
    const spiky = squashed.slice();
    for (let i = 1000; i < spiky.length; i += SR / 2) spiky[i] = 0.99; // single-sample overshoots
    expect(Math.abs(measure([spiky], SR).crest_db - measure([squashed], SR).crest_db)).toBeLessThan(1);
  });

  it('width: identical channels are mono, independent ones are wide', () => {
    const x = noise(2);
    expect(measure([x, x], SR).width).toBe(0);
    const w = measure([x, noise(2)], SR).width;
    expect(w).toBeGreaterThan(0.9);
    expect(w).toBeLessThan(1.1);
  });

  it('spread is the loud-to-quiet range; silence is ignored', () => {
    const loudQuiet = new Float32Array(4 * SR);
    loudQuiet.set(sine(2, 440, 0.5), 0);
    loudQuiet.set(sine(1, 440, 0.05), 2 * SR); // 20 dB quieter, then 1 s of silence
    const f = measure([loudQuiet], SR);
    expect(f.spread_db).toBeGreaterThan(18);
    expect(f.spread_db).toBeLessThan(22);
    const even = new Float32Array(4 * SR);
    even.set(sine(3, 440, 0.5), 0);
    expect(compare(f, measure([even], SR)).join('\n')).toMatch(/loud-quiet spread -\d+(\.\d)? dB .*closer together/);
    expect(measure([new Float32Array(SR)], SR)).toMatchObject({ silent: true });
  });

  it('says so when nothing changed', () => {
    const x = noise(1);
    expect(compare(measure([x], SR), measure([x], SR))).toEqual(['no measurable change']);
  });
});
