// B17/B18 in the built Electron app (run `npm run build` first): a star and an export survive a
// relaunch (shelves in userData, across projects), a shelf sound loads back into a new session,
// and stems are written one WAV per track per set. Sends no chat, so no Meta calls.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electronApp, expect, test, type Page } from '@playwright/test';

test.skip(!existsSync('dist-electron/main.cjs') || !existsSync('dist/index.html'), 'run `npm run build` first');

const freshDir = (what: string) => mkdtempSync(join(tmpdir(), `lattice-${what}-`));
const launch = (userData: string, env: Record<string, string> = {}) =>
  electronApp.launch({
    args: ['.'],
    env: { ...process.env, LATTICE_USER_DATA: userData, LATTICE_DATA_DIR: resolve('tests/fixtures/library'), ...env } as Record<string, string>,
  });

function toneWav(seconds: number, hz: number, sr = 44100): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const shelf = (page: Page) => page.evaluate(() => window.lattice!.listShelf());

test('electron: a star and an export survive a relaunch; a shelf sound loads into a fresh project (B17)', async () => {
  const userData = freshDir('userdata');
  let app = await launch(userData);
  let page = await app.firstWindow();
  await page.getByTestId('file-input').setInputFiles({ name: 'keys.wav', mimeType: 'audio/wav', buffer: toneWav(1, 330) });
  await expect(page.getByTestId('track-t1')).toContainText('keys');
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: 't1' })).ok).toBe(true); // audio loaded

  // star from the library (UI) and from Ideas (tool, as Muse would)
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByLabel('Search sounds').fill('Fixture Lead');
  await page.getByTestId('lib-item-fs:101').getByRole('button', { name: 'Star Fixture Lead A' }).click();
  expect((await tool(page, 'star_sound', { source_id: (await session(page)).tracks[0].clips[0].sourceId })).ok).toBe(true);
  // export through a delay from the device panel
  await tool(page, 'insert_device', { track_id: 't1', device: 'delay', params: { time_ms: 300 } });
  await page.getByTestId('fx-export-sound').click();
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name]).sort()).toEqual([['mine', 'keys'], ['starred', 'Fixture Lead A'], ['starred', 'keys']]);
  const exported = (await shelf(page)).find((i) => i.shelf === 'mine')!;
  expect(exported.duration).toBeGreaterThan(1.25); // the delay's repeats ring past the 1 s region
  expect(existsSync(join(userData, 'shelf', `${exported.id}.wav`))).toBe(true);
  expect(existsSync(join(userData, 'shelf', `${exported.id}.source.wav`))).toBe(true);
  await app.close();

  // a new project (the session is cleared) on the same machine: the shelves are still there
  app = await launch(userData);
  page = await app.firstWindow();
  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name]).sort()).toEqual([['mine', 'keys'], ['starred', 'Fixture Lead A'], ['starred', 'keys']]);
  await tool(page, 'delete_track', { track_id: 't1' });
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('tab', { name: 'My Sounds' }).click();
  await expect(page.getByTestId(`shelf-item-${exported.id}`)).toBeVisible();
  await page.getByRole('button', { name: 'Reopen keys' }).click();
  await expect.poll(async () => (await session(page)).tracks.at(-1)?.devices.map((d) => d.kind)).toEqual(['delay']);
  const reopened = (await session(page)).tracks.at(-1)!;
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: reopened.id })).ok).toBe(true); // its audio loaded from the shelf
  const starred = (await shelf(page)).find((i) => i.name === 'Fixture Lead A')!;
  const used = await tool(page, 'use_shelf_sound', { shelf_id: starred.id, place: true });
  expect(used.ok).toBe(true);
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: (used.result as { track_id: string }).track_id })).ok).toBe(true);
  await expect(page.locator('.error')).toHaveCount(0);
  await app.close();
});

test('electron: stems are written one WAV per track per set (B18)', async () => {
  const out = freshDir('stems');
  const app = await launch(freshDir('userdata'), { LATTICE_EXPORT_DIR: out });
  const page = await app.firstWindow();
  await page.getByTestId('file-input').setInputFiles([
    { name: 'Vox.wav', mimeType: 'audio/wav', buffer: toneWav(1, 300) },
    { name: 'Pad.wav', mimeType: 'audio/wav', buffer: toneWav(0.5, 200) },
  ]);
  await expect.poll(async () => (await session(page)).tracks.length).toBe(2);
  for (const t of (await session(page)).tracks) await expect.poll(async () => (await tool(page, 'measure_track', { track_id: t.id })).ok).toBe(true);
  await tool(page, 'insert_device', { track_id: 't1', device: 'reverb', params: { mix: 40 } });
  await page.getByTestId('export-stems').click();
  const root = join(out, 'Lattice stems');
  await expect.poll(() => (existsSync(join(root, 'wet')) ? readdirSync(join(root, 'wet')).length : 0)).toBe(2);
  expect(readdirSync(join(root, 'dry')).sort()).toEqual(['01 Vox.wav', '02 Pad.wav']);
  expect(readdirSync(join(root, 'wet')).sort()).toEqual(['01 Vox.wav', '02 Pad.wav']);
  const dryLen = readFileSync(join(root, 'dry', '02 Pad.wav')).readUInt32LE(40);
  expect(readFileSync(join(root, 'dry', '01 Vox.wav')).readUInt32LE(40)).toBe(dryLen); // a set lines up
  expect(readFileSync(join(root, 'wet', '01 Vox.wav')).readUInt32LE(40)).toBeGreaterThan(dryLen); // reverb tail
  await app.close();
});
