// A tempo change keeps things on their bars (Logic, GarageBand): MIDI regions and notes (unit
// tests cover the session), the cycle area and the playhead, stopped or playing.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds: number, sr = 22050): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const tool = (page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n, a), [name, args] as const);
const lcdSeconds = (page: Page) =>
  page.getByTestId('lcd').innerText().then((t) => {
    const m = t.match(/(\d+):(\d\d\.\d\d)/)!;
    return Number(m[1]) * 60 + Number(m[2]);
  });

async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'pad.wav', mimeType: 'audio/wav', buffer: sineWav(12) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
}

async function setTempo(page: Page, bpm: number) {
  await tool(page, 'set_tempo', { bpm });
  await expect(page.getByLabel('Tempo')).toHaveValue(String(bpm));
}

test('a stopped playhead stays on its bar', async ({ page }) => {
  await load(page);
  await tool(page, 'go_to', { position: 4 }); // bar 3 at 120 BPM
  await expect(page.getByTestId('lcd-bars')).toHaveText('3 1 1');
  await setTempo(page, 60);
  await expect(page.getByTestId('lcd-bars')).toHaveText('3 1 1');
  expect(await lcdSeconds(page)).toBeCloseTo(8, 1);
});

test('a playing playhead stays on its bar', async ({ page }) => {
  await load(page);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000); // about bar 1 beat 3 (1 s at 120 BPM)
  const before = await lcdSeconds(page);
  await setTempo(page, 60);
  await page.waitForTimeout(400);
  // the same beat at 60 BPM is twice as far in: ~2 s plus the time since (unscaled it'd be ~1.4 s)
  expect(await lcdSeconds(page)).toBeGreaterThan(before * 2);
  await page.keyboard.press('Space');
});

test('the cycle area stays on bars 1-4', async ({ page }) => {
  await load(page);
  await page.keyboard.press('c'); // bars 1-4: 0-8 s at 120 BPM
  await setTempo(page, 240); // bars 1-4: 0-4 s
  await tool(page, 'go_to', { position: 3 });
  await expect(page.getByTestId('lcd-bars')).toHaveText('4 1 1');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1600);
  expect(await lcdSeconds(page)).toBeLessThan(2); // wrapped at 4 s (a 0-8 s cycle would read ~4.6)
  await page.keyboard.press('Space');
});
