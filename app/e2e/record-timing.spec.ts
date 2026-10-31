// Recording timing: the count-in hands off to the transport on the beat, notes land where
// they were heard, mic takes are latency-compensated, and the count-in can be cancelled.
// Clicks are timed on the audio clock, so the page logs every OscillatorNode.start.
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __clicks: { when: number; f: number }[];
    __ac: AudioContext;
  }
}

const CLICK_FREQS = [1760, 1175]; // click.ts: accent, other beats

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

async function load(page: Page) {
  await page.addInitScript(() => {
    window.__clicks = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
      window.__ac = this.context as AudioContext;
      window.__clicks.push({ when: when ?? 0, f: this.frequency.value });
      return start.call(this, when);
    };
  });
  await page.goto('/');
  await page.evaluate(() => window.lattice!.runTool('set_metronome', { on: true, count_in: true }));
  await page.getByRole('button', { name: 'Track', exact: true }).click(); // an empty track to record on
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  await page.getByTestId('track-t1').locator('.track-num').click();
  await page.evaluate(() => window.lattice!.runTool('go_to', { position: 1.3 })); // mid-beat (beat 3 of bar 1 + 0.3)
  await page.locator('body').click({ position: { x: 5, y: 600 } });
}

/** Click times (audio clock) once `n` clicks have been scheduled. */
async function clickTimes(page: Page, n: number): Promise<number[]> {
  await expect.poll(() => page.evaluate((f) => window.__clicks.filter((c) => f.includes(c.f)).length, CLICK_FREQS), { timeout: 8000 }).toBeGreaterThanOrEqual(n);
  return page.evaluate((f) => window.__clicks.filter((c) => f.includes(c.f)).map((c) => c.when), CLICK_FREQS);
}

test('the count-in sits on the bar grid and hands off to the transport on the beat', async ({ page }) => {
  await load(page);
  await page.keyboard.press('ControlOrMeta+k'); // Musical Typing: R records MIDI
  await page.keyboard.press('r');
  // 4 count-in clicks (timeline -0.5, 0, 0.5, 1.0), then the transport's own (1.5, 2.0, 2.5)
  const t = (await clickTimes(page, 7)).slice(0, 7);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  for (const g of gaps) expect(Math.abs(g - 0.5)).toBeLessThan(0.004);
  await page.keyboard.press('Space');
});

test('a note played on the click lands on the beat', async ({ page }) => {
  await load(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('r');
  await clickTimes(page, 5); // into the take
  // press C4 when a transport click that is still ahead reaches the speakers. Clicks are one per
  // beat from timeline -0.5, so click i is at -0.5 + 0.5i; `expected` also absorbs the poll's overshoot.
  const expected = await page.evaluate(async (f) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ac = window.__ac;
    const delay = (ac.outputLatency || 0) + (ac.baseLatency || 0);
    let i = -1;
    while (i < 0) {
      i = window.__clicks.filter((c) => f.includes(c.f)).findIndex((c) => c.when + delay > ac.currentTime + 0.02);
      if (i < 0) await sleep(5);
    }
    const heardAt = window.__clicks.filter((c) => f.includes(c.f))[i].when + delay;
    while (ac.currentTime < heardAt) await sleep(1);
    const pos = -0.5 + 0.5 * i + (ac.currentTime - heardAt);
    const key = (type: string) => window.dispatchEvent(new KeyboardEvent(type, { key: 'a', code: 'KeyA', bubbles: true }));
    key('keydown');
    await sleep(200);
    key('keyup');
    return pos;
  }, CLICK_FREQS);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const clip = (await session(page)).tracks[0].clips[0];
  expect(clip.start).toBeCloseTo(1.3, 3);
  const note = clip.midi!.notes[0];
  expect(Math.abs(clip.start + note.start - expected)).toBeLessThan(0.01); // was ~0.12 late (lookahead + output latency)
});

test('R or Space during the count-in cancels it: no take, no transport, no clicks after', async ({ page }) => {
  await load(page);
  await page.keyboard.press('ControlOrMeta+k');
  for (const cancel of ['r', 'Space']) {
    await page.evaluate(() => (window.__clicks = []));
    await page.keyboard.press('r');
    await clickTimes(page, 1);
    await page.keyboard.press(cancel);
    await expect(page.getByTestId('lcd')).not.toContainText('REC');
    await page.waitForTimeout(2500); // past where the downbeat would have been
    const s = await session(page);
    expect(s.transport.playing).toBe(false);
    expect(s.tracks.flatMap((t) => t.clips)).toEqual([]);
    expect(s.tracks).toHaveLength(1);
    // only count-in clicks were scheduled, and none sound after the cancel
    expect(await page.evaluate((f) => window.__clicks.filter((c) => f.includes(c.f)).length, CLICK_FREQS)).toBeLessThanOrEqual(4);
  }
});

test('a mic take with count-in starts where recording started, without the count-in bar', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('COUNT-IN');
  await clickTimes(page, 6); // into the take
  await expect(page.getByTestId('lcd')).toContainText('REC');
  await page.waitForTimeout(500);
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  const clip = s.tracks[0].clips[0];
  expect(clip.start).toBeCloseTo(1.3, 3);
  // the take runs from 1.3 to where it was stopped; the count-in bar was trimmed off the front.
  // It ends ~35-50 ms short of the stop (the input-latency compensation, plus ~6 ms of block
  // jitter on each side), so 0.05 failed now and then; an untrimmed count-in would be 2 s off.
  expect(Math.abs(clip.start + clip.duration - s.transport.position)).toBeLessThan(0.1);
});

/** Cycle on over bar 4 at 240 BPM (3-4 s), the playhead elsewhere: a take from a stop starts at
 *  the cycle's left edge (3 s), and the transport wraps at 4 s back to 3 s. */
async function cycleFrom3(page: Page) {
  await load(page);
  await page.evaluate(() => window.lattice!.runTool('set_tempo', { bpm: 240 }));
  await expect(page.getByLabel('Tempo')).toHaveValue('240');
  await page.evaluate(() => window.lattice!.runTool('set_cycle', { from_bar: 4, to_bar: 4 }));
  await expect(page.getByRole('button', { name: 'Cycle' })).toHaveClass(/on/);
  await page.evaluate(() => window.lattice!.runTool('go_to', { position: 0.5 }));
  await expect(page.getByTestId('lcd-bars')).toHaveText('1 3 1'); // 0.5 s at 240 BPM
}

test('cycle recording MIDI: notes after the wrap land inside the cycle, in one region over it', async ({ page }) => {
  await cycleFrom3(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('r');
  await clickTimes(page, 4); // count-in (1 s at 240 BPM), then 1 s to the wrap
  await page.waitForTimeout(1000 + 1500); // past the wrap, about 0.5 s into the second pass
  await page.keyboard.down('a');
  await page.waitForTimeout(100);
  await page.keyboard.up('a');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  const clip = s.tracks[0].clips[0];
  expect([clip.start, clip.duration]).toEqual([3, 1]);
  const note = clip.midi!.notes[0]; // source-relative: 0 is the region start, 3 s
  expect(note.start).toBeGreaterThan(0);
  expect(note.start).toBeLessThan(1); // not past the cycle end
  expect(s.transport.position).toBeLessThan(4);
});

test('cycle recording audio keeps the latest pass, from the cycle start', async ({ page }) => {
  await cycleFrom3(page);
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('r');
  await clickTimes(page, 4);
  await page.waitForTimeout(1200); // past the first wrap
  // stop mid-pass: a stop in a pass's first beat keeps the pass before it (cycleMicTake), and a
  // fixed wait landed there now and then under load
  await expect(page.getByTestId('lcd-bars')).toHaveText(/^4 [23] /);
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  const clip = s.tracks[0].clips[0];
  expect(clip.start).toBe(3);
  // runs to where it stopped, less the latency compensation (see the count-in mic take above); an
  // earlier pass would end ~0.5 s off
  expect(Math.abs(clip.start + clip.duration - s.transport.position)).toBeLessThan(0.1);
  expect(s.transport.position).toBeLessThan(4);
});
