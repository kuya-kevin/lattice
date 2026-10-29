// B2 push-to-talk (web build, fake mic, $LATTICE_STT_MOCK transcript from playwright.config.ts):
// hold ` or the mic button, speak, release -> the transcript is sent to Muse as a chat turn.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 6, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } }); // focus nothing in particular
}

test('hold ` to talk: playback pauses, the transcript goes to Muse', async ({ page }) => {
  await load(page);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await session(page)).transport.playing).toBe(true);

  await page.keyboard.down('Backquote');
  await expect(page.getByTestId('ptt-status')).toHaveText(/Listening/);
  await expect.poll(async () => (await session(page)).transport.playing).toBe(false); // paused while you talk
  await page.waitForTimeout(800);
  await page.keyboard.up('Backquote');

  const spoken = page.locator('.msg.user.spoken');
  await expect(spoken).toHaveText('list the tracks');
  await expect(page.locator('.msg.muse').last()).toContainText('offline mock'); // Muse ran its turn
  await expect(page.getByTestId('ptt-status')).toBeHidden();
});

test('a tap is ignored; the mic button works too', async ({ page }) => {
  await load(page);
  await page.keyboard.down('Backquote');
  await page.keyboard.up('Backquote');
  await expect(page.getByTestId('ptt-status')).toHaveText(/too short/i);
  await expect(page.locator('.msg.user')).toHaveCount(0);

  const mic = page.getByRole('button', { name: 'Hold to talk to Muse' });
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('ptt-status')).toHaveText(/Listening/);
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.locator('.msg.user.spoken')).toHaveText('list the tracks');
});
