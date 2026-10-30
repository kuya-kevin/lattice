// The Oct 30 bug list: Muse's cycle tool, Stop that stops, takes from the cycle start, the first
// R recording, extending regions, the pinned ruler, Piano Roll edits (Option-drag copy, trimming
// a note's start, quantizing the selection), zoom on the left, library double-click to Ideas.
// Asserts on the session (window.lattice.getSession()) and on which audio sources are sounding.
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

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const tool = (page: Page, name: string, args: object = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);

/** Logs every AudioBufferSourceNode so a test can ask how many long sounds are playing now. */
async function watchSources(page: Page) {
  await page.addInitScript(() => {
    const live: { when: number; end: number; stopped: number; long: boolean; ctx: BaseAudioContext }[] = [];
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode & { __r?: (typeof live)[0] }, when = 0, off = 0, dur?: number) {
      const t = Math.max(when, this.context.currentTime);
      const r = { when: t, end: t + (dur ?? (this.buffer ? this.buffer.duration - off : 0)), stopped: Infinity, long: (this.buffer?.duration ?? 0) > 0.5, ctx: this.context };
      live.push(r);
      this.__r = r;
      return start.call(this, when, off, dur);
    } as typeof start;
    AudioBufferSourceNode.prototype.stop = function (this: AudioBufferSourceNode & { __r?: (typeof live)[0] }, when = 0) {
      if (this.__r) this.__r.stopped = Math.min(this.__r.stopped, Math.max(when, this.context.currentTime));
      return stop.call(this, when);
    } as typeof stop;
    (window as unknown as { __sounding: () => number }).__sounding = () =>
      live.filter((r) => r.long && r.when <= r.ctx.currentTime + 0.2 && r.end > r.ctx.currentTime && r.stopped > r.ctx.currentTime).length;
  });
}
const sounding = (page: Page) => page.evaluate(() => (window as unknown as { __sounding: () => number }).__sounding());

async function loadTone(page: Page, seconds = 6) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: sineWav(seconds) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
}

test('Muse sets a two-bar loop; Space plays from it, and Stop stops it every time', async ({ page }) => {
  await watchSources(page);
  await loadTone(page);
  await tool(page, 'set_tempo', { bpm: 240 }); // a bar is 1 s: the loop wraps often
  const r = await tool(page, 'set_cycle', { from_bar: 2, to_bar: 3 });
  expect(r.result).toMatchObject({ on: true, start: 1, end: 3 });
  await expect(page.getByRole('button', { name: 'Cycle' })).toHaveClass(/on/);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Space');
    await expect.poll(async () => (await session(page)).transport.playing).toBe(true);
    expect((await session(page)).transport.position).toBe(1); // from the cycle start, not the playhead
    await page.waitForTimeout(300 + i * 370); // stop at different points of the loop, some across the wrap
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await page.waitForTimeout(400);
    expect(await sounding(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  }
  // the playhead stops inside the cycle
  const pos = (await session(page)).transport.position;
  expect(pos).toBeGreaterThanOrEqual(1);
  expect(pos).toBeLessThan(3);
  // C turns it off and keeps the area; Muse sees it in the summary while it is on
  await page.keyboard.press('c');
  await expect.poll(async () => (await session(page)).cycle).toEqual({ on: false, start: 1, end: 3 });
  await expect(page.getByRole('button', { name: 'Cycle' })).not.toHaveClass(/on/);
});

test('Stop right after Play, while the audio is still starting, does not start it late', async ({ page }) => {
  await watchSources(page);
  await loadTone(page);
  for (let i = 0; i < 5; i++) {
    await tool(page, 'add_track', { name: `T${i}` }); // a rebuild: the next play starts its audio again
    await page.evaluate(async () => {
      await window.lattice!.runTool('play', { from: 0 });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await window.lattice!.runTool('stop', {});
    });
    await page.waitForTimeout(600);
    expect(await sounding(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    expect((await session(page)).transport.playing).toBe(false);
  }
});

test('R records: the first press opens the mic and starts; with Cycle on the take starts at the cycle', async ({ page }) => {
  await page.goto('/');
  await tool(page, 'add_track', { name: 'Vox' });
  await page.getByTestId('track-t1').locator('.track-num').click();
  await tool(page, 'set_cycle', { from_bar: 2, to_bar: 3 }); // 2-6 s at 120 BPM
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('r'); // the mic is not enabled yet
  await expect(page.getByTestId('lcd')).toContainText('REC', { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const clip = (await session(page)).tracks[0].clips[0];
  expect(clip.start).toBe(2); // the cycle start, not the playhead (0)
  expect(clip.duration).toBeGreaterThan(0.8);
});

test('a MIDI region extends past its notes and over the next region', async ({ page }) => {
  await page.goto('/');
  await tool(page, 'add_track', { name: 'Keys' });
  const t = (await session(page)).tracks[0].id;
  const notes = [{ pitch: 60, start: 0, duration: 0.5, velocity: 100 }];
  const a = (await tool(page, 'record_midi', { track_id: t, start: 0, duration: 2, notes })).result as { clip_id: string };
  await tool(page, 'record_midi', { track_id: t, start: 2, duration: 2, notes });
  await expect(page.locator('[data-clip-container]')).toHaveCount(2);
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  const px = (s: number) => (s * sr) / 1024;
  const edge = page.locator('[data-clip-container]').filter({ has: page.locator(`[data-clip-id="${a.clip_id}"]`) }).locator('[data-boundary-edge="right"]');
  const b = (await edge.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 4 });
  await page.mouse.move(x + px(1.5), y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).tracks[0].clips.find((c) => c.id === a.clip_id)?.duration).toBe(3.5);
});

test('the arrangement ruler stays in view with many tracks', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/');
  for (let i = 0; i < 12; i++) await tool(page, 'add_track', { name: `T${i}` });
  await expect(page.locator('[data-track-row]')).toHaveCount(12);
  await page.evaluate(() => document.querySelector('.canvas')!.scrollBy(0, 700));
  const bar = (await page.locator('.controlbar').boundingBox())!;
  await expect.poll(async () => (await page.locator('[data-lt-ruler]').boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  const ruler = (await page.locator('[data-lt-ruler]').boundingBox())!;
  expect(ruler.y).toBeLessThan(200);
  await page.evaluate(() => document.querySelector('.canvas')!.scrollTo(0, 0));
  await expect.poll(async () => page.locator('[data-lt-ruler]').evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});

/** A MIDI region with notes, opened in the Piano Roll. */
async function openRoll(page: Page, notes: object[]) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await tool(page, 'add_track', { name: 'Keys' });
  const t = (await session(page)).tracks[0].id;
  await tool(page, 'record_midi', { track_id: t, start: 0, duration: 4, notes });
  const region = page.locator('[data-clip-container]').first();
  await expect(region).toBeVisible();
  const b = (await region.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  // clear of the floating control bar (top) and prompt bar (bottom)
  await page.evaluate(() => {
    const r = document.querySelector('[data-testid="piano-roll"]')!.getBoundingClientRect();
    document.querySelector('.canvas')!.scrollBy(0, r.top + r.height / 2 - innerHeight / 2); // the canvas only, not the roll
  });
  return page.getByTestId('piano-roll').getByTestId('pr-note');
}
const roll = async (page: Page) => (await session(page)).tracks[0].clips[0].midi!.notes;

test('Piano Roll: Option-drag copies a note, the left edge trims its start, the right edge its end', async ({ page }) => {
  const notes = await openRoll(page, [{ pitch: 60, start: 0, duration: 1, velocity: 100 }]);
  await expect(notes).toHaveCount(1);
  const beatPx = async () => ((await notes.first().boundingBox())!.width + 1) / 2; // 1 s = 2 beats at 120

  // Option/Alt-drag: a copy one beat later; the original stays
  let b = (await notes.first().boundingBox())!;
  const bp = await beatPx();
  await page.keyboard.down('Alt');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + bp * 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await roll(page)).map((n) => [n.pitch, n.start, n.duration])).toEqual([[60, 0, 1], [60, 1, 1]]);

  // the left edge of the first note: its start moves, its end stays
  b = (await notes.first().boundingBox())!;
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 2 + bp, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await roll(page))[0]).toMatchObject({ start: 0.5, duration: 0.5 });

  // the right edge of the second note: longer
  b = (await notes.nth(1).boundingBox())!;
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2 + bp, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await roll(page))[1]).toMatchObject({ start: 1, duration: 1.5 });
});

test('Piano Roll: Quantize moves only the selected notes; zoom sits on the left', async ({ page }) => {
  const notes = await openRoll(page, [
    { pitch: 60, start: 0.03, duration: 0.2, velocity: 100 },
    { pitch: 64, start: 0.53, duration: 0.2, velocity: 100 },
  ]);
  await expect(notes).toHaveCount(2);
  await notes.nth(1).click();
  await page.getByTestId('piano-roll').getByRole('button', { name: 'Quantize' }).click();
  await expect.poll(async () => (await roll(page)).map((n) => n.start)).toEqual([0.03, 0.5]);

  const toolbar = page.getByTestId('piano-roll').getByRole('toolbar');
  const zoom = (await toolbar.getByRole('group', { name: 'Piano Roll zoom' }).boundingBox())!;
  const grid = (await toolbar.getByLabel('Piano Roll grid').boundingBox())!;
  expect(zoom.x).toBeLessThan(grid.x);
});

test('double-click a library sound: it joins Ideas, and Add to track puts it on a track', async ({ page }) => {
  await page.goto('/');
  await tool(page, 'add_track', { name: 'Drums' });
  await page.keyboard.press('l');
  await page.getByPlaceholder('Search sounds').fill('fixture kick');
  await page.getByTestId('lib-item-fs:103').dblclick();
  const card = page.locator('.idea').filter({ hasText: 'Fixture Kick' });
  await expect(card).toBeVisible();
  await card.getByLabel('Put Fixture Kick on a track').selectOption({ label: 'Drums' });
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  expect(s.sources[s.tracks[0].clips[0].sourceId].name).toBe('Fixture Kick');
});
