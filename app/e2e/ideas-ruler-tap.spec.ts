// Ruler click/drag moves the playhead (snapped), deleting sounds from Ideas, and tap tempo (T).
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

async function importTwo(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'kick.wav', mimeType: 'audio/wav', buffer: sineWav(1) },
    { name: 'bass.wav', mimeType: 'audio/wav', buffer: sineWav(3, 22050, 110) },
  ]);
  await expect(page.locator('[data-idea]')).toHaveCount(2);
}

test('ruler: click and drag move the playhead, snapped to the grid', async ({ page }) => {
  await importTwo(page);
  const ruler = page.locator('[data-lt-ruler]');
  const box = (await ruler.boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  const xAt = (sec: number) => box.x + (sec * sr) / 1024;
  const y = box.y + box.height - 6;

  await page.mouse.click(xAt(1.1), y); // snap Beat at 120 BPM: 0.5 s grid
  await expect.poll(async () => (await session(page)).transport.position).toBe(1);

  await page.mouse.move(xAt(0.3), y);
  await page.mouse.down();
  await page.mouse.move(xAt(1.4), y, { steps: 5 });
  await expect.poll(async () => (await session(page)).transport.position).toBe(1.5);
  await page.mouse.move(xAt(2.6), y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await session(page)).transport.position).toBe(2.5);
  await expect(page.getByTestId('lcd-bars')).toHaveText('2 2 1');

  // past the end of the audio (3 s): the playhead goes there, not back to the clip's end
  await page.mouse.click(xAt(6.1), y);
  await expect.poll(async () => (await session(page)).transport.position).toBe(6);
  await expect(page.getByTestId('lcd-bars')).toHaveText('4 1 1');

  // with Snap off it lands where you click
  await page.getByRole('radio', { name: 'Off' }).click();
  await page.mouse.click(xAt(0.8), y);
  await expect.poll(async () => (await session(page)).transport.position).toBeCloseTo(0.8, 1);
});

test('ideas: × deletes a sound, asking first when clips use it; Backspace on a focused card', async ({ page }) => {
  await importTwo(page);
  const [kick, bass] = Object.values((await session(page)).sources);
  const kickCard = page.locator(`[data-idea="${kick.id}"]`);

  // used sound: × asks, Cancel keeps it
  await kickCard.hover();
  await kickCard.getByRole('button', { name: 'Delete sound' }).click();
  await expect(kickCard.getByTestId('idea-confirm')).toContainText('1 clip');
  await kickCard.getByRole('button', { name: 'Cancel' }).click();
  expect(Object.keys((await session(page)).sources)).toHaveLength(2);

  // confirm: the sound and its clip go
  await kickCard.hover();
  await kickCard.getByRole('button', { name: 'Delete sound' }).click();
  await kickCard.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-idea]')).toHaveCount(1);
  let s = await session(page);
  expect(s.sources[kick.id]).toBeUndefined();
  expect(s.tracks.flatMap((t) => t.clips).every((c) => c.sourceId !== kick.id)).toBe(true);

  // undo brings it back
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-idea]')).toHaveCount(2);

  // Backspace with the card focused deletes the sound, not just the clip
  await kickCard.click();
  await page.keyboard.press('Backspace');
  await expect(kickCard.getByTestId('idea-confirm')).toBeVisible();
  await kickCard.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-idea]')).toHaveCount(1);

  // an unused sound goes without asking
  const bassClip = (await session(page)).tracks.flatMap((t) => t.clips).find((c) => c.sourceId === bass.id)!;
  await page.evaluate((id) => window.lattice!.runTool('delete_clip', { clip_id: id }), bassClip.id);
  const bassCard = page.locator(`[data-idea="${bass.id}"]`);
  await bassCard.click();
  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-idea]')).toHaveCount(0);
  s = await session(page);
  expect(s.sources[bass.id]).toBeUndefined();
});

test('backspace with a clip selected in the lanes still deletes only the clip', async ({ page }) => {
  await importTwo(page);
  const s0 = await session(page);
  const clip = s0.tracks[0].clips[0];
  await page.evaluate(({ t, c }) => window.lattice!.runTool('select', { track_id: t, clip_id: c }), { t: s0.tracks[0].id, c: clip.id });
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(0);
  expect((await session(page)).sources[clip.sourceId]).toBeDefined();
});

test('tap tempo: T previews in the LCD, then sets the tempo once; clicking the BPM shows the hint', async ({ page }) => {
  await importTwo(page);
  await page.getByLabel('Tempo').click();
  await expect(page.getByTestId('tap-hint')).toBeVisible();
  // T in the tempo field taps too (it's not a digit)
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('t');
    await page.waitForTimeout(400);
  }
  // while tapping: the field shows the tapped tempo, the session hasn't changed yet
  await expect(page.getByTestId('tempo-label')).toHaveText('TAP');
  expect(Number(await page.getByLabel('Tempo').inputValue())).toBeGreaterThan(130);
  expect((await session(page)).tempo).toBe(120);
  // ~2 s after the last tap it commits, once
  await expect.poll(async () => (await session(page)).tempo).toBeGreaterThan(130);
  expect((await session(page)).tempo).toBeLessThan(170);
  await expect(page.getByTestId('tempo-label')).toHaveText('BPM');
  await expect(page.getByLabel('Tempo')).not.toHaveValue(/t/i);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ControlOrMeta+z'); // one undo step for the whole tap run
  await expect.poll(async () => (await session(page)).tempo).toBe(120);

  // and from anywhere: T starts a tap run (its commit is checked above; the math in Vitest)
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('t');
    await page.waitForTimeout(600);
  }
  await expect(page.getByTestId('tempo-label')).toHaveText('TAP');
  expect(Number(await page.getByLabel('Tempo').inputValue())).toBeGreaterThan(90);
  expect(Number(await page.getByLabel('Tempo').inputValue())).toBeLessThan(110);
});
