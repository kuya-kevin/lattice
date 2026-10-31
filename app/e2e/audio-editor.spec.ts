// Audio editor: double-click an audio region to open it under the board (GarageBand's audio
// editor, Logic's Audio Track Editor): a close-up waveform on the bar grid where you scrub,
// trim the edges and drag the region onto the grid. Trims and moves run trim_clip / move_clip,
// so they are undoable and Muse sees them as hand edits.
import { expect, test, type Page } from '@playwright/test';
import { shot } from './evidence';

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

const session = (page: Page) => page.evaluate(async () => window.lattice!.getSession());
const clip = async (page: Page) => (await session(page)).tracks[0].clips[0];
const onGrid = (t: number, step: number) => Math.abs(t / step - Math.round(t / step)) < 1e-3;

async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toContainText('vox');
  const b = (await page.locator('[data-track-row][data-track-id="t1"] [data-clip-container]').boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
}

async function drag(page: Page, x: number, y: number, dx: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

test('double-click an audio region opens the audio editor; trim, move to grid, scrub, undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  const ed = page.getByTestId('audio-editor');
  await expect(ed).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Audio Editor' })).toHaveAttribute('aria-selected', 'true');
  await expect(ed).toContainText('vox');
  await expect(ed.getByRole('button', { name: 'Extract MIDI' })).toBeVisible();
  const s = await session(page);
  const step = 60 / s.tempo / 4; // the default grid is 1/16
  const lane = ed.getByTestId('ae-lane');
  const pps = Number(await lane.getAttribute('data-pps'));
  expect(pps).toBeGreaterThan(20);
  // the waveform is drawn (some non-transparent pixels in the canvas)
  await expect.poll(() => ed.getByTestId('ae-wave').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  })).toBeGreaterThan(100);

  // trim the start in by ~0.3 s: it snaps to a 1/16 and the audio stays in place (offset = start)
  // grab regions near the top: the floating Muse box covers the lower half at this viewport
  const region = ed.getByTestId('ae-region');
  await region.scrollIntoViewIfNeeded();
  let r = (await region.boundingBox())!;
  await drag(page, r.x + 2, r.y + 24, 0.3 * pps);
  await expect.poll(async () => (await clip(page)).start).toBeGreaterThan(0.2);
  let c = await clip(page);
  expect(onGrid(c.start, step)).toBe(true);
  expect(c.offset).toBeCloseTo(c.start, 3);
  expect(c.start + c.duration).toBeCloseTo(2, 2);

  // trim the end in by ~0.5 s
  r = (await region.boundingBox())!;
  await drag(page, r.x + r.width - 2, r.y + 24, -0.5 * pps);
  await expect.poll(async () => { const k = await clip(page); return k.start + k.duration; }).toBeLessThan(1.7);
  c = await clip(page);
  expect(onGrid(c.start + c.duration, step)).toBe(true);

  // drag the region body right ~0.6 s: it moves with its audio and lands on the grid
  const before = c;
  r = (await region.boundingBox())!;
  await drag(page, r.x + r.width / 2, r.y + 24, 0.6 * pps);
  await expect.poll(async () => (await clip(page)).start).toBeGreaterThan(before.start + 0.4);
  c = await clip(page);
  expect(onGrid(c.start, step)).toBe(true);
  expect(c.offset).toBeCloseTo(before.offset, 3);
  expect(c.duration).toBeCloseTo(before.duration, 3);

  // click-drag in the ruler scrubs: the playhead lands where the pointer lets go
  const ruler = ed.getByTestId('ae-ruler');
  const rb = (await ruler.boundingBox())!;
  await drag(page, rb.x + 0.5 * pps, rb.y + 8, 0.5 * pps);
  await expect.poll(async () => (await session(page)).transport.position).toBeCloseTo(1, 1);

  // undo the move, then both trims
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => { const k = await clip(page); return [k.start, k.offset, k.duration]; }).toEqual([0, 0, 2]);
  await shot(page, 'test-results/audio-editor.png');
  expect(errors).toEqual([]);
});

test('P toggles the region editor', async ({ page }) => {
  await load(page);
  const ed = page.getByTestId('audio-editor');
  await expect(ed).toBeVisible();
  await page.keyboard.press('p');
  await expect(ed).toHaveCount(0);
  await page.keyboard.press('p');
  await expect(ed).toBeVisible();
});
