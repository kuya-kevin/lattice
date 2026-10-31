// Oct 30: projects from the Lattice pill, and a setup learned on Save (⌘S) once it is done the
// same way in two projects, then offered back in a new one. Persistence across launches is in electron.spec.ts.
import { expect, test, type Page } from '@playwright/test';

const tool = (page: Page, name: string, args: Record<string, unknown> = {}) =>
  page.evaluate(async ([n, a]) => {
    const r = await window.lattice!.runTool(n as string, a as Record<string, unknown>);
    if (!r.ok) throw new Error(r.error);
    return r.result as any;
  }, [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const pans = async (page: Page) => (await session(page)).tracks.map((t) => [t.name, t.devices.find((d) => d.kind === 'utility')?.params.pan ?? 0]);

/** Vocals set up by hand: centre, 40% L, 40% R, an EQ on each. */
async function vocals(page: Page, names: string[]) {
  for (const [i, name] of names.entries()) {
    const { track_id } = await tool(page, 'add_track', { name });
    await tool(page, 'insert_device', { track_id, device: 'eq' });
    if (i) await tool(page, 'insert_device', { track_id, device: 'utility', params: { pan: i === 1 ? -0.4 : 0.4 } });
  }
}

test('a vocal setup done the same way in two projects is offered on Save, then offered back in a new one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const notice = page.getByTestId('notice');
  const menu = page.getByTestId('project-menu');

  // project 1: name it, set up vocals by hand; ⌘S saves, but once is not a habit yet
  await page.getByTestId('project-menu-open').click();
  await expect(menu.getByTestId('learn-after')).toHaveValue('2');
  await menu.getByRole('button', { name: 'Rename' }).click();
  await menu.getByTestId('project-rename').fill('Demo song');
  await menu.getByTestId('project-rename').press('Enter');
  await expect(page.getByTestId('project-name')).toHaveText('Demo song');
  await page.keyboard.press('Escape');
  await vocals(page, ['Vocal', 'Vocal L', 'Vocal R']);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(notice).toContainText('Saved (in Versions');

  // project 2: the same setup under other names; this Save offers it
  await page.getByTestId('project-menu-open').click();
  await menu.getByTestId('project-new').click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await vocals(page, ['Vox', 'Vox L', 'Vox R']);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(notice).toContainText("You've set up vocal tracks this way in 2 projects");
  await expect(notice).toContainText('Vox L 40% L · Vox R 40% R, with Channel EQ');
  await notice.getByRole('button', { name: 'Save vocal setup' }).click();
  await expect(notice).toContainText('Saved your vocal setup');

  // project 3: a bare vocal track gets the offer
  await page.getByTestId('project-menu-open').click();
  await expect(menu.getByTestId('setup-row')).toContainText('from Untitled');
  await menu.getByTestId('project-new').click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled 2');
  expect((await session(page)).tracks).toEqual([]);
  await tool(page, 'add_track', { name: 'Lead Vocal' });
  await expect(notice).toContainText('Use your vocal setup here?');
  await notice.getByRole('button', { name: 'Use it' }).click();
  await expect.poll(() => pans(page)).toEqual([['Lead Vocal', 0], ['Vox L', -0.4], ['Vox R', 0.4]]);

  // the first project is still there, as it was
  await page.getByTestId('project-menu-open').click();
  await menu.getByTestId('project-p1').locator('.pm-open').click();
  await expect(page.getByTestId('project-name')).toHaveText('Demo song');
  await expect.poll(() => pans(page)).toEqual([['Vocal', 0], ['Vocal L', -0.4], ['Vocal R', 0.4]]);
  await page.getByTestId('project-menu-open').click();
  await expect(menu.getByTestId('project-p3')).toContainText('3 tracks');
  expect(errors).toEqual([]);
});
