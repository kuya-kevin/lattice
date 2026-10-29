// Resizable layout: drag the Ideas / board-width / board-height handles, reload to check the
// sizes persist, double-click to reset, and change the track lane height (toolbar and
// Option-scroll). Evidence (before/after screenshots and a video per test) lands in
// screenshots/resize/.
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ video: 'on', viewport: { width: 1400, height: 900 } });

const SHOTS = 'screenshots/resize';

function sineWav(seconds: number, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000 * Math.min(1, (n - i) / sr)), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const box = async (l: Locator) => (await l.boundingBox())!;
const scroll = (page: Page) => page.locator('.canvas').evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));

/** Three imported sounds -> three tracks, three idea cards and the device chain. */
async function load(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(
    [2, 3, 1.5].map((s, i) => ({ name: `idea ${i + 1}.wav`, mimeType: 'audio/wav', buffer: sineWav(s, 22050, 180 + i * 90) })),
  );
  await expect(page.getByTestId('track-t3')).toBeVisible();
  await expect(page.getByTestId('device-panel')).toBeVisible();
  await expect(page.locator('[data-track-row] canvas').first()).toBeVisible();
}

/** Drag a handle from its centre by (dx, dy) with real pointer moves. */
async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const b = await box(handle);
  const x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test.afterEach(async ({ page }, info) => {
  const video = page.video();
  await page.close();
  await video?.saveAs(`${SHOTS}/${info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.webm`);
});

/** The device chain is never clipped: its content fits inside it, and scrolling the canvas to
 *  the bottom brings its last line above the Muse prompt bar. */
async function expectChainInFull(page: Page) {
  const chain = page.getByTestId('smart-controls');
  const clipped = await chain.evaluate((el) => [el, ...el.querySelectorAll('*')].some((n) => n.scrollHeight > n.clientHeight + 1 && getComputedStyle(n).overflowY !== 'visible'));
  expect(clipped).toBe(false);
  const canvas = page.locator('.canvas');
  const top = await canvas.evaluate((el) => el.scrollTop);
  await canvas.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const c = (await chain.boundingBox())!;
  const prompt = (await page.locator('.prompt').boundingBox())!;
  expect(c.y + c.height).toBeLessThanOrEqual(prompt.y);
  await canvas.evaluate((el, y) => el.scrollTo(0, y), top);
}

test('panel handles resize ideas, board width and board height; persist; double-click resets', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  const ideas = page.locator('.ideas');
  const col = page.locator('.board-col');
  const board = page.locator('section.board');
  const chain = page.getByTestId('smart-controls');
  await page.screenshot({ path: `${SHOTS}/panels-before.png` });

  const before = { ideas: (await box(ideas)).width, col: await box(col), board: (await box(board)).height, chain: (await box(chain)).height };
  expect(before.ideas).toBe(264);
  const clips = (await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start]));
  const scroll0 = await scroll(page);

  // the device chain shows in full (nothing clipped inside it) and the canvas leaves room below
  // it for the Muse prompt: scrolled to the bottom, the chain ends above the prompt bar
  await expectChainInFull(page);

  // 1. Ideas column: +80 px; the board moves over and takes the rest
  await drag(page, page.getByTestId('rz-ideas'), 80, 0);
  expect((await box(ideas)).width).toBe(344);
  expect(Math.round((await box(col)).x - before.col.x)).toBe(80);

  // 2. board width: 150 px narrower, fixed from now on
  const colW = (await box(col)).width;
  await drag(page, page.getByTestId('rz-board-w'), -150, 0);
  expect(Math.round((await box(col)).width)).toBe(Math.round(colW - 150));
  await expect(col).toHaveClass(/fixed-w/);

  // 3. board / device chain split: board 120 px taller, the chain keeps its full height and moves down
  await drag(page, page.getByTestId('rz-split'), 0, 120);
  const after = { ideas: (await box(ideas)).width, colW: (await box(col)).width, board: (await box(board)).height, chain: (await box(chain)).height };
  expect(Math.round(after.board)).toBe(Math.round(before.board + 120));
  expect(Math.abs(after.chain - before.chain)).toBeLessThanOrEqual(1);
  await expectChainInFull(page);

  // limits: the Ideas column stops at its max, the board at its min height
  await drag(page, page.getByTestId('rz-ideas'), 600, 0);
  expect((await box(ideas)).width).toBe(520);
  await drag(page, page.getByTestId('rz-ideas'), -176, 0);
  expect((await box(ideas)).width).toBe(344);
  await drag(page, page.getByTestId('rz-split'), 0, -2000);
  expect(Math.round((await box(board)).height)).toBe(180);
  await drag(page, page.getByTestId('rz-split'), 0, Math.round(after.board - 180));
  expect(Math.round((await box(board)).height)).toBe(Math.round(after.board));

  // handles neither pan the canvas nor move a region
  expect(await scroll(page)).toEqual(scroll0);
  expect((await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start]))).toEqual(clips);
  await page.screenshot({ path: `${SHOTS}/panels-after.png` });

  // persisted across a reload (the web build's session starts empty again, so re-import)
  await page.reload();
  await expect(page.locator('.board-col')).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lattice.layout.v1')!));
  expect(stored).toMatchObject({ ideasW: 344, boardW: Math.round(after.colW), boardH: Math.round(after.board) });
  await page.getByTestId('file-input').setInputFiles(
    [2, 3, 1.5].map((s, i) => ({ name: `idea ${i + 1}.wav`, mimeType: 'audio/wav', buffer: sineWav(s, 22050, 180 + i * 90) })),
  );
  await expect(page.getByTestId('device-panel')).toBeVisible();
  expect((await box(ideas)).width).toBe(344);
  expect(Math.round((await box(col)).width)).toBe(Math.round(after.colW));
  expect(Math.round((await box(board)).height)).toBe(Math.round(after.board));
  await page.screenshot({ path: `${SHOTS}/panels-after-reload.png` });

  // double-click resets each handle
  await page.getByTestId('rz-ideas').dblclick();
  await page.getByTestId('rz-board-w').dblclick();
  await page.getByTestId('rz-split').dblclick();
  expect((await box(ideas)).width).toBe(264);
  await expect(col).not.toHaveClass(/fixed-w/);
  expect(Math.round((await box(col)).width)).toBe(Math.round(before.col.width));
  expect(Math.round((await box(board)).height)).toBe(Math.round(before.board));
  await page.screenshot({ path: `${SHOTS}/panels-reset.png` });

  // keyboard: arrows nudge a focused handle, Enter resets it
  await page.getByTestId('rz-ideas').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect((await box(ideas)).width).toBe(264 + 16 + 64);
  await page.keyboard.press('Enter');
  expect((await box(ideas)).width).toBe(264);

  // panning the canvas by dragging empty ground still works
  const s0 = await scroll(page);
  await page.mouse.move(40, 500);
  await page.mouse.down();
  await page.mouse.move(40, 380, { steps: 6 });
  await page.mouse.up();
  expect((await scroll(page)).y).toBeGreaterThan(s0.y + 50);
  expect(errors).toEqual([]);
});

test('track height: toolbar and Option-scroll change the lane height; headers compact', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  const lane = page.locator('[data-track-row]').first();
  const laneH = async () => Math.round((await box(lane)).height);
  const header = page.getByTestId('track-t1');
  /** the header's contents fit its slot (nothing clipped), and M / S / R stay reachable */
  const headerFits = async () => {
    const fit = await header.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [...el.querySelectorAll<HTMLElement>('.track-name, button.ms')].every((c) => {
        const b = c.getBoundingClientRect();
        return b.height > 0 && b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5;
      });
    });
    expect(fit).toBe(true);
  };
  const clips = (await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start, c.duration]));
  await page.screenshot({ path: `${SHOTS}/lanes-before.png` });

  expect(await laneH()).toBe(84 + 22); // waveform + region header
  await expect(header.locator('input[type=range]')).toBeVisible();

  await page.getByRole('button', { name: 'Taller tracks' }).click();
  expect(await laneH()).toBe(112 + 22);
  // the waveform redraws at the new height
  await expect.poll(async () => Math.round((await box(lane.locator('canvas').first())).height)).toBe(112);
  await headerFits();
  await page.screenshot({ path: `${SHOTS}/lanes-taller.png` });

  for (const [steps, wave, vol] of [[1, 84, true], [1, 64, true], [1, 48, false], [1, 32, false]] as const) {
    for (let i = 0; i < steps; i++) await page.getByRole('button', { name: 'Shorter tracks' }).click();
    expect(await laneH()).toBe(wave + 22);
    await headerFits();
    if (vol) await expect(header.locator('input[type=range]')).toBeVisible();
    else await expect(header.locator('input[type=range]')).toBeHidden();
  }
  await expect(page.getByRole('button', { name: 'Shorter tracks' })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/lanes-shortest.png` });

  // Option-scroll over the lanes: scrolling up makes them taller
  const lb = await box(lane);
  await page.mouse.move(lb.x + lb.width - 40, lb.y + lb.height / 2);
  await page.keyboard.down('Alt');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -60);
  await page.keyboard.up('Alt');
  await expect.poll(laneH).toBeGreaterThan(32 + 22 + 40);
  const scrolled = await laneH();
  await headerFits();

  // clips and audio are untouched by the height change; the height persists across a reload
  expect((await session(page)).tracks.map((t) => t.clips.map((c) => [c.id, c.start, c.duration]))).toEqual(clips);
  await expect(page.locator('[data-clip-container]')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/lanes-option-scroll.png` });
  await page.reload();
  await page.getByTestId('file-input').setInputFiles({ name: 'again.wav', mimeType: 'audio/wav', buffer: sineWav(2) });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  expect(await laneH()).toBe(scrolled);
  expect(errors).toEqual([]);
});

test('a long device chain shows in full: the canvas grows instead of clipping it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 760 });
  await load(page);
  for (const d of ['utility', 'eq', 'comp', 'reverb']) await page.getByTestId('fx-add').selectOption(d);
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.getSession())).tracks[0].devices.length).toBe(4);
  await expectChainInFull(page);
  await page.locator('.canvas').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: `${SHOTS}/long-chain-scrolled.png` });
});

test('each track resizes on its own by dragging its bottom edge; Height −/+ scales them all', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  const rows = page.locator('[data-track-row]');
  const heights = async () => Promise.all((await rows.all()).map(async (r) => Math.round((await box(r)).height)));
  const ids = (await page.evaluate(() => window.lattice!.getSession())).tracks.map((t) => t.id);
  const h0 = await heights();
  expect(new Set(h0).size).toBe(1); // all lanes start alike
  await page.screenshot({ path: `${SHOTS}/track-heights-before.png` });

  // drag the first track's bottom edge down 60 px: only that lane grows, the guide line shows while dragging
  const handle = page.getByTestId(`lane-h-${ids[0]}`);
  const hb = await box(handle);
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2 + 60, { steps: 6 });
  await expect(page.locator('.lane-h-guide')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.lane-h-guide')).toHaveCount(0);
  await expect.poll(heights).toEqual([h0[0] + 60, h0[1], h0[2]]);
  // the header slot follows its lane
  expect(Math.round((await box(page.getByTestId(`track-${ids[0]}`))).height)).toBe(h0[0] + 60);

  // drag the second one up: shorter (its header compacts)
  await drag(page, page.getByTestId(`lane-h-${ids[1]}`), 0, -50);
  await expect.poll(async () => (await heights())[1]).toBe(h0[1] - 50);
  await page.screenshot({ path: `${SHOTS}/track-heights-mixed.png` });

  // clicking inside the third lane still selects the third track (the patched hit-test)
  const r3 = await box(rows.nth(2));
  await page.mouse.click(r3.x + 600, r3.y + r3.height - 10);
  await expect.poll(async () => (await page.evaluate(() => window.lattice!.getSession())).selection.trackId).toBe(ids[2]);

  // global Height + scales every lane, keeping the custom ones in proportion
  const before = await heights();
  await page.getByRole('button', { name: 'Taller tracks' }).click();
  await expect.poll(async () => (await heights())[0]).toBeGreaterThan(before[0]);
  const after = await heights();
  expect(after[2]).toBeGreaterThan(before[2]);
  expect(after[0] - 22).toBeGreaterThan(after[2] - 22); // the first stays the tallest
  const s = await page.evaluate(() => window.lattice!.getSession());
  expect(s.tracks[0].heightScale).toBeGreaterThan(1);
  expect(s.tracks[1].heightScale).toBeLessThan(1);
  expect(s.tracks[2].heightScale).toBeUndefined();

  // double-click resets one track; nothing went into undo
  await page.getByTestId(`lane-h-${ids[0]}`).dblclick();
  await expect.poll(async () => { const h = await heights(); return h[0] === h[2]; }).toBe(true);
  await page.getByRole('button', { name: 'Undo' }).click(); // undoes the last edit before (none: the import)
  expect((await page.evaluate(() => window.lattice!.getSession())).tracks[1].heightScale).toBeLessThan(1);
  await page.screenshot({ path: `${SHOTS}/track-heights-after.png` });
  expect(errors).toEqual([]);
});

test('the region editor resizes by dragging its bottom edge; persists; double-click resets', async ({ page }) => {
  await load(page);
  const clip = (await session(page)).tracks[0].clips[0].id;
  await page.evaluate((id) => window.lattice!.runTool('select', { track_id: 't1', clip_id: id }), clip);
  await page.getByRole('tab', { name: 'Audio Editor' }).click();
  const editor = page.getByTestId('audio-editor');
  await expect(editor).toBeVisible();
  const h0 = Math.round((await box(editor)).height);
  expect(h0).toBe(260);
  const handle = page.getByTestId('rz-editor');
  const toBottom = () => page.locator('.canvas').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await toBottom();
  await drag(page, handle, 0, 150);
  expect(Math.round((await box(editor)).height)).toBe(410);
  // the editor's lane follows the new height (it draws to what it is given)
  await expect.poll(async () => Math.round((await box(editor.locator('canvas').first())).height)).toBeGreaterThan(300);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lattice.layout.v1')!).editorH)).toBe(410);
  await page.screenshot({ path: `${SHOTS}/editor-taller.png` });

  await toBottom();
  await drag(page, handle, 0, -2000);
  expect(Math.round((await box(editor)).height)).toBe(160); // the minimum
  await handle.dblclick();
  expect(Math.round((await box(editor)).height)).toBe(260);
  // the device chain tab has no editor handle
  await page.getByRole('tab', { name: 'Device chain' }).click();
  await expect(handle).toHaveCount(0);
});
