// [S3 midi] Piano Roll: double-click a MIDI region to open it under the board (Logic's editor
// area, BandLab's MIDI Editor), then edit notes with the mouse. Every edit is one tool call
// (edit_midi_notes / transpose_midi / quantize_midi), so it is undoable and Muse sees it.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 2, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(async () => window.lattice!.getSession());
const melody = async (page: Page) => (await session(page)).tracks[1].clips[0].midi!.notes;

/** Double-click the middle of a track's region (locator.dblclick waits forever on these: the
 *  drag library keeps them from counting as stable). */
async function openRegion(page: Page, trackId: string) {
  const b = (await page.locator(`[data-track-row][data-track-id="${trackId}"] [data-clip-container]`).boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
}

async function extract(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toContainText('hum');
  await page.locator('[data-track-row][data-track-id="t1"] [data-clip-container] > :first-child').click();
  await page.getByRole('button', { name: 'Extract MIDI' }).click();
  await expect(page.getByTestId('extract-midi-result')).toContainText('melody 4');
}

test('double-click a MIDI region opens the Piano Roll; drag, add, delete, transpose, undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await extract(page);
  const s = await session(page);
  const mel = s.tracks[1];

  await openRegion(page, mel.id);
  const roll = page.getByTestId('piano-roll');
  await expect(roll).toBeVisible();
  await expect(roll).toContainText('hum melody');
  const notes = roll.getByTestId('pr-note');
  await expect(notes).toHaveCount(4);
  // the region on the track draws the same notes (not the rendered audio's waveform)
  const regionNotes = page.locator(`[data-track-row][data-track-id="${mel.id}"] [data-clip-container][data-lt-midi] svg.lt-notes rect`);
  await expect(regionNotes).toHaveCount(4);
  expect((await session(page)).selection.clipId).toBe(mel.clips[0].id);

  // drag the second note (C4 at 0.5 s) up two rows: one edit, pitch +2, time unchanged
  const n1 = notes.nth(1);
  await n1.scrollIntoViewIfNeeded();
  const box = (await n1.boundingBox())!;
  const row = Number(await roll.getByTestId('pr-grid').getAttribute('data-row'));
  const mid = box.x + box.width / 2; // the edges trim (Oct 30), the body moves
  await page.mouse.move(mid, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(mid, box.y + box.height / 2 - row * 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await melody(page))[1]).toMatchObject({ pitch: 62, start: 0.5 });

  // the moved note stays selected: Delete removes it, not the region
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await melody(page)).map((n) => n.pitch)).toEqual([57, 64, 60]);
  expect((await session(page)).tracks[1].clips).toHaveLength(1);
  await expect(regionNotes).toHaveCount(3);

  // double-click empty grid adds a note one grid step long
  const grid = roll.getByTestId('pr-grid');
  const g = (await grid.boundingBox())!;
  await grid.dblclick({ position: { x: 6, y: 6 } });
  await expect.poll(async () => (await melody(page)).length).toBe(4);
  expect(g.width).toBeGreaterThan(100);

  // with nothing selected (Escape) transpose moves every note; then undo twice back past the add
  await page.keyboard.press('Escape');
  await roll.getByRole('button', { name: 'Transpose +12' }).click();
  await expect.poll(async () => (await melody(page)).map((n) => n.pitch).slice(0, 1)).toEqual([69]);
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await melody(page)).map((n) => n.pitch)).toEqual([57, 64, 60]);

  // the device chain is still one tab away, and × closes the editor area
  await page.getByRole('tab', { name: 'Device chain' }).click();
  await expect(page.getByTestId('device-panel-slot')).toBeVisible();
  await page.getByRole('button', { name: 'Hide Smart Controls' }).click();
  await expect(page.getByTestId('smart-controls')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/piano-roll.png' });
  expect(errors).toEqual([]);
});

test('double-click an audio region opens the Audio Editor (with Extract MIDI) instead', async ({ page }) => {
  await extract(page);
  await openRegion(page, 't1');
  await expect(page.getByTestId('piano-roll')).toHaveCount(0);
  const ed = page.getByTestId('audio-editor');
  await expect(ed).toBeVisible();
  await expect(page.locator('[data-track-row][data-track-id="t1"] [data-clip-container][data-lt-midi]')).toHaveCount(0);
  await expect(ed.getByRole('button', { name: 'Extract MIDI' })).toBeVisible();
  // a MIDI region switches the same tab back to the Piano Roll
  await openRegion(page, (await session(page)).tracks[1].id);
  await expect(page.getByRole('tab', { name: 'Piano Roll' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('piano-roll')).toBeVisible();
});
