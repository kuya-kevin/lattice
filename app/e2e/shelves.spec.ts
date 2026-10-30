// B17 sound shelves in the web build: star from the library and from Ideas, export a region
// through its effects (right-click menu) and from the device panel, bring a shelf sound back,
// reopen an export with its chain. Asserts on state (shelf list, session), not pixels.
import { expect, test, type Page } from '@playwright/test';

function toneWav(seconds = 1, sr = 48000, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 9000), 44 + i * 2);
  return b;
}

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const shelf = (page: Page) => page.evaluate(() => window.lattice!.listShelf());
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

async function importTone(page: Page, name = 'tone.wav', seconds = 1) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'audio/wav', buffer: toneWav(seconds) });
  await expect.poll(async () => (await session(page)).tracks.length).toBeGreaterThan(0);
}

test('star a library sound; it shows on the Starred shelf and comes back into Ideas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByLabel('Search sounds').fill('Fixture Lead');
  const row = page.getByTestId('lib-item-fs:101');
  await row.getByRole('button', { name: 'Star Fixture Lead A' }).click();
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name, i.library])).toEqual([['starred', 'Fixture Lead A', 'fs:101']]);
  await expect(row.getByRole('button', { name: 'Unstar Fixture Lead A' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: '★ Starred' }).click();
  const item = page.getByTestId('shelf-starred').getByText('Fixture Lead A');
  await expect(item).toBeVisible();
  await page.getByTestId('shelf-starred').getByRole('button', { name: 'Add Fixture Lead A to Ideas' }).click();
  await expect.poll(async () => Object.values((await session(page)).sources).map((s) => [s.name, s.origin])).toEqual([['Fixture Lead A', 'freesound']]);
  // its audio loads like a restored source (B11 path), so it can play
  await expect(page.locator('.idea').filter({ hasText: 'Fixture Lead A' }).locator('.idea-wave')).toBeVisible();

  // unstar from the shelf
  await page.getByTestId('shelf-starred').getByRole('button', { name: 'Remove Fixture Lead A from Starred' }).click();
  await expect.poll(async () => (await shelf(page)).length).toBe(0);
  expect(errors).toEqual([]);
});

test('star an Ideas sound; export a region through its reverb from the right-click menu; reopen it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await importTone(page, 'hum.wav', 1);
  await expect(page.getByTestId('track-t1')).toContainText('hum');
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: 't1' })).ok).toBe(true); // audio loaded

  // star from the Ideas card
  const card = page.locator('.idea').filter({ hasText: 'hum' });
  await card.hover();
  await card.getByRole('button', { name: 'Star hum' }).click();
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name, i.from])).toEqual([['starred', 'hum', 'idea']]);

  // a long reverb: the export keeps its tail
  await tool(page, 'insert_device', { track_id: 't1', device: 'reverb', params: { decay: 3, mix: 50 } });
  const before = await session(page);
  await page.locator('[data-clip-container]').filter({ has: page.locator('[data-clip-id="c2"]') }).click({ button: 'right', force: true }); // on the waveform (a lane overlay takes the click, as for a user)
  await page.getByTestId('sound-menu').getByRole('menuitem', { name: /Export Region as Sound/ }).click();
  await expect.poll(async () => (await shelf(page)).filter((i) => i.shelf === 'mine').length).toBe(1);
  const exported = (await shelf(page)).find((i) => i.shelf === 'mine')!;
  expect(exported).toMatchObject({ name: 'hum', from: 'export', recipe: { trackName: 'hum', devices: [{ kind: 'reverb', on: true }] } });
  expect(exported.duration).toBeGreaterThan(1.3); // 1 s of audio plus the reverb tail
  expect(exported.duration).toBeLessThan(9); // trailing silence trimmed (8 s rendered)
  expect((await session(page)).tracks).toEqual(before.tracks); // exporting changes nothing

  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('tab', { name: 'My Sounds' }).click();
  await expect(page.getByTestId(`shelf-item-${exported.id}`)).toContainText('hum');
  await page.getByRole('button', { name: 'Reopen hum' }).click();
  await expect.poll(async () => (await session(page)).tracks.length).toBe(2);
  const s = await session(page);
  expect(s.tracks[1]).toMatchObject({ name: 'hum', devices: [{ kind: 'reverb', params: { decay: 3, mix: 50 } }] });
  const src = s.sources[s.tracks[1].clips[0].sourceId];
  expect(src.name).toBe('hum (source)');
  expect(src.duration).toBeCloseTo(1, 1);
  // the reopened source's audio loads, so it can be measured (rendered)
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: s.tracks[1].id })).ok).toBe(true);
  expect(errors).toEqual([]);
});

test('Export Sound in the device panel puts the track in My Sounds', async ({ page }) => {
  await page.goto('/');
  await importTone(page, 'pluck.wav', 0.5);
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: 't1' })).ok).toBe(true);
  await page.getByTestId('fx-export-sound').click();
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name])).toEqual([['mine', 'pluck']]);
});
