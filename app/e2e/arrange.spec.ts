// Sound library (fixture data via the dev middleware) and moving clips across tracks.
import { expect, test, type Page } from '@playwright/test';

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

function sineWav(seconds: number, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

/** Pixel x of a timeline time inside a track row (samplesPerPixel 1024, engine rate from the page). */
async function xAt(page: Page, trackId: string, seconds: number) {
  const box = (await page.locator(`[data-track-row][data-track-id="${trackId}"]`).boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  return { x: box.x + (seconds * sr) / 1024, y: box.y + box.height / 2, box };
}

test('library: browse, search, filter, preview, credit and drag onto the timeline', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('o'); // Logic: O shows the Loop Browser
  const lib = page.getByTestId('library');
  await expect(lib).toBeVisible();
  await expect(page.getByTestId('lib-browse')).toContainText('Instruments & Drums');
  await expect(page.getByTestId('lib-browse')).toContainText('Voice Notes');

  // category browse -> list -> back
  await lib.getByRole('button', { name: /Kick/ }).click();
  await expect(page.getByTestId('lib-list').locator('.lib-row')).toHaveCount(1);
  await lib.getByRole('button', { name: '‹ All' }).click();

  // search + chips
  await lib.getByPlaceholder('Search sounds').fill('fixture');
  await expect(page.getByTestId('lib-list').locator('.lib-row')).toHaveCount(4); // Oct 30: the Material set is hidden (b231c6f)
  await lib.getByRole('button', { name: 'Drums' }).click();
  await lib.getByRole('button', { name: 'CC0 only' }).click();
  await expect(page.getByTestId('lib-list').locator('.lib-row')).toHaveCount(1); // the hat (the CC0 drum loop was Material)
  await lib.getByRole('button', { name: 'Reset' }).click();

  // click to preview; CC-BY sounds show their credit line
  await lib.getByPlaceholder('Search sounds').fill('sub bass');
  await page.getByTestId('lib-item-fs:102').click();
  await expect(page.getByTestId('lib-item-fs:102')).toHaveClass(/playing/);
  await expect(page.getByTestId('lib-credit')).toContainText('Attribution required');
  await expect(page.getByTestId('lib-credit')).toContainText('by bass_maker');

  // drag onto the empty arrange area -> new track at bar 1
  await page.getByTestId('lib-item-fs:102').dragTo(page.getByTestId('empty'));
  await expect(page.getByTestId('track-t1')).toContainText('Fixture Sub Bass');
  let s = await session(page);
  expect(s.tracks[0].clips[0]).toMatchObject({ start: 0, name: 'Fixture Sub Bass' });
  expect(Object.values(s.sources)[0].credit).toMatch(/bass_maker/);

  // drag onto track 1 at ~2.1 s -> lands on the beat grid (120 BPM: 0.5 s) at 2 s
  await lib.getByPlaceholder('Search sounds').fill('kick');
  const at = await xAt(page, 't1', 2.1);
  await page.getByTestId('lib-item-fs:103').dragTo(page.locator('.arrange'), {
    targetPosition: await page.locator('.arrange').boundingBox().then((b) => ({ x: at.x - b!.x, y: at.y - b!.y })),
  });
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(2);
  s = await session(page);
  expect(s.tracks[0].clips[1]).toMatchObject({ name: 'Fixture Kick', start: 2 });

  // drag below the last track -> a new track
  await lib.getByPlaceholder('Search sounds').fill('voice note');
  const below = { x: at.x - (await page.locator('.arrange').boundingBox())!.x, y: at.box.y + at.box.height + 30 - (await page.locator('.arrange').boundingBox())!.y };
  await page.getByTestId('lib-item-vn:new_recording_900').dragTo(page.locator('.arrange'), { targetPosition: below });
  await expect(page.getByTestId('track-t4')).toContainText('Voice note 900');
  s = await session(page);
  expect(s.tracks[1].clips[0].start).toBe(2);
  expect(errors).toEqual([]);
});

test('clips move across tracks with snap, a drop indicator, and undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'drums.wav', mimeType: 'audio/wav', buffer: sineWav(2) },
    { name: 'keys.wav', mimeType: 'audio/wav', buffer: sineWav(1, 22050, 330) },
  ]);
  await expect(page.getByTestId('track-t3')).toBeVisible();
  await expect(page.locator('[data-track-row][data-track-id="t3"] [data-clip-container]')).toHaveCount(1);

  // drag the "keys" region (t3, c4) by its header onto track 1 at ~3.15 s -> snaps to 3 s
  const header = page.locator('[data-track-row][data-track-id="t3"] [data-clip-container] > :first-child');
  const hb = (await header.boundingBox())!;
  const target = await xAt(page, 't1', 3.15);
  await page.mouse.move(hb.x + 4, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y - 10, { steps: 5 });
  await page.mouse.move(target.x + 4, target.y, { steps: 10 });
  const ghost = page.getByTestId('drop-indicator');
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText('2 3 1 · drums'); // help tag: bar 2 beat 3 on "drums"
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);

  await expect.poll(async () => (await session(page)).tracks[1].clips.length).toBe(0);
  let s = await session(page);
  expect(s.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([['c2', 0], ['c4', 3]]);
  expect(s.selection).toEqual({ trackId: 't1', clipId: 'c4' });
  await expect(page.locator('[data-lt-selected] > :first-child')).toHaveAttribute('data-lt-name', 'keys');

  // undo (Ctrl+Z here; Cmd+Z on the Mac) puts it back, redo moves it again
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await session(page)).tracks[1].clips.map((c) => c.id)).toEqual(['c4']);
  s = await session(page);
  expect(s.tracks[1].clips[0].start).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(2);

  // with snap off a move lands where it is dropped
  await page.getByRole('radio', { name: 'Off' }).click();
  const c4 = page.locator('[data-track-row][data-track-id="t1"] [data-clip-container] > :first-child').nth(1);
  const b4 = (await c4.boundingBox())!;
  const to = await xAt(page, 't1', 3.6);
  await page.mouse.move(b4.x + 4, b4.y + b4.height / 2);
  await page.mouse.down();
  await page.mouse.move(b4.x + 20, b4.y + 4, { steps: 4 });
  await page.mouse.move(to.x + 4, b4.y + b4.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).tracks[0].clips[1].start).toBeCloseTo(3.6, 1);
  expect((await session(page)).tracks[0].clips[1].start).not.toBe(3.5);

  // click selects a region; Delete removes it; undo brings it back
  await page.locator('[data-track-row][data-track-id="t1"] [data-clip-container] > :first-child').nth(1).click();
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c4');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(2);
  expect(errors).toEqual([]);
});

test('trimming a region end snaps to the beat and is committed once (one undo step)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'pad.wav', mimeType: 'audio/wav', buffer: sineWav(3) });
  await expect(page.locator('[data-boundary-edge="right"]')).toHaveCount(1);
  const edge = (await page.locator('[data-boundary-edge="right"]').boundingBox())!;
  const to = await xAt(page, 't1', 1.62); // nearest beat at 120 BPM: 1.5 s
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 10, edge.y + edge.height / 2, { steps: 4 });
  await page.mouse.move(to.x, edge.y + edge.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].duration).toBe(1.5);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].duration).toBe(3);
});

test('track headers: arm, select, Smart Controls pane', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav(1) });
  const t = page.getByTestId('track-t1');
  await t.getByRole('button', { name: 'R' }).click();
  await expect(t.getByRole('button', { name: 'R' })).toHaveClass(/arm/);
  expect((await session(page)).tracks[0].armed).toBe(true);
  await t.locator('.track-name').click();
  await expect(t).toHaveClass(/selected/);
  await expect(page.getByTestId('smart-controls')).toContainText('vox');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('b');
  await expect(page.getByTestId('smart-controls')).toHaveCount(0);
  await page.keyboard.press('b');
  await expect(page.getByTestId('device-panel-slot')).toBeVisible();
});
