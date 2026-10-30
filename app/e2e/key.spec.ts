// B20: right-click a MIDI region -> Detect Key / Use as Session Key. Asserts on the session.
import { expect, test, type Page } from '@playwright/test';

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

// Am - Dm - E - Am
const chord = (pitches: number[], start: number, duration = 0.5) => pitches.map((pitch) => ({ pitch, start, duration, velocity: 90 }));
const NOTES = [...chord([57, 60, 64], 0), ...chord([62, 65, 69], 0.5), ...chord([56, 59, 64], 1), ...chord([57, 60, 64], 1.5)];

test('detect a region\'s key from the region menu, then make it the session key (one undo)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  expect((await tool(page, 'add_track', { name: 'Keys' })).ok).toBe(true);
  const t = (await session(page)).tracks[0].id;
  const rec = await tool(page, 'record_midi', { track_id: t, start: 0, duration: 2, notes: NOTES });
  expect(rec.ok).toBe(true);
  const clipId = (rec.result as any).clip_id as string;

  const region = page.locator('[data-clip-container]').filter({ has: page.locator(`[data-clip-id="${clipId}"]`) });
  await region.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: /Detect Key/ }).click();
  await expect(page.getByTestId('notice')).toContainText('Key: A minor');
  const clipKey = async () => (await session(page)).tracks[0].clips.find((c) => c.id === clipId)?.key;
  await expect.poll(clipKey).toBe('A minor');
  expect((await session(page)).key).toBeNull();

  await region.click({ button: 'right', force: true });
  await page.getByRole('menuitem', { name: /Use as Session Key/ }).click();
  await expect.poll(async () => (await session(page)).key).toBe('A minor');
  await expect(page.getByTestId('notice')).toContainText('now the session key');

  // the menu says it is already the session key
  await region.click({ button: 'right', force: true });
  await expect(page.getByRole('menuitem', { name: /Use as Session Key/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  await tool(page, 'undo', {});
  await expect.poll(async () => (await session(page)).key).toBeNull();
  expect(errors).toEqual([]);
});
