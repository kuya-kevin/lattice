// Two trims back to back: the second must start a drag even while the playlist is still
// re-rendering the region the first one trimmed (Oct 28 glitch: it needed ~1 s; as of Oct 29 50 ms
// is enough, in web and Electron, likely since the provider patch for playback across edits).
import { expect, test } from '@playwright/test';

function sineWav(seconds = 4, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

test('a second trim right after the first still drags', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toContainText('vox');
  const clip = async () => (await page.evaluate(() => window.lattice!.getSession())).tracks[0].clips[0];
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  const px = (s: number) => (s * sr) / 1024;
  const drag = async (edge: 'left' | 'right', dx: number) => {
    const b = (await page.locator(`[data-boundary-edge="${edge}"]`).boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + Math.sign(dx) * 10, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
  };
  await drag('right', -px(1.5));
  // faster than a hand can let go and grab the other edge; a press within a few ms of the release is
  // dropped (dnd-kit), from 30 ms on it starts every time (Oct 29: 0 ms 0/20, 30-1200 ms 30/30)
  await page.waitForTimeout(50);
  await drag('left', px(1));
  await expect.poll(clip, { timeout: 3000 }).toMatchObject({ start: 1, offset: 1, duration: 1.5 });
});
