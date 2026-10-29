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

test('a cleaned sound stacks on its card: the Versions list plays the original and switches back to it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vocal.wav', mimeType: 'audio/wav', buffer: noiseWav() });
  await expect(page.getByTestId('track-t1')).toContainText('vocal');
  const original = (await session(page)).tracks[0].clips[0].sourceId;
  const cleaned = ((await tool(page, 'cleanup_noise', { track_id: 't1' })).result as { new_source_id: string }).new_source_id;
  await expect.poll(() => audioIds(page)).toContain(cleaned);

  const card = page.locator(`[data-idea="${original}"]`);
  await expect(page.locator('[data-idea]')).toHaveCount(1); // one card for both versions
  await expect(card).toHaveAttribute('data-version', cleaned); // showing the one in use
  await card.getByRole('button', { name: /2 versions/ }).click();
  const orig = page.getByTestId(`version-${original}`);
  await expect(orig).toContainText('Original');
  await expect(page.getByTestId(`version-${cleaned}`)).toContainText('in use');

  await orig.getByRole('button', { name: 'Play Original' }).click();
  await expect(orig.getByRole('button', { name: 'Play Original' })).toHaveText('■');
  await orig.getByRole('button', { name: 'Use' }).click();
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].sourceId).toBe(original);
  await expect(card).toHaveAttribute('data-version', original);
  await expect(orig).toContainText('in use');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await session(page)).tracks[0].clips[0].sourceId).toBe(cleaned);
});

test('slice_drums (B13) puts each drum on its own lane under the loop; undo brings the clip back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'beat.wav', mimeType: 'audio/wav', buffer: noiseWav() });
  await expect(page.getByTestId('track-t1')).toContainText('beat');
  const source = (await session(page)).tracks[0].clips[0].sourceId;
  await expect.poll(() => audioIds(page)).toContain(source);

  // mock hits (LATTICE_ENGINEER_MOCK): kick, hat, snare, hat every 0.25 s
  const r = await tool(page, 'slice_drums', { clip_id: 'c2' });
  expect(r).toMatchObject({ ok: true, result: { tracks: [{ drum: 'kick', slices: 2 }, { drum: 'snare', slices: 2 }, { drum: 'hat', slices: 4 }] } });
  const s = await session(page);
  expect(s.tracks.map((t) => t.name)).toEqual(['beat', 'beat Kick', 'beat Snare', 'beat Hat']);
  expect(s.tracks[0].clips).toEqual([]);
  const clips = s.tracks.flatMap((t) => t.clips).sort((a, b) => a.start - b.start);
  expect(clips.map((c) => [c.start, c.offset, c.duration])).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((t) => [t, t, 0.25]));
  for (const t of s.tracks.slice(1)) await expect(page.getByTestId(`track-${t.id}`)).toBeVisible();

  await tool(page, 'undo', {});
  expect((await session(page)).tracks.map((t) => t.clips.length)).toEqual([1]);
  expect(errors).toEqual([]);
});

test('find_sound (B13) reports the dead space; trim_clip with its suggestion clears it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'beat.wav', mimeType: 'audio/wav', buffer: noiseWav() });
  await expect(page.getByTestId('track-t1')).toContainText('beat');
  await expect.poll(async () => audioIds(page)).toContain((await session(page)).tracks[0].clips[0].sourceId);

  // mock regions (LATTICE_ENGINEER_MOCK): sound from 0.25 to 1.75 s of the 2 s clip
  const r = await tool(page, 'find_sound', { clip_id: 'c2' });
  expect(r).toMatchObject({ ok: true, result: { sound_starts_at: 0.25, sound_ends_at: 1.75, dead_space_s: { before: 0.25, after: 0.25 }, suggested_trim: { start: 0.24, end: 1.8 } } });
  await tool(page, 'trim_clip', { clip_id: 'c2', ...(r.result as { suggested_trim: object }).suggested_trim });
  expect((await session(page)).tracks[0].clips[0]).toMatchObject({ start: 0.24, offset: 0.24, duration: 1.56 });
});
