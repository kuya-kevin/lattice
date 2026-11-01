// Library conveniences: real category counts, "Fits <key>", keyboard auditioning and Recent.
import { expect, test, type Page } from '@playwright/test';

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

test('library: fits the project key, ↑/↓ audition, Enter adds to Ideas, Recent remembers it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('lattice.libraryRecents'));
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('o');
  const lib = page.getByTestId('library');
  const rows = page.getByTestId('lib-list').locator('.lib-row');
  const fits = page.getByTestId('lib-fits');
  // fixture sounds are under a second, so check what was auditioned last, not the playing class
  const played = async (n: number) => expect(page.getByTestId('lib-list')).toHaveAttribute('data-last-played', (await rows.nth(n).getAttribute('data-testid'))!.replace('lib-item-', ''));

  // no project key: nothing to fit to
  await expect(fits).toBeDisabled();
  await expect(lib.getByRole('button', { name: /Synth Bass/ })).toContainText('1');

  // Bb major: the A3 lead is in key, the E1 bass is not; drums always fit
  await page.evaluate(() => window.lattice!.runTool('set_key', { key: 'Bb major' }));
  await expect(fits).toHaveText('Fits Bb major');
  await fits.click();
  await expect(fits).toHaveAttribute('aria-pressed', 'true');
  await expect(lib.getByRole('button', { name: /Synth Bass/ })).toContainText('0 of 1');
  await expect(lib.getByRole('button', { name: /Synth Bass/ })).toBeDisabled();
  await expect(lib.getByRole('button', { name: /Synth Lead/ })).not.toContainText('of');
  await lib.getByPlaceholder('Search sounds').fill('fixture');
  await expect(rows).toHaveCount(3); // lead, kick, hat
  await expect(page.getByTestId('lib-item-fs:102')).toHaveCount(0);
  await fits.click();
  await expect(rows).toHaveCount(4);

  // ↓ from the search box moves into the list and auditions; ↓ again plays the next one
  await lib.getByPlaceholder('Search sounds').press('ArrowDown');
  await expect(rows.nth(0)).toHaveClass(/sel/);
  await played(0);
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/sel/);
  await played(1);
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(0)).toHaveClass(/sel/);
  await played(0);
  await page.keyboard.press('Escape');
  await expect(rows.nth(0)).not.toHaveClass(/playing/);

  // Enter adds the selected sound to Ideas (not Go to Start)
  const name = await rows.nth(0).locator('.nm').textContent();
  await page.keyboard.press('Enter');
  await expect.poll(async () => Object.values((await session(page)).sources).map((x) => x.name)).toContain(name);

  // Recent lists it
  await lib.getByRole('tab', { name: 'Recent' }).click();
  await lib.getByPlaceholder('Search sounds').fill('');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText(name!);
  expect(errors).toEqual([]);
});

test('sound names in a Muse reply open the library on that sound and play it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('library')).toBeHidden();
  await page.getByPlaceholder(/trim the vocal/).fill('what kicks do we have?'); // the offline Muse lists the category
  await page.getByRole('button', { name: 'Send' }).click();
  const link = page.getByTestId('chat-list').getByRole('button', { name: 'Fixture Kick' });
  await expect(link).toBeVisible();
  await link.click();
  const lib = page.getByTestId('library');
  await expect(lib).toBeVisible();
  await expect(lib.locator('.lib-crumbs')).toContainText('From Muse');
  await expect(page.getByTestId('lib-list').locator('.lib-row')).toHaveCount(1);
  await expect(page.getByTestId('lib-item-fs:103')).toHaveClass(/sel/);
  await expect(page.getByTestId('lib-list')).toHaveAttribute('data-last-played', 'fs:103'); // the kick is 0.4 s
  // back to browsing
  await lib.getByRole('button', { name: '‹ All' }).click();
  await expect(page.getByTestId('lib-browse')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a run of sound names in a Muse reply is shown as a list of rows', async ({ page }) => {
  await page.goto('/');
  // the fixture library has one sound per category, so stand in a reply that names four
  await page.route('**/api/library', async (route) => {
    const items = await (await route.fetch()).json();
    const pads = ['Airy', 'Orion', 'Deep', 'Glass'].map((n, i) => ({ ...items[0], id: `fs:9${i}`, category: 'pad', name: `${n} Pad.wav`, note: 'C3' }));
    await route.fulfill({ json: [...items, ...pads] });
  });
  await page.getByPlaceholder(/trim the vocal/).fill('what pads do we have?');
  await page.getByRole('button', { name: 'Send' }).click();
  const list = page.getByTestId('chat-sound-list');
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.getByRole('listitem').first()).toContainText('Airy Pad');
  await expect(list.getByRole('listitem').first()).toContainText('C3');
  await list.getByRole('button', { name: /Orion Pad/ }).click();
  await expect(page.getByTestId('lib-item-fs:91')).toHaveClass(/sel/);
});
