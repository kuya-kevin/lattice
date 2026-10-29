// Logic-style key commands and the control bar fields (web build, mock bridge).
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 6, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } }); // focus nothing in particular
}

test('Space plays/stops, Return goes to the beginning', async ({ page }) => {
  await load(page);
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  expect((await session(page)).transport).toMatchObject({ playing: false });
  expect((await session(page)).transport.position).toBeGreaterThan(0.2); // stops in place
  await expect(page.getByTestId('lcd-time')).not.toHaveText('0:00.00');

  await page.keyboard.press('.'); // forward one bar
  await expect(page.getByTestId('lcd-bars')).toHaveText(/^2 /);
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Cycle' })).toHaveClass(/on/);
  await page.keyboard.press('c');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lcd-time')).toHaveText('0:00.00');
  await expect(page.getByTestId('lcd-bars')).toHaveText('1 1 1');
  expect((await session(page)).transport.position).toBe(0);
});

test('K toggles the click, Shift-K the count-in', async ({ page }) => {
  await load(page);
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: 'Click' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+K');
  expect((await session(page)).metronome).toEqual({ on: true, countIn: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.keyboard.press('Space'); // play with the click on
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  await page.keyboard.press('k');
  expect((await session(page)).metronome.on).toBe(false);
  expect(errors).toEqual([]);
});

test('R records after a one-bar count-in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.getByLabel('Tempo').fill('240'); // 1 bar = 1 s
  await page.getByLabel('Tempo').press('Enter');
  await page.keyboard.press('Shift+K');
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('COUNT-IN');
  await expect(page.getByTestId('lcd')).toContainText('REC', { timeout: 3000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0]?.clips.length).toBe(1);
});

test('typing in the chat box or a field does not trigger shortcuts', async ({ page }) => {
  await load(page);
  const chat = page.getByPlaceholder(/trim the vocal/);
  await chat.click();
  await page.keyboard.type('rock kick c. ');
  await expect(chat).toHaveValue('rock kick c. ');
  const s = await session(page);
  expect(s.transport.playing).toBe(false);
  expect(s.metronome).toEqual({ on: false, countIn: false });
  expect(s.tracks).toHaveLength(1); // R did not start a recording onto a new track
});

test('tempo, signature and key are typed into the LCD and reach the session', async ({ page }) => {
  await load(page);
  const tempo = page.getByLabel('Tempo');
  await tempo.click();
  await tempo.fill('92');
  await tempo.press('Enter'); // commits, and must not jump to the beginning
  await page.getByLabel('Time signature').selectOption('6/8');
  const key = page.getByLabel('Key');
  await key.click();
  await key.fill('gm');
  await key.press('Enter');
  await expect(key).toHaveValue('G minor');
  const s = await session(page);
  expect(s).toMatchObject({ tempo: 92, timeSignature: [6, 8], key: 'G minor' });
  // bad tempo reverts
  await tempo.click();
  await tempo.fill('900');
  await tempo.press('Enter');
  await expect(tempo).toHaveValue('92');
});

for (const [name, size] of [['wide', { width: 1400, height: 800 }], ['narrow', { width: 760, height: 900 }]] as const) {
  test(`control bar screenshot (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await load(page);
    await page.keyboard.press('k');
    await page.getByLabel('Key').fill('A minor');
    await page.getByLabel('Key').press('Enter');
    await page.screenshot({ path: `screenshots/controlbar-${name}.png` });
  });
}

test(', and . jump to the bar lines (Logic, GarageBand)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.evaluate(() => window.lattice!.runTool('go_to', { position: 1.3 })); // 1 3 2
  await expect(page.getByTestId('lcd-bars')).toHaveText('1 3 3');
  await page.keyboard.press('.');
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.getSession())).transport.position).toBe(2);
  await page.keyboard.press('.');
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.getSession())).transport.position).toBe(4);
  await page.keyboard.press(',');
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.getSession())).transport.position).toBe(2);
  await expect(page.getByTestId('lcd-bars')).toHaveText('2 1 1');
});
