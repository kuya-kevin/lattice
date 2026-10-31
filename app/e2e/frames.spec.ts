// Movable frames (Frames.tsx): drag Ideas, the board and the editor by their titles, dock them
// on another frame's side, pick a preset from the Layout menu, let Muse move them (set_layout),
// and keep the layout across a reload. Asserts on session.frames and frame boxes, not pixels.
// Evidence lands in screenshots/frames/.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { shot } from './evidence';

test.use({ viewport: { width: 1600, height: 1000 } });

const SHOTS = 'screenshots/frames';

function sineWav(seconds: number, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const frames = (page: Page) => page.evaluate(async () => (await window.lattice!.getSession()).frames);
const box = async (l: Locator) => (await l.boundingBox())!;
const ideasF = (p: Page) => p.locator('[data-frame="ideas"]');
const boardF = (p: Page) => p.locator('[data-frame="board"]');
const editorF = (p: Page) => p.locator('[data-frame="editor"]');

async function load(page: Page) {
  await page.getByTestId('file-input').setInputFiles(
    [2, 3, 1.5].map((s, i) => ({ name: `idea ${i + 1}.wav`, mimeType: 'audio/wav', buffer: sineWav(s, 22050, 180 + i * 90) })),
  );
  await expect(page.getByTestId('track-t3')).toBeVisible();
  await expect(page.getByTestId('device-panel')).toBeVisible();
}

/** Press on `handle` (`grab` px from its left edge; negative: from its right edge), move to
 *  (x, y) in steps, then `finish` (release by default). */
async function dragTo(page: Page, handle: Locator, x: number, y: number, finish: (p: Page) => Promise<void> = (p) => p.mouse.up(), grab = 12) {
  const b = await box(handle);
  await page.mouse.move(grab >= 0 ? b.x + grab : b.x + b.width + grab, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move((b.x + x) / 2, (b.y + y) / 2, { steps: 6 });
  await page.mouse.move(x, y, { steps: 6 });
  await finish(page);
}

const noOverlap = async (page: Page) => {
  const bs = await Promise.all([ideasF(page), boardF(page), editorF(page)].map(box));
  for (const a of bs) for (const c of bs) {
    if (a === c) continue;
    expect(a.x < c.x + c.width && c.x < a.x + a.width && a.y < c.y + c.height && c.y < a.y + a.height).toBe(false);
  }
};

test('drag frames by their titles: dock, place freely, cancel; Layout menu and set_layout; persists', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('lattice.frames.v1'));
  await page.reload();
  await load(page);

  // default: Ideas left of the board, the editor under it; the session mirrors the layout
  let i = await box(ideasF(page)), b = await box(boardF(page)), e = await box(editorF(page));
  expect(i.x + i.width).toBeLessThan(b.x);
  expect(e.y).toBeGreaterThan(b.y + b.height - 1);
  expect(Math.round(e.width)).toBe(Math.round(b.width));
  expect(await frames(page)).toMatchObject({ ideas: { dock: 'board', side: 'left' }, editor: { dock: 'board', side: 'bottom' } });
  await shot(page, `${SHOTS}/1-default.png`);

  // the Layout menu: Ideas right
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByRole('menuitemradio', { name: /Ideas right/ }).click();
  await expect.poll(async () => (await frames(page))?.ideas).toEqual({ dock: 'board', side: 'right' });
  i = await box(ideasF(page)); b = await box(boardF(page));
  expect(i.x).toBeGreaterThan(b.x + b.width);
  // the wires go round the board: no wire point over the lanes (right of the track headers)
  const head = await box(page.getByTestId('track-t1'));
  const inLanes = await page.evaluate(({ x, x1, y0, y1 }) => {
    const world = document.querySelector('.world')!.getBoundingClientRect();
    return [...document.querySelectorAll<SVGPathElement>('.wires path')].some((p) => {
      for (let t = 0; t <= 1; t += 0.02) {
        const pt = p.getPointAtLength(p.getTotalLength() * t);
        const px = pt.x + world.left, py = pt.y + world.top;
        if (px > x + 4 && px < x1 && py > y0 && py < y1) return true;
      }
      return false;
    });
  }, { x: head.x + head.width, x1: b.x + b.width, y0: b.y, y1: b.y + b.height });
  expect(await page.locator('.wires path').count()).toBe(3);
  expect(inLanes).toBe(false);
  await shot(page, `${SHOTS}/2-ideas-right.png`);

  // drag Ideas onto the board's top edge: the dock preview shows; dropped, Ideas turn into a strip above
  b = await box(boardF(page));
  await dragTo(page, page.locator('.ideas .frame-title'), b.x + b.width / 2, b.y - 24, async (p) => {
    await expect(p.getByTestId('frame-dock-preview')).toBeVisible();
    await shot(p, `${SHOTS}/3-dock-preview.png`);
    await p.mouse.up();
  });
  await expect.poll(async () => (await frames(page))?.ideas).toEqual({ dock: 'board', side: 'top' });
  expect((await frames(page))?.ideasShape).toBe('strip');
  await expect(ideasF(page)).toHaveClass(/ideas-strip/);
  i = await box(ideasF(page)); b = await box(boardF(page));
  expect(i.y + i.height).toBeLessThan(b.y);
  expect(Math.round(i.width)).toBe(Math.round(b.width));
  await noOverlap(page);
  await shot(page, `${SHOTS}/4-ideas-strip.png`);

  // Escape cancels a drag: nothing changes
  const before = await frames(page);
  await dragTo(page, page.locator('.smart-controls > header'), b.x + b.width + 200, b.y + 40, async (p) => {
    await expect(editorF(p)).toHaveClass(/frame-dragging/); // the header's empty part grabs the frame
    await p.keyboard.press('Escape');
    await expect(editorF(p)).not.toHaveClass(/frame-dragging/);
    await p.mouse.up();
  }, -80);
  expect(await frames(page)).toEqual(before);
  await expect(page.getByTestId('frame-dock-preview')).toHaveCount(0);

  // drop the editor in open space: it stays where it was put, free, overlapping nothing
  await page.locator('.canvas').evaluate((el) => el.scrollTo(0, 0));
  b = await box(boardF(page));
  const hdr = await box(page.locator('.smart-controls > header'));
  await dragTo(page, page.locator('.smart-controls > header'), hdr.x + hdr.width - 80, b.y + b.height + 260, undefined, -80);
  await expect.poll(async () => 'x' in ((await frames(page))?.editor ?? {})).toBe(true);
  await noOverlap(page);

  // clicking a tab in the editor header is not a drag
  const mid = await frames(page);
  await page.getByRole('tab', { name: 'Mixer' }).click();
  await expect(page.getByRole('tab', { name: 'Mixer' })).toHaveAttribute('aria-selected', 'true');
  expect(await frames(page)).toEqual(mid);

  // Muse moves frames with set_layout: three columns, the editor as tall as the board
  const r = await page.evaluate(() => window.lattice!.runTool('set_layout', { preset: 'columns' }));
  expect(r.ok).toBe(true);
  await expect.poll(async () => {
    const [bb, ee] = [await box(boardF(page)), await box(editorF(page))];
    return ee.x > bb.x + bb.width && Math.abs(ee.y - bb.y) < 1 && ee.height >= bb.height - 1;
  }).toBe(true);
  await expect(editorF(page)).toHaveClass(/tall/);
  await shot(page, `${SHOTS}/5-columns-mixer.png`);

  // app-wide: kept across a reload, and sent to the new session
  await page.reload();
  await load(page);
  await expect.poll(async () => (await frames(page))?.editor).toEqual({ dock: 'board', side: 'right' });
  b = await box(boardF(page)); e = await box(editorF(page));
  expect(e.x).toBeGreaterThan(b.x + b.width);
  expect(errors).toEqual([]);
});

test('frames sit centred in a wide window, clear of the Muse panel', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('lattice.frames.v1'));
  await page.reload();
  await load(page);
  const edges = async () => {
    const bs = await Promise.all([ideasF(page), boardF(page), editorF(page)].map(box));
    return { l: Math.min(...bs.map((x) => x.x)), r: Math.max(...bs.map((x) => x.x + x.width)) };
  };
  const { l, r } = await edges();
  expect(Math.abs(l - (2400 - r))).toBeLessThanOrEqual(2); // board at its widest: room on both sides
  expect(l).toBeGreaterThan(100);
  // the Muse panel opens on the left: the frames move clear of it
  await page.getByRole('button', { name: 'Muse', exact: true }).click();
  await expect(page.locator('aside.chat')).toBeVisible();
  const panel = await box(page.locator('aside.chat'));
  await expect.poll(async () => (await edges()).l).toBeGreaterThan(panel.x + panel.width);
});
