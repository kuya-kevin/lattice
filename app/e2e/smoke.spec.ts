// Smoke test of the web build (mock bridge, no Muse): import a WAV, see the track,
// change its gain, play/stop, and run one chat turn through the offline stand-in.
import { expect, test } from '@playwright/test';
import { shot } from './evidence';

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

test('import, mix, play and chat in the web build', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('empty')).toBeVisible();

  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: sineWav() });
  const track = page.getByTestId('track-t1');
  await expect(track).toContainText('hum');

  await track.getByRole('button', { name: 'M' }).click();
  await expect(track.getByRole('button', { name: 'M' })).toHaveClass(/on/);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();

  await page.getByPlaceholder(/trim the vocal/).fill('what do I have?');
  await page.getByRole('button', { name: 'Send' }).click();
  const list = page.getByTestId('chat-list');
  await expect(list).toContainText('list_tracks');
  await expect(list).toContainText('t1 "hum" gain 0 dB (muted): c2 "hum" 0-2s');
  await shot(page, 'test-results/smoke.png');
  expect(errors).toEqual([]);
});

