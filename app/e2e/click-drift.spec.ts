// The click stays in time with a looping cycle (Oct 30: "during a long session the metronome gets
// out of sync"). Logs every click the metronome schedules and every time the engine restarts the
// region at a loop wrap, then measures how far each pass's downbeat click is from the audio.
// The tempo is chosen so the cycle isn't a whole number of the engine's ticks (Tone's Transport
// runs 192 PPQ at its own 120 BPM, so a tick is 1/384 s and its loop ends on the next tick).
// A 2/4 bar keeps the pass count of the original 4/4 run (~38) in half the time.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds: number, sr = 22050): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const tool = (page: Page, name: string, args: object = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);

type Log = { clicks: { t: number; accent: boolean; cancelled?: boolean }[]; starts: { t: number; offset: number }[] };

/** Click blips are oscillators (1760 Hz accent, 1175 Hz beat); the region is a long buffer source. */
async function watchAudio(page: Page) {
  await page.addInitScript(() => {
    const log: Log = { clicks: [], starts: [] };
    (window as unknown as { __audioLog: Log }).__audioLog = log;
    type Osc = OscillatorNode & { __c?: Log['clicks'][0] };
    const osc = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: Osc, when = 0) {
      const f = this.frequency.value;
      if (f === 1760 || f === 1175) log.clicks.push((this.__c = { t: when, accent: f === 1760 }));
      return osc.call(this, when);
    } as typeof osc;
    const oscStop = OscillatorNode.prototype.stop;
    OscillatorNode.prototype.stop = function (this: Osc, when = 0) {
      if (this.__c && Math.max(when, this.context.currentTime) <= this.__c.t) this.__c.cancelled = true; // stopped before it sounded
      return oscStop.call(this, when);
    } as typeof oscStop;
    const src = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when = 0, off = 0, dur?: number) {
      if ((this.buffer?.duration ?? 0) > 5) log.starts.push({ t: Math.max(when, this.context.currentTime), offset: off });
      return dur === undefined ? src.call(this, when, off) : src.call(this, when, off, dur);
    } as typeof src;
  });
}

test('the click stays on the loop downbeat pass after pass', async ({ page }) => {
  test.setTimeout(60_000);
  await watchAudio(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: sineWav(8) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await tool(page, 'set_tempo', { bpm: 230 });
  await tool(page, 'set_time_signature', { beats: 2, unit: 4 }); // a bar is 0.5217 s = 200.35 engine ticks
  await tool(page, 'set_cycle', { from_bar: 1, to_bar: 1 });
  await tool(page, 'set_metronome', { on: true });
  await page.keyboard.press('Space');
  await page.waitForTimeout(20_000); // ~38 passes
  await page.keyboard.press('Space');
  const log = await page.evaluate(() => (window as unknown as { __audioLog: Log }).__audioLog);
  // a wrap restarts the region from its start (offset 0); the first start is the play itself
  const wraps = log.starts.filter((s) => s.offset < 0.01).map((s) => s.t);
  const heard = log.clicks.filter((c) => !c.cancelled);
  const accents = heard.filter((c) => c.accent).map((c) => c.t);
  const offs = wraps.map((w) => {
    const near = accents.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), Infinity);
    return (near - w) * 1000;
  });
  console.log(`passes ${wraps.length}; click minus audio per pass (ms): ${offs.map((o) => o.toFixed(1)).join(' ')}`);
  expect(wraps.length).toBeGreaterThan(30);
  for (const o of offs) expect(Math.abs(o)).toBeLessThan(3);
  // two beats a pass, the first accented: none doubled at a wrap, none dropped
  for (let i = 0; i + 1 < wraps.length; i++) {
    const pass = heard.filter((c) => c.t >= wraps[i] - 0.005 && c.t < wraps[i + 1] - 0.005);
    expect(pass.map((c) => c.accent)).toEqual([true, false]);
  }
});
