// B12 drum pad: make a kit from Ideas, drop a sound on a pad, play the pads from the keyboard,
// record a take on the kit, delete the kit.
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'screenshots/drum-pad';
mkdirSync(SHOTS, { recursive: true });

function sineWav(seconds = 1, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 80 * i) / sr) * 9000 * Math.exp(-i / sr * 8)), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const notes = (page: Page) => page.evaluate(() => window.__musicalTypingLog!.map((e) => `${e.type} ${e.pitch} ${e.velocity}`));
const pad = (page: Page, key: string) => page.locator(`.mt-pad[data-key="${key}"]`);

test('make a kit, put a sound on a pad, play it and record a take on it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => (window.__musicalTypingLog = []));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'boom.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  const boom = (await session(page)).tracks[0].clips[0].sourceId;

  // + New drum pad: a kit appears in Ideas and the keyboard window shows its pads
  await page.getByTestId('new-drum-pad').click();
  const kb = page.getByTestId('musical-typing');
  await expect(page.getByTestId('kit-pads')).toBeVisible();
  const kitId = Object.keys((await session(page)).kits!)[0];
  await expect(kb).toHaveAttribute('data-kit', kitId);
  await expect(page.locator(`.idea-kit[data-kit="${kitId}"]`)).toContainText('0 of 9 pads');
  await expect(page.locator('.mt-pad')).toHaveCount(9);

  // drop the Ideas sound on the kick pad (Z)
  await page.locator(`.idea[data-idea="${boom}"]`).dragTo(pad(page, 'Z'));
  await expect.poll(async () => (await session(page)).kits![kitId].pads[6].sample?.sourceId).toBe(boom);
  await expect(pad(page, 'Z')).toContainText('boom');
  await expect(page.locator(`.idea-kit[data-kit="${kitId}"]`)).toContainText('1 of 9 pads');

  // Z and X hit the kick and snare pads at the fixed velocity
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.down('z');
  await expect(pad(page, 'Z')).toHaveAttribute('data-active', 'true');
  await page.screenshot({ path: `${SHOTS}/pad-hit.png` });
  await page.keyboard.up('z');
  await page.keyboard.press('x');
  expect(await notes(page)).toEqual(['on 36 100', 'off 36 100', 'on 38 100', 'off 38 100']);

  // R records a take on the kit, on a new track named after it
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.waitForTimeout(250);
  for (const k of ['z', 'x', 'z']) {
    await page.keyboard.down(k);
    await page.waitForTimeout(150);
    await page.keyboard.up(k);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).not.toContainText('REC');
  await expect.poll(async () => (await session(page)).tracks.length).toBe(2);
  const s = await session(page);
  const take = s.tracks[1].clips[0];
  expect(s.tracks[1].name).toBe('Drum pad 1');
  expect(take.midi).toMatchObject({ drum: true, kit: kitId });
  expect(take.midi!.notes.map((n) => n.pitch)).toEqual([36, 38, 36]);
  await page.screenshot({ path: `${SHOTS}/take-recorded.png` });

  // deleting the kit keeps the take (built-in drums)
  await page.locator(`.idea-kit[data-kit="${kitId}"]`).hover();
  await page.locator(`.idea-kit[data-kit="${kitId}"] .idea-del`).click();
  await expect.poll(async () => Object.keys((await session(page)).kits ?? {})).toEqual([]);
  expect((await session(page)).tracks[1].clips[0].midi!.kit).toBeUndefined();
  expect(errors).toEqual([]);
});
