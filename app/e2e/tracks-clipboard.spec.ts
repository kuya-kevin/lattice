// Track rename (double-click) and delete (× button, undoable), and Cmd/Ctrl-C / -V to copy a
// clip and paste it at the playhead on the selected track (web build, mock bridge).
import { expect, test, type Page } from '@playwright/test';

test.use({ video: 'on' });

const shots = 'screenshots/tracks-clipboard';
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

/** One imported 6 s clip (t1 / c2) plus an empty second track (t3); the playhead is parked at
 *  bars 2 and 3 for the pastes. */
async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: sineWav(6) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await expect(page.getByTestId('track-t3')).toBeVisible();
}

/** Click inside a track lane at a timeline time (samplesPerPixel 1024). */
async function clickLane(page: Page, trackId: string, seconds: number) {
  const box = (await page.locator(`[data-track-row][data-track-id="${trackId}"]`).boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  await page.mouse.click(box.x + (seconds * sr) / 1024, box.y + box.height / 2);
}

test('double-click renames a track; Esc cancels, Enter commits', async ({ page }) => {
  await load(page);
  const name = page.getByTestId('track-t1').locator('.track-name');
  await name.dblclick();
  const field = page.getByTestId('track-t1').getByLabel('Track name');
  await expect(field).toBeFocused();
  await field.fill('Never mind');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  expect((await session(page)).tracks[0].name).toBe('loop');

  await name.dblclick();
  await field.fill('Lead synth');
  await page.keyboard.press('k'); // typing in the field must not toggle the click
  await page.keyboard.press('Backspace'); // nor delete anything
  await page.screenshot({ path: `${shots}/rename-editing.png` });
  await field.press('Enter');
  await expect(page.getByTestId('track-t1').locator('.track-name')).toHaveText('Lead synth');
  const s = await session(page);
  expect(s.tracks[0].name).toBe('Lead synth');
  expect(s.metronome.on).toBe(false);
  expect(s.tracks[0].clips).toHaveLength(1);
  await page.screenshot({ path: `${shots}/rename-done.png` });

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('track-t1').locator('.track-name')).toHaveText('loop');
});

test('× deletes a track (and its selection); undo brings it back', async ({ page }) => {
  await load(page);
  await clickLane(page, 't1', 0.5); // select clip c2 on t1
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');
  await page.screenshot({ path: `${shots}/delete-before.png` });

  await page.getByTestId('track-t1').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('track-t1')).toHaveCount(0);
  let s = await session(page);
  expect(s.tracks.map((t) => t.id)).toEqual(['t3']);
  expect(s.selection).toEqual({ trackId: null, clipId: null });
  await expect(page.locator('[data-track-row]')).toHaveCount(1); // the lane goes too, with its clip
  await expect(page.locator('[data-clip-container]')).toHaveCount(0);
  await page.screenshot({ path: `${shots}/delete-after.png` });

  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('track-t1')).toBeVisible();
  s = await session(page);
  expect(s.tracks.map((t) => t.id)).toEqual(['t1', 't3']);
  expect(s.tracks[0].clips[0]).toMatchObject({ id: 'c2', start: 0 });
  await expect(page.locator('[data-track-row][data-track-id="t1"] [data-clip-container]')).toHaveCount(1);
  await page.screenshot({ path: `${shots}/delete-undone.png` });
});

test('Cmd-C / Cmd-V pastes the clip at the playhead on the selected track, again and again', async ({ page }) => {
  await load(page);
  await clickLane(page, 't1', 0.5);
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');
  await page.keyboard.press('ControlOrMeta+c');

  await page.keyboard.press('Enter'); // the lane click moved the playhead: back to the start
  await page.keyboard.press('.'); // then bar 2 (2 s at 120 BPM)
  await expect(page.getByTestId('lcd-bars')).toHaveText(/^2 /);
  await page.getByTestId('track-t3').locator('.track-num').click(); // select the empty track
  await expect.poll(async () => (await session(page)).selection.trackId).toBe('t3');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await session(page)).tracks[1].clips.length).toBe(1);
  let s = await session(page);
  const orig = s.tracks[0].clips[0];
  const first = s.tracks[1].clips[0];
  expect(first).toMatchObject({ start: 2, sourceId: orig.sourceId, offset: orig.offset, duration: orig.duration });
  expect(first.id).not.toBe(orig.id);
  expect(s.selection).toEqual({ trackId: 't3', clipId: first.id });

  await page.keyboard.press('.'); // bar 3, paste again
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await session(page)).tracks[1].clips.length).toBe(2);
  s = await session(page);
  expect(s.tracks[1].clips.map((c) => c.start)).toEqual([2, 4]);
  expect(s.tracks[1].clips[1].sourceId).toBe(orig.sourceId);
  expect(s.selection.clipId).toBe(s.tracks[1].clips[1].id);
  expect(s.tracks[0].clips).toHaveLength(1); // the original stays put
  await expect(page.locator('[data-track-row][data-track-id="t3"] [data-clip-container]')).toHaveCount(2); // drawn with its audio
  await page.screenshot({ path: `${shots}/paste-twice.png` });

  await page.keyboard.press('ControlOrMeta+z'); // one paste at a time
  await expect.poll(async () => (await session(page)).tracks[1].clips.map((c) => c.start)).toEqual([2]);
});

test.describe('chat box', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Cmd-V in the chat box pastes text, not a clip', async ({ page }) => {
    await load(page);
    await clickLane(page, 't1', 0.5);
    await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');
    await page.keyboard.press('ControlOrMeta+c'); // a clip is on the clip clipboard

    const chat = page.getByPlaceholder(/trim the vocal/);
    await chat.focus();
    await page.evaluate(() => navigator.clipboard.writeText('make it louder'));
    await page.keyboard.press('ControlOrMeta+v');
    await expect(chat).toHaveValue('make it louder');
    await page.waitForTimeout(300);
    const s = await session(page);
    expect(s.tracks.flatMap((t) => t.clips)).toHaveLength(1);
    await page.screenshot({ path: `${shots}/chat-paste.png` });
  });
});
