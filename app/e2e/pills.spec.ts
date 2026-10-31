// Draggable chrome pills (Chrome.tsx): drag the transport, the tool rail, the project pill, the file
// actions or the zoom bar by their empty background to a new spot. Each stays inside its zone of
// the window, the spot is kept in localStorage across a reload, a drop near the window's centre
// snaps there, and a double-click (or Layout > Reset pills) puts them back.
// Asserts on the stored offsets and element boxes, not pixels.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { shot } from './evidence';

test.use({ viewport: { width: 1600, height: 1000 } });

const KEY = 'lattice.pills.v1';
const stored = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, { x: number; y: number; centre?: boolean }>, KEY);
const box = async (l: Locator) => (await l.boundingBox())!;

const transport = (p: Page) => p.locator('.controlbar .transport');
const rail = (p: Page) => p.locator('nav.rail');
const project = (p: Page) => p.locator('.project-menu-wrap');

/** Reload and wait for the web fonts: the pills are centred, so a font landing after a measure
 *  moves them (~1.6 px). */
async function reload(page: Page) {
  await page.reload();
  await expect(transport(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Press at the centre of `grip`, move by (dx, dy) in steps, release. */
async function drag(page: Page, grip: Locator, dx: number, dy: number) {
  const b = await box(grip);
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test('drag pills by their background; clamped, remembered across a reload, reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await reload(page);

  // the transport, by an LCD label (not a button): moves 60 px to the left and stays there
  const t0 = await box(transport(page));
  const r0 = await box(rail(page));
  const p0 = await box(project(page));
  await drag(page, page.locator('.controlbar .transport .lcd .label').first(), -60, 0);
  let t = await box(transport(page));
  expect(t.x).toBeCloseTo(t0.x - 60, 0);
  expect(t.y).toBeCloseTo(t0.y, 0);
  expect((await stored(page)).transport).toMatchObject({ x: -60, y: 0 });

  // the rail, by its divider: up 150 px; buttons still work after a drag
  await drag(page, page.locator('nav.rail hr'), 0, -150);
  let r = await box(rail(page));
  expect(r.y).toBeCloseTo(r0.y - 150, 0);
  expect((await stored(page)).rail).toMatchObject({ x: 0, y: -150 });
  await page.getByRole('button', { name: 'Muse', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Muse', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Muse', exact: true }).click();

  // the project pill is one button: a drag moves it without opening the menu; a click still opens it
  await drag(page, page.getByTestId('project-menu-open'), 40, 0);
  expect((await box(project(page))).x).toBeCloseTo(p0.x + 40, 0);
  await expect(page.getByTestId('project-menu-open')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('project-menu-open').click();
  await expect(page.getByTestId('project-menu-open')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.click(800, 600); // away
  await expect(page.getByTestId('project-menu-open')).toHaveAttribute('aria-expanded', 'false');

  // kept across a reload
  await reload(page);
  t = await box(transport(page));
  r = await box(rail(page));
  expect(t.x).toBeCloseTo(t0.x - 60, 0);
  expect(r.y).toBeCloseTo(r0.y - 150, 0);
  expect((await box(project(page))).x).toBeCloseTo(p0.x + 40, 0);

  // clamped: the transport stays in the top band, the rail in the right gutter and the window
  await drag(page, page.locator('.controlbar .transport .lcd .label').first(), 2000, 500);
  t = await box(transport(page));
  const topH = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h')));
  expect(t.x + t.width).toBeLessThanOrEqual(1600);
  expect(t.y + t.height).toBeLessThanOrEqual(topH + 8 + 0.5);
  await drag(page, page.locator('nav.rail hr'), -1200, -2000);
  r = await box(rail(page));
  expect(r.x).toBeGreaterThanOrEqual(1600 - 104 - 0.5);
  expect(r.y).toBeGreaterThanOrEqual(topH);

  // dropped near the window's centre, the transport snaps to it, and stays centred after a resize
  t = await box(transport(page));
  await drag(page, page.locator('.controlbar .transport .lcd .label').first(), 800 - (t.x + t.width / 2) + 5, 0);
  t = await box(transport(page));
  expect(t.x + t.width / 2).toBeCloseTo(800, 0);
  expect((await stored(page)).transport?.centre).toBe(true);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await expect.poll(async () => { const b = await box(transport(page)); return Math.round(b.x + b.width / 2); }).toBe(750);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // double-click the drag area: the transport goes back where it started
  await page.locator('.controlbar .transport .lcd .label').first().dblclick();
  t = await box(transport(page));
  expect(t.x).toBeCloseTo(t0.x, 0);
  expect(t.y).toBeCloseTo(t0.y, 0);
  expect((await stored(page)).transport).toBeUndefined();
  expect((await stored(page)).rail).toBeDefined();

  // Layout > Reset pills: all of them
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByRole('menuitem', { name: 'Reset pills' }).click();
  expect(await stored(page)).toEqual({});
  r = await box(rail(page));
  expect(r.x).toBeCloseTo(r0.x, 0);
  expect(r.y).toBeCloseTo(r0.y, 0);
  expect((await box(project(page))).x).toBeCloseTo(p0.x, 0);
  await shot(page, 'screenshots/pills/reset.png');
  expect(errors).toEqual([]);
});
