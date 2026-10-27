// The transport rolls past the last region (DAW-style), so short one-shots play out in full,
// and Space plays/stops even while a button, slider or menu has keyboard focus.
// Videos of each run land in test-results/ (video: 'on').
import { expect, test, type Page } from '@playwright/test';

test.use({ video: 'on', viewport: { width: 1400, height: 860 } });

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

async function load(page: Page, seconds: number) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'hit.wav', mimeType: 'audio/wav', buffer: sineWav(seconds) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
}

test('playback keeps rolling past the last region', async ({ page }) => {
  await load(page, 1);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500); // well past the 1 s clip
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  expect((await session(page)).transport.playing).toBe(true);
  await page.screenshot({ path: 'screenshots/playback-fix/playback-past-end.png' });
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  expect((await session(page)).transport.position).toBeGreaterThan(2); // stops where it is
});

test('a 0.1 s one-shot does not stop the transport', async ({ page }) => {
  await load(page, 0.1);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByTestId('lcd-time')).not.toHaveText(/^0:00\.[0-4]/);
  await page.keyboard.press('Space');
});

test('Space plays/stops while a button, slider or the Add device menu has focus', async ({ page }) => {
  await load(page, 2);
  const mute = page.getByTestId('track-t1').getByRole('button', { name: 'M' });
  const addDevice = page.getByTestId('fx-add');
  const gain = page.getByTestId('track-t1').getByRole('slider');
  for (const el of [mute, gain, addDevice]) {
    await el.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  }
  const s = await session(page);
  expect(s.tracks[0].muted).toBe(false); // Space did not press M
  expect(s.tracks[0].devices).toEqual([]); // nor pick a device
  await page.screenshot({ path: 'screenshots/playback-fix/space-with-focus.png' });

  // typing in the chat still types
  const chat = page.getByPlaceholder(/trim the vocal/);
  await chat.click();
  await page.keyboard.type('a b ');
  await expect(chat).toHaveValue('a b ');
  expect((await session(page)).transport.playing).toBe(false);
});
