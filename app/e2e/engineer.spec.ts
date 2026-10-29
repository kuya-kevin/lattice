// B3: cleanup_noise and quantize_drums in the web build. The dev middleware runs the engineer
// sidecar in mock mode (LATTICE_ENGINEER_MOCK=1: the audio comes back unchanged), so this checks
// the plumbing: the track switches to a processed source, the page loads that audio, and undo
// brings the original back.
import { expect, test, type Page } from '@playwright/test';

function noiseWav(seconds = 2, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000 + (Math.random() - 0.5) * 800), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const audioIds = (page: Page) => page.evaluate(() => (window as unknown as { latticeDebug: { audioIds(): string[] } }).latticeDebug.audioIds());
const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);

test('cleanup and quantize replace the track audio with a processed take; undo restores it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vocal.wav', mimeType: 'audio/wav', buffer: noiseWav() });
  await expect(page.getByTestId('track-t1')).toContainText('vocal');
  const original = (await session(page)).tracks[0].clips[0].sourceId;
  await expect.poll(() => audioIds(page)).toContain(original);

  const r = await tool(page, 'cleanup_noise', { track_id: 't1' });
  expect(r).toMatchObject({ ok: true, result: { method: expect.stringMatching(/mock/) } });
  expect(r.result).not.toHaveProperty('stub');
  const cleaned = (r.result as { new_source_id: string }).new_source_id;
  let s = await session(page);
  expect(s.tracks[0].clips[0]).toMatchObject({ sourceId: cleaned, start: 0, duration: 2 });
  expect(s.sources[cleaned]).toMatchObject({ origin: 'processed', derivedFrom: original });
  await expect.poll(() => audioIds(page)).toContain(cleaned); // the page loaded the processed audio

  const q = await tool(page, 'quantize_drums', { track_id: 't1', grid: '1/16', strength: 1 });
  expect(q).toMatchObject({ ok: true, result: { source_id: cleaned, hits: 16 } });
  const quantized = (q.result as { new_source_id: string }).new_source_id;
  s = await session(page);
  expect(s.sources[quantized].processed).toMatch(/noise cleaned .*; drums quantized to 1\/16/);
  await expect.poll(() => audioIds(page)).toContain(quantized);

  await tool(page, 'undo', {});
  await tool(page, 'undo', {});
  expect((await session(page)).tracks[0].clips[0].sourceId).toBe(original);
  expect(errors).toEqual([]);
});
