// Oct 30: projects from the Lattice pill, and the vocal setup learned on Save (⌘S) and offered
// back in a new project. Persistence across launches is in electron.spec.ts.
import { expect, test, type Page } from '@playwright/test';

const tool = (page: Page, name: string, args: Record<string, unknown> = {}) =>
  page.evaluate(async ([n, a]) => {
    const r = await window.lattice!.runTool(n as string, a as Record<string, unknown>);
    if (!r.ok) throw new Error(r.error);
    return r.result as any;
  }, [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const pans = async (page: Page) => (await session(page)).tracks.map((t) => [t.name, t.devices.find((d) => d.kind === 'utility')?.params.pan ?? 0]);

test('teach the vocal setup on Save, get it back in a new project, reopen the first', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const notice = page.getByTestId('notice');
  const menu = page.getByTestId('project-menu');

  // project 1: name it, set up vocals by hand (centre, 40% L, 40% R; EQ on each)
  await page.getByTestId('project-menu-open').click();
  await menu.getByRole('button', { name: 'Rename' }).click();
  await menu.getByTestId('project-rename').fill('Demo song');
  await menu.getByTestId('project-rename').press('Enter');
  await expect(page.getByTestId('project-name')).toHaveText('Demo song');
  await page.keyboard.press('Escape');
  for (const [name, pan] of [['Vocal', 0], ['Vocal L', -0.4], ['Vocal R', 0.4]] as const) {
    const { track_id } = await tool(page, 'add_track', { name });
    await tool(page, 'insert_device', { track_id, device: 'eq' });
    if (pan) await tool(page, 'insert_device', { track_id, device: 'utility', params: { pan } });
  }

  // ⌘S saves, and offers to keep the setup
  await page.keyboard.press('ControlOrMeta+s');
  await expect(notice).toContainText('Keep this as your vocal setup');
  await expect(notice).toContainText('Vocal L 40% L · Vocal R 40% R, with Channel EQ');
  await notice.getByRole('button', { name: 'Save vocal setup' }).click();
  await expect(notice).toContainText('Saved your vocal setup');
  await page.keyboard.press('ControlOrMeta+s'); // nothing new to learn now
  await expect(notice).toContainText('Saved (in Versions');

  // New Project: empty; a vocal track gets the offer
  await page.getByTestId('project-menu-open').click();
  await expect(menu.getByTestId('setup-row')).toContainText('from Demo song');
  await menu.getByTestId('project-new').click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  expect((await session(page)).tracks).toEqual([]);
  await tool(page, 'add_track', { name: 'Vox' });
  await expect(notice).toContainText('Use your vocal setup here?');
  await notice.getByRole('button', { name: 'Use it' }).click();
  await expect.poll(() => pans(page)).toEqual([['Vox', 0], ['Vocal L', -0.4], ['Vocal R', 0.4]]);

  // the first project is still there, as it was
  await page.getByTestId('project-menu-open').click();
  await menu.getByTestId('project-p1').locator('.pm-open').click();
  await expect(page.getByTestId('project-name')).toHaveText('Demo song');
  await expect.poll(() => pans(page)).toEqual([['Vocal', 0], ['Vocal L', -0.4], ['Vocal R', 0.4]]);
  await page.getByTestId('project-menu-open').click();
  await expect(menu.getByTestId('project-p2')).toContainText('3 tracks');
  expect(errors).toEqual([]);
});
