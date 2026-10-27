// Launches the built Electron app (run `npm run build` first) and checks the IPC bridge:
// import -> main-process session -> renderer. Sends no chat, so no Meta calls.
import { existsSync } from 'node:fs';
import { _electron as electron, expect, test } from '@playwright/test';

test.skip(!existsSync('dist-electron/main.cjs') || !existsSync('dist/index.html'), 'run `npm run build` first');

test('electron app imports audio through the main-process session', async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await expect(page.locator('.chat header')).toHaveText('Muse'); // no "offline mock" badge
  expect(await page.evaluate(() => window.lattice?.mode)).toBe('electron');
  const wav = Buffer.alloc(44 + 22050 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 22050 * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(22050 * 2, 40);
  await page.getByTestId('file-input').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByTestId('track-t1')).toContainText('silence');
  const session = await page.evaluate(() => window.lattice!.getSession());
  expect(session.tracks[0].clips[0]).toMatchObject({ id: 'c2', duration: 1 });
  await app.close();
});
