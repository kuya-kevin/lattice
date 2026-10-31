// 1/16 snap for clip moves, and hiding / showing the Muse prompt bar.
import { expect, test, type Page } from '@playwright/test';
import { shot, evidenceVideo } from './evidence';

test.use({ video: evidenceVideo, viewport: { width: 1400, height: 860 } });

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

/** Drag a region by its header so its left edge lands near `seconds` on the same track. */
async function dragClipTo(page: Page, trackId: string, nth: number, seconds: number) {
  await page.waitForTimeout(300); // let the region re-render where the last move put it
  const header = page.locator(`[data-track-row][data-track-id="${trackId}"] [data-clip-container] > :first-child`).nth(nth);
  const hb = (await header.boundingBox())!;
  const row = (await page.locator(`[data-track-row][data-track-id="${trackId}"]`).boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  const spp = 1024; // 100 % zoom
  const x = row.x + (seconds * sr) / spp;
  await page.mouse.move(hb.x + 4, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 20, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.move(x + 4, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('Snap 1/16 lands clip moves on sixteenth notes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'hat.wav', mimeType: 'audio/wav', buffer: sineWav(0.2) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  const seg = page.getByRole('radiogroup', { name: 'Snap' });
  await expect(seg.getByRole('radio')).toHaveText(['Off', 'Bar', 'Beat', '1/16']);

  // Beat (120 BPM: 0.5 s grid): ~1.17 s -> 1 s
  await dragClipTo(page, 't1', 0, 1.17);
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].start).toBe(1);

  // 1/16 (0.125 s grid): ~1.36 s -> 1.375 s (Beat would say 1.5), ~2.23 s -> 2.25 s
  await seg.getByRole('radio', { name: '1/16' }).click();
  await expect(seg.getByRole('radio', { name: '1/16' })).toHaveAttribute('aria-checked', 'true');
  await dragClipTo(page, 't1', 0, 1.36);
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].start).toBe(1.375);
  await dragClipTo(page, 't1', 0, 2.23);
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].start).toBe(2.25);
  await shot(page, 'screenshots/snap-prompt/snap-sixteenth.png');

  // Cmd/Ctrl-G toggles snap off and back to 1/16
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('Control+g');
  await expect(seg.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Control+g');
  await expect(seg.getByRole('radio', { name: '1/16' })).toHaveAttribute('aria-checked', 'true');
});

test('the Muse prompt bar hides into a pill, stays hidden after reload, and comes back', async ({ page }) => {
  await page.goto('/');
  const prompt = page.getByLabel('Message Muse');
  await expect(prompt).toBeVisible();
  await page.getByRole('button', { name: 'Hide Muse prompt' }).click();
  await expect(prompt).toBeHidden();
  const pill = page.getByRole('button', { name: 'Show Muse prompt' });
  await expect(pill).toBeVisible();
  await shot(page, 'screenshots/snap-prompt/prompt-hidden.png');

  await page.reload();
  await expect(page.getByLabel('Message Muse')).toBeHidden();
  await expect(pill).toBeVisible();

  await pill.click();
  await expect(prompt).toBeVisible();
  await expect(prompt).toBeFocused(); // ready to type
  await expect(pill).toHaveCount(0);
  await shot(page, 'screenshots/snap-prompt/prompt-shown.png');
});
