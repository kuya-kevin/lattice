// Oct 30: projects and setups on disk. Two projects, each with its own audio (kept as bytes in
// its folder), and a vocal setup; after a relaunch the last project is open, the other opens from
// the Lattice pill with its audio, and the setup is still there. Run `npm run build` first.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electronApp, expect, test, type Page } from '@playwright/test';

test.skip(!existsSync('dist-electron/main.cjs') || !existsSync('dist/index.html'), 'run `npm run build` first');

function sineWav(hz: number) {
  const n = 22050;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 22050) * 6000), 44 + i * 2);
  return wav;
}

test('electron: two projects with their own audio, and a vocal setup, survive a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'lattice-userdata-'));
  const launch = () => electronApp.launch({ args: ['.'], env: { ...process.env, LATTICE_USER_DATA: userData } as Record<string, string> });
  let app = await launch();
  let page: Page = await app.firstWindow();
  const session = () => page.evaluate(() => window.lattice!.getSession());
  const audioIds = () => page.evaluate(() => ((window as any).latticeDebug?.audioIds() ?? []) as string[]);
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(async ([n, a]) => (await window.lattice!.runTool(n as string, a as Record<string, unknown>)).result as any, [name, args] as const);

  await page.getByTestId('file-input').setInputFiles({ name: 'vocal take.wav', mimeType: 'audio/wav', buffer: sineWav(220) });
  await expect.poll(async () => (await session()).tracks.length).toBe(1);
  await tool('rename_project', { name: 'Demo song' });
  const { track_id } = await tool('add_track', { name: 'Vocal L' });
  await tool('insert_device', { track_id, device: 'utility', params: { pan: -0.4 } });
  await tool('save_setup', {});
  const first = await session();

  await page.getByTestId('project-menu-open').click();
  await page.getByTestId('project-new').click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await page.getByTestId('file-input').setInputFiles({ name: 'keys.wav', mimeType: 'audio/wav', buffer: sineWav(440) });
  await expect.poll(async () => (await session()).tracks.map((t) => t.name)).toEqual(['keys']);
  const second = await session();
  await expect.poll(() => { try { return JSON.parse(readFileSync(join(userData, 'projects', 'p2', 'session.json'), 'utf8')).session.tracks.length; } catch { return 0; } }).toBe(1);
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled'); // the last one open
  await expect.poll(async () => (await session()).tracks).toEqual(second.tracks);
  await expect.poll(audioIds).toEqual(Object.keys(second.sources));
  await page.getByTestId('project-menu-open').click();
  await expect(page.getByTestId('setup-row')).toContainText('Vocal L 40% L');
  await page.getByTestId('project-p1').locator('.pm-open').click();
  await expect(page.getByTestId('project-name')).toHaveText('Demo song');
  await expect.poll(async () => (await session()).tracks.map((t) => t.name)).toEqual(first.tracks.map((t) => t.name));
  await expect.poll(async () => (await audioIds()).sort()).toEqual([...Object.keys(first.sources), ...Object.keys(second.sources)].sort());
  await expect(page.locator('.error')).toHaveCount(0);
  await app.close();
});
