// Region edits rebuild the playlist's audio engine. Playback must survive that: Play right
// after an edit plays, and an edit while playing carries on from where it was (with the click).
// Audio is checked on the audio clock: every AudioBufferSourceNode.start is logged.
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __src: { when: number; off: number; ctxNow: number }[];
    __clicks: { when: number; f: number }[];
    __ac: AudioContext;
  }
}

function sineWav(seconds: number, sr = 22050): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const tool = (page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n, a), [name, args] as const);
const sources = (page: Page) => page.evaluate(() => window.__src);
const lcdSeconds = (page: Page) =>
  page.getByTestId('lcd').innerText().then((t) => {
    const m = t.match(/(\d+):(\d\d\.\d\d)/)!;
    return Number(m[1]) * 60 + Number(m[2]);
  });

async function load(page: Page) {
  await page.addInitScript(() => {
    window.__src = [];
    window.__clicks = [];
    const src = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when?: number, off?: number, dur?: number) {
      window.__src.push({ when: when ?? 0, off: off ?? 0, ctxNow: this.context.currentTime });
      return src.call(this, when, off, dur);
    };
    const osc = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
      window.__ac = this.context as AudioContext;
      window.__clicks.push({ when: when ?? 0, f: this.frequency.value });
      return osc.call(this, when);
    };
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'pad.wav', mimeType: 'audio/wav', buffer: sineWav(12) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.waitForTimeout(300);
}

test('Play straight after a region edit plays (Muse: "trim it and play")', async ({ page }) => {
  await load(page);
  await page.evaluate(async () => {
    await window.lattice!.runTool('trim_clip', { clip_id: 'c2', start: 1, end: 6 });
    await window.lattice!.runTool('go_to', { position: 0 });
    await window.lattice!.runTool('play', {});
  });
  await expect.poll(async () => (await sources(page)).length, { timeout: 3000 }).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  expect(await lcdSeconds(page)).toBeGreaterThan(0.4);
  // later plays still work (the rebuilt engine was initialised)
  await tool(page, 'stop');
  await page.evaluate(() => (window.__src = []));
  await tool(page, 'go_to', { position: 2 });
  await tool(page, 'play');
  await expect.poll(async () => (await sources(page)).length, { timeout: 3000 }).toBeGreaterThan(0);
  await tool(page, 'stop');
});

test('an edit while playing carries on from the same place, with the click on the grid', async ({ page }) => {
  await load(page);
  await tool(page, 'set_metronome', { on: true });
  await tool(page, 'play');
  await page.waitForTimeout(1200);
  const before = await lcdSeconds(page);
  await page.evaluate(() => (window.__src = []));
  await tool(page, 'move_clip', { clip_id: 'c2', start: 0.25 });
  // the audio restarts at about the position it had reached, not at 0
  await expect.poll(async () => (await sources(page)).length, { timeout: 3000 }).toBeGreaterThan(0);
  const [s] = await sources(page);
  const resumedAt = 0.25 + s.off; // timeline position of the first sample played (clip starts at 0.25 s)
  expect(Math.abs(resumedAt - before)).toBeLessThan(0.4);
  await page.waitForTimeout(800);
  expect(await lcdSeconds(page)).toBeGreaterThan(before + 0.4);
  const st = await session(page);
  expect(st.transport.playing).toBe(true);
  // clicks scheduled after the resume sit on the beat grid of the resumed audio
  const clicks = await page.evaluate(() => window.__clicks.filter((c) => [1760, 1175].includes(c.f)).map((c) => c.when));
  const after = clicks.filter((t) => t > s.when + 0.01);
  expect(after.length).toBeGreaterThan(0);
  for (const t of after) {
    const pos = resumedAt + (t - s.when); // timeline position of this click
    expect(Math.abs(pos * 2 - Math.round(pos * 2))).toBeLessThan(0.01); // on a beat (0.5 s at 120 BPM)
  }
  await tool(page, 'stop');
});

test('Stop during the rebuild stays stopped', async ({ page }) => {
  await load(page);
  await tool(page, 'play');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    await window.lattice!.runTool('move_clip', { clip_id: 'c2', start: 1 });
    await window.lattice!.runTool('stop', {});
  });
  await page.evaluate(() => (window.__src = []));
  await page.waitForTimeout(800);
  expect(await sources(page)).toEqual([]);
  expect((await session(page)).transport.playing).toBe(false);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
