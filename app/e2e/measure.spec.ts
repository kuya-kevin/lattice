// B9: measure_track in the web build renders the track in the page with the real effect chain
// (OfflineAudioContext) and measures it. A high cut must read as darker with less air; a
// compressor pushed hard must read as more compressed.
import { expect, test, type Page } from '@playwright/test';

function noiseWav(seconds = 3, sr = 44100): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    const env = (i % sr) < sr / 2 ? 1 : 0.15; // loud and quiet halves, so a compressor has work to do
    b.writeInt16LE(Math.round(((seed / 2147483647) * 2 - 1) * 9000 * env), 44 + i * 2);
  }
  return b;
}

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
type Measured = { what_the_fx_do: string[]; as_heard: { brightness_hz: number; crest_db: number }; without_fx: { brightness_hz: number; crest_db: number } };

test('measure_track reads what the chain does to the audio', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'noise.wav', mimeType: 'audio/wav', buffer: noiseWav() });
  await expect(page.getByTestId('track-t1')).toContainText('noise');
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: 't1' })).ok).toBe(true); // audio loaded
  expect((await tool(page, 'measure_track', { track_id: 't1' })).result).toMatchObject({ what_the_fx_do: ['no effects on this track'] });

  await tool(page, 'insert_device', { track_id: 't1', device: 'eq', params: { lp_on: true, lp_freq: 4000, hs_gain: -9 } });
  const dark = (await tool(page, 'measure_track', { track_id: 't1' })).result as Measured;
  expect(dark.as_heard.brightness_hz).toBeLessThan(dark.without_fx.brightness_hz * 0.6);
  expect(dark.what_the_fx_do.join('\n')).toMatch(/brightness -\d+%/);
  expect(dark.what_the_fx_do.join('\n')).toMatch(/air band -\d+/);

  await tool(page, 'remove_device', { track_id: 't1', device_id: 'eq' });
  await tool(page, 'insert_device', { track_id: 't1', device: 'comp', params: { thresh: -40, ratio: 10, attack: 1, release: 50 } });
  const squashed = (await tool(page, 'measure_track', { track_id: 't1' })).result as Measured;
  expect(squashed.what_the_fx_do.join('\n')).toMatch(/loud-quiet spread -\d+/);
  expect(squashed.what_the_fx_do.join('\n')).toMatch(/closer together/);
  expect(dark.what_the_fx_do.join('\n')).not.toMatch(/(sub|low|low-mid|mid) band \+/); // untouched bands don't read as boosted
  expect(errors).toEqual([]);
});
