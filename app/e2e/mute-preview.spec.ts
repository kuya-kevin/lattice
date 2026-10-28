// Mute/solo/volume reach the audio engine (not just the session), and closing the library
// stops a playing preview.
import { expect, test, type Page } from '@playwright/test';

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
type Mix = { id: string; muted: boolean; soloed: boolean; volume: number }[];
const engineMix = (page: Page) => page.evaluate(() => (window as unknown as { __engineMix: () => Mix }).__engineMix());

function sineWav(seconds: number, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

test('mute, solo and gain change what the engine plays', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'kick.wav', mimeType: 'audio/wav', buffer: sineWav(1) },
    { name: 'bass.wav', mimeType: 'audio/wav', buffer: sineWav(2, 22050, 110) },
  ]);
  await expect.poll(async () => (await engineMix(page)).length).toBe(2);
  const [t1, t2] = (await session(page)).tracks;
  const header = (id: string) => page.getByTestId(`track-${id}`);

  await header(t1.id).getByTitle('Mute').click();
  await expect.poll(async () => (await session(page)).tracks[0].muted).toBe(true);
  await expect.poll(async () => (await engineMix(page))[0].muted).toBe(true);

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await engineMix(page))[0].muted).toBe(false);

  await header(t2.id).getByTitle('Solo').click();
  await expect.poll(async () => (await engineMix(page))[1].soloed).toBe(true);

  await page.evaluate((id) => window.lattice!.runTool('set_gain', { track_id: id, gain_db: -6 }), t1.id);
  await expect.poll(async () => (await engineMix(page))[0].volume).toBeCloseTo(0.501, 2);
});

test('closing the library stops the preview', async ({ page }) => {
  // record every buffer source started, and whether something stopped it
  await page.addInitScript(() => {
    const log: { stopped: boolean }[] = [];
    (window as unknown as { __started: typeof log }).__started = log;
    const P = AudioBufferSourceNode.prototype;
    const start = P.start;
    const stop = P.stop;
    P.start = function (this: AudioBufferSourceNode & { __rec?: { stopped: boolean } }, ...a: Parameters<typeof start>) {
      this.__rec = { stopped: false };
      log.push(this.__rec);
      return start.apply(this, a);
    };
    P.stop = function (this: AudioBufferSourceNode & { __rec?: { stopped: boolean } }, ...a: Parameters<typeof stop>) {
      if (this.__rec) this.__rec.stopped = true;
      return stop.apply(this, a);
    };
  });
  const started = () => page.evaluate(() => (window as unknown as { __started: { stopped: boolean }[] }).__started);

  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('o');
  await page.getByTestId('library').getByPlaceholder('Search sounds').fill('sub bass');
  const item = page.getByTestId('lib-item-fs:102'); // 1 s fixture
  await item.click();
  await expect(item).toHaveClass(/playing/);
  await expect.poll(async () => (await started()).length).toBeGreaterThan(0);

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('o'); // close (the panel only hides)
  await expect(page.getByTestId('library')).toBeHidden();
  const nodes = await started();
  expect(nodes[nodes.length - 1].stopped).toBe(true);

  await page.keyboard.press('o');
  await expect(item).not.toHaveClass(/playing/);
});
