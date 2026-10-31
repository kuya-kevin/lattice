// Oct 30, second list: re-voice a MIDI region (Piano Roll and the region menu), a take tried out
// from Ideas lands on the empty track made for it, and a sample pad saves to My Sounds and comes
// back. Asserts on state (session, shelf), not pixels.
import { expect, test, type Page } from '@playwright/test';

function toneWav(seconds = 1, sr = 48000, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 9000), 44 + i * 2);
  return b;
}

const tool = (page: Page, name: string, args: object = {}) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const shelf = (page: Page) => page.evaluate(() => window.lattice!.listShelf());
const ground = (page: Page) => page.locator('body').click({ position: { x: 5, y: 300 } });

test('a MIDI region changes instrument from the Piano Roll and the region menu', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'bell.wav', mimeType: 'audio/wav', buffer: toneWav(1) });
  await expect(page.getByTestId('track-t1')).toContainText('bell');
  const bell = (await session(page)).tracks[0].clips[0].sourceId;
  await tool(page, 'add_track', { name: 'Keys' });
  await tool(page, 'record_midi', { track_id: 't3', start: 0, duration: 2, notes: [{ pitch: 60, velocity: 100, start: 0, duration: 0.25 }, { pitch: 64, velocity: 100, start: 0.5, duration: 0.25 }] });
  const region = page.locator('[data-track-row][data-track-id="t3"] [data-clip-container]');
  const box = (await region.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const picker = page.getByTestId('piano-roll').getByTestId('region-instrument');
  await expect(picker).toHaveValue('piano');
  await picker.selectOption(`src:${bell}`);
  await expect.poll(async () => (await session(page)).tracks[1].clips[0].midi).toMatchObject({ instrument: 'bell', sample: { sourceId: bell, offset: 0, root: 60 } });
  await expect(picker).toHaveValue(`src:${bell}`);

  // the region menu: back to the piano
  await region.click({ button: 'right', force: true });
  await page.getByTestId('sound-menu').getByTestId('region-instrument').selectOption('piano');
  await expect(page.getByTestId('sound-menu')).toBeHidden();
  await expect.poll(async () => (await session(page)).tracks[1].clips[0].midi).toEqual({ instrument: 'piano', notes: expect.any(Array) });
  expect((await session(page)).tracks[1].clips[0].midi!.notes).toHaveLength(2); // the notes stayed
  expect(errors).toEqual([]);
});

test('a sound tried out from Ideas records onto the empty track made for it, not a new one', async ({ page }) => {
  await page.goto('/');
  await tool(page, 'add_track', { name: 'pad' }); // selected, empty
  await ground(page);
  await page.keyboard.press('l');
  await page.getByTestId('library').getByPlaceholder('Search sounds').fill('sub bass');
  await page.getByTestId('lib-item-fs:102').getByRole('button', { name: /Add .* to Ideas/ }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.idea').click(); // try it out
  await expect(page.getByTestId('mt-instrument')).toHaveText('Fixture Sub Bass');
  await ground(page);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.waitForTimeout(200);
  await page.keyboard.down('a');
  await page.waitForTimeout(250);
  await page.keyboard.up('a');
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  expect(s.tracks.map((t) => t.name)).toEqual(['pad']);
  expect(s.tracks[0].clips[0].midi).toMatchObject({ instrument: 'Fixture Sub Bass' });
});

test('save a sample pad to My Sounds and bring it back as a new one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'kick.wav', mimeType: 'audio/wav', buffer: toneWav(0.3, 48000, 60) });
  await expect(page.getByTestId('track-t1')).toContainText('kick');
  await expect.poll(async () => (await tool(page, 'measure_track', { track_id: 't1' })).ok).toBe(true); // audio loaded
  const kick = (await session(page)).tracks[0].clips[0].sourceId;
  const kit = ((await tool(page, 'create_kit', { name: 'Lo-fi' })).result as { kit_id: string }).kit_id;
  await tool(page, 'set_pad', { kit_id: kit, pad: 6, source_id: kick });

  const card = page.locator(`[data-kit="${kit}"]`);
  await card.hover();
  await card.getByRole('button', { name: 'Save Lo-fi to My Sounds' }).click();
  await expect(page.getByTestId('notice')).toContainText('Saved sample pad "Lo-fi" to My Sounds');
  await expect.poll(async () => (await shelf(page)).map((i) => [i.shelf, i.name, i.from])).toEqual([['mine', 'Lo-fi', 'kit']]);
  const item = (await shelf(page))[0];

  await page.getByTestId('notice').getByRole('button', { name: 'Show' }).click();
  const row = page.getByTestId(`shelf-item-${item.id}`);
  await expect(row).toContainText('Sample pad · 1 sounds');
  await row.getByRole('button', { name: 'Add Lo-fi to Ideas' }).click();
  await expect.poll(async () => Object.keys((await session(page)).kits ?? {}).length).toBe(2);
  const back = Object.values((await session(page)).kits!).find((k) => k.id !== kit)!;
  expect(back).toMatchObject({ name: 'Lo-fi' });
  expect(back.pads[6]).toMatchObject({ label: 'kick', sample: { root: 36 } });
  expect(back.pads[6].sample!.sourceId).not.toBe(kick); // its own copy of the sound
  expect(errors).toEqual([]);
});
