// Device panel + live effects hook: add devices from the catalog-generated panel, move a
// knob (preview, then commit as a set_param hand edit), and play through the chain.
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

test('add devices, turn a knob, play through the live chain', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  const panel = page.getByTestId('device-panel');
  await expect(panel).toContainText('Effects: vox');

  await panel.getByTestId('fx-add').selectOption('eq');
  await panel.getByTestId('fx-add').selectOption('limiter');
  const session = () => page.evaluate(async () => (await window.lattice!.getSession()).tracks[0].devices);
  await expect.poll(async () => (await session()).map((d) => d.kind)).toEqual(['eq', 'limiter']);
  const [eq] = await session();
  // the limiter's lookahead is reported by the live ChainHost inside waveform-playlist's track graph
  await expect(panel).toContainText('latency 5 ms');

  const knob = panel.getByTestId(`param-${eq.id}-b3_gain`);
  await knob.focus();
  for (let i = 0; i < 25; i++) await knob.press('ArrowRight');
  await expect.poll(async () => (await session())[0].params.b3_gain).toBeGreaterThan(0.5);

  await panel.getByTestId(`param-${eq.id}-hp_on`).check();
  await expect.poll(async () => (await session())[0].params.hp_on).toBe(true);

  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Stop' }).click();

  await panel.getByRole('button', { name: 'Remove Limiter' }).click();
  await expect.poll(async () => (await session()).map((d) => d.kind)).toEqual(['eq']);
  await page.screenshot({ path: 'test-results/fx-panel.png', fullPage: true });
  expect(errors).toEqual([]);
});
