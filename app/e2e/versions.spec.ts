// Versions (B11): save two named versions from the Versions menu, restore the first, and start
// a new session (the old one stays as an auto version). Persistence across launches is in
// electron.spec.ts.
import { expect, test } from '@playwright/test';

function sineWav(seconds = 2, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

test('save two versions, restore the first, then start a new session', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  const panel = page.getByTestId('device-panel');
  await expect(panel).toContainText('Effects: vox');
  const session = () => page.evaluate(() => window.lattice!.getSession());
  const kinds = async () => (await session()).tracks[0]?.devices.map((d) => d.kind) ?? [];

  const menu = page.getByTestId('versions-menu');
  const save = async (name: string) => {
    await menu.getByTestId('version-name').fill(name);
    await menu.getByTestId('version-name').press('Enter');
    await expect(menu.locator('.version-row', { hasText: name })).toHaveCount(1);
  };

  await panel.getByTestId('fx-add').selectOption('eq');
  await expect.poll(kinds).toEqual(['eq']);
  await page.getByTestId('versions-open').click();
  await expect(menu).toBeVisible();
  await save('clean');
  const clean = await session();

  await panel.getByTestId('fx-add').selectOption('comp');
  await expect.poll(kinds).toEqual(['eq', 'comp']);
  await save('with comp');
  await expect(menu.locator('.version-row .version-name')).toHaveText(['with comp', 'clean']); // newest first
  // each version says what came after it: "clean" was followed by the compressor; the newest by nothing
  const clean1 = menu.locator('.version-row', { hasText: 'clean' });
  await expect(clean1.getByTestId('version-stat')).toHaveText(/\+1\s*after this/);
  await expect(clean1.getByTestId('version-changes')).toHaveText(/Compressor on vox/);
  await expect(menu.locator('.version-row', { hasText: 'with comp' })).toContainText('No changes after this');
  await panel.getByTestId('fx-add').selectOption('eq');
  await expect(menu.locator('.version-row', { hasText: 'with comp' }).getByTestId('version-changes')).toHaveText(/Channel EQ on vox/); // live: up to now

  await menu.locator('.version-row', { hasText: 'clean' }).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(kinds).toEqual(['eq']);
  expect((await session()).tracks).toEqual(clean.tracks);

  await menu.getByTestId('new-session').click();
  await expect.poll(async () => (await session()).tracks.length).toBe(0);
  await expect(menu.locator('.version-row.auto', { hasText: 'Before new session' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});
