// B12b: fill a sample pad from the library in one step (the tool Muse calls for "make me a dusty
// lo-fi kit"). The web build serves the fixture library; asserts on state, plus the kit card.
import { expect, test, type Page } from '@playwright/test';

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

test('find library drums and fill a new kit with them; the sounds load and the kit card shows them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  const kicks = await tool(page, 'find_library_sounds', { category: 'kick' });
  expect((kicks.result as any).sounds.map((s: any) => s.library_id)).toEqual(['fs:103']);
  const hats = await tool(page, 'find_library_sounds', { query: 'hat' });
  expect((hats.result as any).sounds.map((s: any) => s.library_id)).toContain('fs:104');

  const r = await tool(page, 'fill_kit', { name: 'Fixture kit', pads: [{ pad: 6, library_id: 'fs:103' }, { pad: 2, library_id: 'fs:104' }] });
  expect(r.ok).toBe(true);
  const kitId = (r.result as any).kit_id as string;
  const s = await session(page);
  const kit = s.kits![kitId];
  expect(kit.pads[6].label).toBe('Fixture Kick');
  expect(s.sources[kit.pads[6].sample!.sourceId]).toMatchObject({ name: 'Fixture Kick', origin: 'freesound' });
  expect(s.sources[kit.pads[6].sample!.sourceId].credit).toContain('by drummer'); // CC-BY keeps its credit

  await expect(page.locator(`.idea-kit[data-kit="${kitId}"]`)).toContainText('2 of 9 pads');
  // the library audio loads like a restored source (B11 path): a kit region is only drawn once
  // every pad sound has loaded
  const placed = await tool(page, 'place_kit', { kit_id: kitId });
  await expect(page.locator(`[data-clip-id="${(placed.result as any).clip_id}"]`).first()).toBeVisible();
  expect(errors).toEqual([]);
});
