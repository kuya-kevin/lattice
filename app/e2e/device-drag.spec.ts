// Drag a device by its title bar to reorder the chain: one move_device on release, nothing on a
// plain click, on a drag from a control, on a drop back in place, or after Escape.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 1, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

const kinds = (page: Page) => page.evaluate(async () => (await window.lattice!.getSession()).tracks[0].devices.map((d) => d.kind));

/** Title-bar grab point of a device card, and its left/right edges. */
async function head(page: Page, kind: string) {
  const devices = await page.evaluate(async () => (await window.lattice!.getSession()).tracks[0].devices);
  const id = devices.find((d) => d.kind === kind)!.id;
  const box = (await page.getByTestId(`device-${id}`).boundingBox())!;
  const name = (await page.getByTestId(`device-${id}`).locator('strong').boundingBox())!;
  return { id, x: name.x + name.width / 2, y: name.y + name.height / 2, left: box.x, right: box.x + box.width };
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1300 }); // room for the cards side by side
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: sineWav() });
  const panel = page.getByTestId('device-panel');
  await expect(panel).toContainText('Effects: vox');
  for (const d of ['eq', 'comp', 'deess']) await panel.getByTestId('fx-add').selectOption(d);
  await expect.poll(() => kinds(page)).toEqual(['eq', 'comp', 'deess']);
}

test('dragging a device by its title bar reorders the chain', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);

  expect((await head(page, 'deess')).left).toBeGreaterThan((await head(page, 'eq')).right);

  // the case from the request: pull the de-esser in front of everything
  const deess = await head(page, 'deess');
  const eq = await head(page, 'eq');
  await page.mouse.move(deess.x, deess.y);
  await page.mouse.down();
  await page.mouse.move(deess.x - 40, deess.y, { steps: 3 });
  await page.mouse.move(eq.left + 10, eq.y, { steps: 5 });
  await expect(page.getByTestId('fx-drop-line')).toBeVisible();
  await expect(page.getByTestId(`device-${deess.id}`)).toHaveClass(/dragging/);
  expect(await kinds(page)).toEqual(['eq', 'comp', 'deess']); // nothing moves until release
  await page.mouse.up();
  await expect.poll(() => kinds(page)).toEqual(['deess', 'eq', 'comp']);
  await expect(page.getByTestId('fx-drop-line')).toHaveCount(0);

  // and to the far end, the other way
  const first = await head(page, 'deess');
  const last = await head(page, 'comp');
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(last.right - 10, last.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => kinds(page)).toEqual(['eq', 'comp', 'deess']);

  // a reorder is one hand edit, so one undo takes it back
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => kinds(page)).toEqual(['deess', 'eq', 'comp']);
  expect(errors).toEqual([]);
});

test('a click, a drop in place, a drag from a button and Escape leave the order alone', async ({ page }) => {
  await setup(page);
  const before = ['eq', 'comp', 'deess'];
  const comp = await head(page, 'comp');
  const eq = await head(page, 'eq');

  // plain click on the title bar
  await page.mouse.click(comp.x, comp.y);
  await expect(page.getByTestId('fx-drop-line')).toHaveCount(0);

  // drag and drop back on itself: no line, no move
  await page.mouse.move(comp.x, comp.y);
  await page.mouse.down();
  await page.mouse.move(comp.x + 30, comp.y, { steps: 3 });
  await expect(page.getByTestId(`device-${comp.id}`)).toHaveClass(/dragging/);
  await expect(page.getByTestId('fx-drop-line')).toHaveCount(0);
  await page.mouse.up();

  // Escape cancels; the release afterwards does nothing
  await page.mouse.move(comp.x, comp.y);
  await page.mouse.down();
  await page.mouse.move(eq.left + 10, eq.y, { steps: 5 });
  await expect(page.getByTestId('fx-drop-line')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fx-drop-line')).toHaveCount(0);
  await page.mouse.up();

  // a press on a title-bar button is not a card drag
  const arrow = page.getByTestId(`device-${comp.id}`).getByRole('button', { name: 'Move right' });
  const box = (await arrow.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(eq.left + 10, eq.y, { steps: 5 });
  await expect(page.getByTestId('fx-drop-line')).toHaveCount(0);
  await page.mouse.up();

  expect(await kinds(page)).toEqual(before);

  // the arrows still work
  await page.getByTestId(`device-${comp.id}`).getByRole('button', { name: 'Move left' }).click();
  await expect.poll(() => kinds(page)).toEqual(['comp', 'eq', 'deess']);
});
