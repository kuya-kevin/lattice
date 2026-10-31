// Oct 29 computer-use findings on the new B17/B18 UI at a 1400 px window: the Dry toggle and
// Cycle were covered by the file actions, the My Sounds tab was clipped and unclickable, Export
// Sound gave no feedback, and the shelf footer still counted library sounds. A control counts as
// reachable when the element at its centre is the control itself (what a click would hit).
import { expect, test, type Locator, type Page } from '@playwright/test';

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

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

/** True when a click at the control's centre lands on it (not on something laid over it). */
const reachable = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.right <= window.innerWidth && !!hit && (hit === el || el.contains(hit));
  });

async function importTone(page: Page) {
  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: toneWav(1) });
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
}

test('control bar: every transport and file control is reachable from 1600 down to 960 px', async ({ page }) => {
  await page.goto('/');
  await importTone(page);
  const bar = page.getByRole('toolbar', { name: 'Transport' });
  for (const width of [1600, 1400, 1280, 1210, 1190, 1100, 960]) {
    await page.setViewportSize({ width, height: 860 });
    for (const name of ['Go to beginning', 'Play', 'Record', 'Cycle', 'Click', 'Count-in', 'Dry', 'Export stems', 'Import…', 'Track']) {
      const l = bar.getByRole('button', { name, exact: true }).first();
      await expect.poll(() => reachable(l), `${name} at ${width} px`).toBe(true); // the layout settles after a resize
    }
    await expect.poll(() => reachable(page.getByTestId('versions-open')), `Versions at ${width} px`).toBe(true);
  }
});

test('library: the My Sounds tab is reachable and its footer counts shelf sounds', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/');
  await importTone(page);
  await page.getByRole('button', { name: 'Library' }).click();
  const mine = page.getByRole('tab', { name: 'My Sounds' });
  expect(await reachable(mine)).toBe(true);
  await mine.click();
  await expect(mine).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('lib-info').locator('.hint')).toHaveText(/^0 sounds in My Sounds/);
});

test('Export Sound says where the sound went', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('/');
  await importTone(page);
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.runTool('measure_track', { track_id: 't1' }))).ok).toBe(true);
  await page.getByTestId('fx-export-sound').click();
  await expect(page.getByTestId('notice')).toContainText('Saved "hum" to My Sounds');
  // the library is closed here, so the notice opens it on My Sounds
  await page.getByTestId('notice').getByRole('button', { name: 'Show' }).click();
  await expect(page.getByRole('tab', { name: 'My Sounds' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('shelf-mine').getByText('hum')).toBeVisible();
});
