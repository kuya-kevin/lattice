// Saved chains (B10): save a track's device chain by name from the device panel, then load
// it onto another track and check the devices and knob values in the session.
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

test('save a chain on one track and load it on another', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  const panel = page.getByTestId('device-panel');
  await expect(panel).toContainText('Effects: vox');
  const devices = (i: number) => page.evaluate(async (i) => (await window.lattice!.getSession()).tracks[i]?.devices ?? [], i);

  await expect(panel.getByTestId('fx-save-chain')).toBeDisabled(); // nothing to save yet
  await panel.getByTestId('fx-add').selectOption('eq');
  await panel.getByTestId('fx-add').selectOption('comp');
  await expect.poll(async () => (await devices(0)).map((d) => d.kind)).toEqual(['eq', 'comp']);
  const [eq, comp] = await devices(0);
  const knob = panel.getByTestId(`param-${eq.id}-b3_gain`);
  await knob.focus();
  for (let i = 0; i < 25; i++) await knob.press('ArrowRight');
  await expect.poll(async () => (await devices(0))[0].params.b3_gain).toBeGreaterThan(0.5);
  await panel.getByTestId(`device-${comp.id}`).getByTitle('Bypass').locator('input').uncheck();
  await expect.poll(async () => (await devices(0))[1].on).toBe(false);

  await panel.getByTestId('fx-save-chain').click();
  await panel.getByTestId('fx-chain-name').fill('dark vocal');
  await panel.getByTestId('fx-chain-name').press('Enter');
  await expect(panel.getByTestId('fx-chain-name')).toHaveCount(0);
  await expect(panel.getByTestId('fx-load-chain').locator('option', { hasText: 'dark vocal' })).toHaveCount(1);

  // second track, selected, then load
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.lattice!.getSession()).tracks.length)).toBe(2);
  const t2 = await page.evaluate(async () => (await window.lattice!.getSession()).tracks[1].id);
  await page.getByTestId(`track-${t2}`).locator('.track-name').click();
  await expect(panel).toContainText(t2);
  await panel.getByTestId('fx-load-chain').selectOption('dark vocal');

  const src = await devices(0);
  await expect.poll(async () => (await devices(1)).map((d) => [d.kind, d.on, d.params])).toEqual(src.map((d) => [d.kind, d.on, d.params]));
  expect(errors).toEqual([]);
});
