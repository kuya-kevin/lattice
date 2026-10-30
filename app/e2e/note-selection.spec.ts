// The Piano Roll's note selection is session state: Muse's summary names the selected notes, a
// tool given their indexes acts on them only, and the highlight follows the notes it moved.
// The browser build's offline Muse replies with the summary it was sent, so the chat shows it.
import { expect, test, type Page } from '@playwright/test';

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const tool = (page: Page, name: string, args: object = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);

async function openRoll(page: Page, notes: object[]) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  await tool(page, 'add_track', { name: 'Keys' });
  const t = (await session(page)).tracks[0].id;
  await tool(page, 'record_midi', { track_id: t, start: 0, duration: 4, notes });
  const region = page.locator('[data-clip-container]').first();
  await expect(region).toBeVisible();
  const b = (await region.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  await page.evaluate(() => {
    const r = document.querySelector('[data-testid="piano-roll"]')!.getBoundingClientRect();
    document.querySelector('.canvas')!.scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
  });
  return page.getByTestId('piano-roll').getByTestId('pr-note');
}
const selected = async (page: Page) => (await session(page)).selection.notes ?? [];
const pitches = async (page: Page) => (await session(page)).tracks[0].clips[0].midi!.notes.map((n) => n.pitch);

test('clicked and marquee-selected notes reach the session and Muse; "these notes" act on them', async ({ page }) => {
  const notes = await openRoll(page, [
    { pitch: 60, start: 0.03, duration: 0.2, velocity: 100 },
    { pitch: 64, start: 0.53, duration: 0.2, velocity: 100 },
    { pitch: 67, start: 1.03, duration: 0.2, velocity: 100 },
  ]);
  await expect(notes).toHaveCount(3);

  await notes.nth(1).click();
  await expect.poll(() => selected(page)).toEqual([1]);
  await notes.nth(2).click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual([1, 2]);

  // Muse's view of it (the offline stand-in echoes the summary)
  await page.getByLabel('Message Muse').fill('quantize these');
  await page.getByLabel('Message Muse').press('Enter');
  const reply = page.locator('.msg.muse').last();
  await expect(reply).toContainText('2 of its 3 notes selected in the Piano Roll');
  await expect(reply).toContainText('"these notes" = notes [1,2]');

  // what Muse would call for "quantize these": only the selected notes move
  await tool(page, 'quantize_midi', { grid: '1/16', notes: [1, 2] });
  expect((await session(page)).tracks[0].clips[0].midi!.notes.map((n) => n.start)).toEqual([0.03, 0.5, 1]);

  // Escape clears it in the session too (once the chat box lets go of the keys)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toEqual([]);

  // a marquee over the first two notes, drawn right to left (the first note touches the keys)
  const a = (await notes.nth(0).boundingBox())!;
  const b = (await notes.nth(1).boundingBox())!;
  await page.mouse.move(b.x + b.width + 6, Math.min(a.y, b.y) - 6);
  await page.mouse.down();
  await page.mouse.move(a.x + 2, Math.max(a.y, b.y) + a.height + 6, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => selected(page)).toEqual([0, 1]);
});

test("Muse's edit moves the highlight with the note it re-sorted", async ({ page }) => {
  const notes = await openRoll(page, [
    { pitch: 60, start: 0, duration: 0.2, velocity: 100 },
    { pitch: 64, start: 0, duration: 0.2, velocity: 100 },
  ]);
  await notes.nth(1).click(); // E4
  await expect.poll(() => selected(page)).toEqual([1]);
  await tool(page, 'transpose_midi', { clip_id: (await session(page)).tracks[0].clips[0].id, semitones: -7, notes: [1] }); // E4 -> A3, now first
  await expect.poll(() => pitches(page)).toEqual([57, 60]);
  await expect.poll(() => selected(page)).toEqual([0]);
  await expect(notes.nth(0)).toHaveClass(/\bsel\b/);
  await expect(notes.nth(1)).not.toHaveClass(/\bsel\b/);
});
