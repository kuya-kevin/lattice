// Multi-select and group moves, track reordering, and the cycle area (C around the selection,
// snapping to the ruler, play from the cycle start).
import { expect, test, type Page } from '@playwright/test';

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);

function sineWav(seconds: number, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

/** Screen point of a timeline time in a track lane (samplesPerPixel 1024). */
async function xAt(page: Page, trackId: string, seconds: number) {
  const box = (await page.locator(`[data-track-row][data-track-id="${trackId}"]`).boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  return { x: box.x + (seconds * sr) / 1024, y: box.y + box.height / 2, box };
}

const regionHeader = (page: Page, trackId: string, n = 0) => page.locator(`[data-track-row][data-track-id="${trackId}"] [data-clip-container] > :first-child`).nth(n);

/** Three tracks: drums t1/c2 at 0 (2 s), keys t3/c4 at 1 s (1 s), vox t5/c6 at 0 (1 s). */
async function setup(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'drums.wav', mimeType: 'audio/wav', buffer: sineWav(2) },
    { name: 'keys.wav', mimeType: 'audio/wav', buffer: sineWav(1, 22050, 330) },
    { name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav(1, 22050, 440) },
  ]);
  await expect(page.locator('[data-track-row][data-track-id="t5"] [data-clip-container]')).toHaveCount(1);
  await tool(page, 'move_clip', { clip_id: 'c4', start: 1 });
  await expect.poll(async () => (await session(page)).tracks[1].clips[0].start).toBe(1);
}

test('shift-click selects several regions, dragging one moves them all', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);

  await regionHeader(page, 't1').click();
  await regionHeader(page, 't3').click({ modifiers: ['Shift'] });
  await expect.poll(async () => (await session(page)).selection).toEqual({ trackId: 't3', clipId: 'c4', clipIds: ['c2', 'c4'] });
  await expect(page.locator('[data-lt-selected]')).toHaveCount(2);

  // drag c2 by ~1 s and one track down: both move, snapped to the beat, keeping their shape
  const hb = (await regionHeader(page, 't1').boundingBox())!;
  const to = await xAt(page, 't3', 1.05);
  await page.mouse.move(hb.x + 4, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 30, hb.y + 10, { steps: 5 });
  await page.mouse.move(to.x + 4, to.y, { steps: 10 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(2);
  await expect(page.getByTestId('drop-indicator').first()).toContainText('2 regions');
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start]))).toEqual([[], [['c2', 1]], [['c6', 0], ['c4', 2]]]);
  expect((await session(page)).selection.clipIds).toEqual(['c2', 'c4']);

  // one undo step puts both back
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start]))).toEqual([[['c2', 0]], [['c4', 1]], [['c6', 0]]]);

  // a plain click on one of the selected regions selects just that one
  await regionHeader(page, 't3').click();
  await expect.poll(async () => (await session(page)).selection).toEqual({ trackId: 't3', clipId: 'c4' });
  expect(errors).toEqual([]);
});

test('a marquee from empty lane space selects the regions it touches; Delete removes them', async ({ page }) => {
  await setup(page);
  // from empty space on keys (t3) at 2.5 s, up-left to the drums lane at 0.5 s: touches c2 and c4, not c6
  const from = await xAt(page, 't3', 2.5);
  const to = await xAt(page, 't1', 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.getByTestId('marquee')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('marquee')).toHaveCount(0);
  await expect.poll(async () => [...((await session(page)).selection.clipIds ?? [])].sort()).toEqual(['c2', 'c4']);

  await page.keyboard.press('Delete');
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.clips.length)).toEqual([0, 0, 1]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.clips.length)).toEqual([1, 1, 1]);
});

test('dragging a track header reorders the tracks', async ({ page }) => {
  await setup(page);
  const vox = (await page.getByTestId('track-t5').locator('.track-num').boundingBox())!;
  const top = (await page.getByTestId('track-t1').boundingBox())!;
  await page.mouse.move(vox.x + 2, vox.y + 2);
  await page.mouse.down();
  await page.mouse.move(vox.x + 2, top.y + 4, { steps: 8 });
  await expect(page.getByTestId('track-drop-line')).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.id)).toEqual(['t5', 't1', 't3']);
  await expect(page.locator('[data-track-row]').first()).toHaveAttribute('data-track-id', 't5');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await session(page)).tracks.map((t) => t.id)).toEqual(['t1', 't3', 't5']);
});

test('C cycles around the selected regions on the Snap grid; play starts at the cycle; the cycle snaps to the ruler', async ({ page }) => {
  await setup(page);
  await tool(page, 'move_clip', { clip_id: 'c4', start: 2.4 }); // bar 2 (2-4 s at 120 BPM 4/4)
  await tool(page, 'move_clip', { clip_id: 'c6', start: 4.5 }); // bar 3, ends at 5.5 s
  await tool(page, 'select', { track_id: 't5', clip_id: 'c6', clip_ids: ['c4', 'c6'] });
  await tool(page, 'go_to', { position: 0 });
  await page.locator('body').click({ position: { x: 5, y: 300 } });

  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Cycle' })).toHaveClass(/on/);
  const shade = page.locator('[data-loop-region-timescale]');
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  const px = (s: number) => (s * sr) / 1024;
  const ruler = (await page.locator('[data-timescale-loop-creator]').boundingBox())!;
  let b = (await shade.boundingBox())!;
  expect(b.x - ruler.x).toBeCloseTo(px(2), 0); // Snap: Beat: 2.4 s -> 2 s, 5.5 s stays: 2 s to 5.5 s
  expect(b.width).toBeCloseTo(px(3.5), 0);

  // Space plays from the cycle start, not the playhead
  await page.keyboard.press(' ');
  await expect.poll(async () => (await session(page)).transport).toMatchObject({ playing: true, position: 2 });
  await page.keyboard.press(' ');

  // Snap: Bar widens it to whole bars (2-6 s)
  await page.getByRole('radio', { name: 'Bar' }).click();
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('c');
  await page.keyboard.press('c');
  b = (await shade.boundingBox())!;
  expect(b.width).toBeCloseTo(px(4), 0);
  await page.getByRole('radio', { name: 'Beat' }).click();
  await page.locator('body').click({ position: { x: 5, y: 300 } });

  // dragging the end marker lands on the grid (Snap: Beat = 0.5 s), not where the mouse let go
  const end = (await page.locator('[data-loop-marker-handle="end"]').boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2 + px(0.9), end.y + end.height / 2, { steps: 6 });
  await page.mouse.up();
  b = (await shade.boundingBox())!;
  expect(b.x + b.width - ruler.x).toBeCloseTo(px(7), 0); // 6 s + 0.9 s -> 7 s

  // C again turns the cycle off; play then starts at the playhead
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Cycle' })).not.toHaveClass(/on/);
});
