// Oct 28 bug batch: L opens the library, Muse starts hidden, a library sound goes to Ideas first
// and is tried on Musical Typing before it has a track, an Ideas card drags onto the arrangement,
// the Musical Typing window moves, and the Piano Roll previews notes on the region's own
// instrument and selects notes with a rubber band.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 2, sr = 22050, hz = 220): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const ground = (page: Page) => page.locator('body').click({ position: { x: 5, y: 300 } });

/** Log every buffer source started (buffer length) to see which voice a note used. */
const logSources = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __sources: number[] };
    w.__sources = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: Parameters<AudioBufferSourceNode['start']>) {
      if (!(this.context instanceof OfflineAudioContext)) w.__sources.push(Math.round((this.buffer?.duration ?? 0) * 10) / 10);
      return start.apply(this, a);
    };
  });
const sources = (page: Page) => page.evaluate(() => (window as unknown as { __sources: number[] }).__sources);

test('Muse starts hidden; L toggles the library', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Muse chat' })).toBeHidden();
  await ground(page);
  await page.keyboard.press('l');
  await expect(page.getByTestId('library')).toBeVisible();
  await page.keyboard.press('l');
  await expect(page.getByTestId('library')).toBeHidden();
});

test('library + puts a sound in Ideas on no track; it plays on Musical Typing; R records it onto a new track', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await ground(page);
  await page.keyboard.press('l');
  const lib = page.getByTestId('library');
  await lib.getByPlaceholder('Search sounds').fill('sub bass');
  await page.getByTestId('lib-item-fs:102').getByRole('button', { name: /Add .* to Ideas/ }).click();

  await expect(page.locator('.idea')).toHaveCount(1);
  let s = await session(page);
  expect(s.tracks).toHaveLength(0);
  const src = Object.values(s.sources)[0];
  expect(src.name).toBe('Fixture Sub Bass');
  await expect(page.getByTestId('musical-typing')).toBeVisible();
  await expect(page.getByTestId('mt-instrument')).toHaveText('Fixture Sub Bass');
  await expect(page.locator('.idea-meta')).toContainText('on Musical Typing');

  // close the library (L is a note key now, so use the rail), then record a take
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await ground(page);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.waitForTimeout(200);
  await page.keyboard.down('a');
  await page.waitForTimeout(250);
  await page.keyboard.up('a');
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  s = await session(page);
  expect(s.tracks[0].name).toBe('Fixture Sub Bass');
  expect(s.tracks[0].clips[0].midi).toMatchObject({ instrument: 'Fixture Sub Bass', sample: { sourceId: src.id } });
  // the card now belongs to that track: it says so and a wire runs to the track header
  await expect(page.locator('.idea-meta')).toContainText('on Fixture Sub Bass');
  await expect(page.locator('svg.wires path')).toHaveCount(1);

  // Oct 30: undo the take (its empty track stays), try the sound again, record: the take goes
  // on that empty track, not on a second one
  const clipId = s.tracks[0].clips[0].id;
  await page.evaluate((id) => window.lattice!.runTool('delete_clip', { clip_id: id }), clipId);
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(0);
  await page.locator('.idea').click();
  await expect(page.getByTestId('mt-instrument')).toHaveText('Fixture Sub Bass');
  await ground(page);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.waitForTimeout(200);
  await page.keyboard.down('s');
  await page.waitForTimeout(250);
  await page.keyboard.up('s');
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  expect((await session(page)).tracks).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('an Ideas card drags onto the arrangement: a new track, then another copy on that track', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.lattice!.runTool('add_sound', { source_id: 'ghost', name: 'Pad idea', duration: 1 }));
  await expect(page.locator('.idea')).toHaveCount(1);
  await page.locator('.idea').dragTo(page.getByTestId('empty'));
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  let s = await session(page);
  expect(s.tracks[0]).toMatchObject({ name: 'Pad idea' });
  expect(s.tracks[0].clips[0]).toMatchObject({ sourceId: 'ghost', start: 0 });

  const row = (await page.locator('[data-track-row][data-track-id="t1"]').boundingBox())!;
  const arrange = (await page.locator('.arrange').boundingBox())!;
  const sr = await page.evaluate(() => new AudioContext().sampleRate);
  await page.locator('.idea').dragTo(page.locator('.arrange'), {
    targetPosition: { x: row.x + (3.1 * sr) / 1024 - arrange.x, y: row.y + row.height / 2 - arrange.y },
  });
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(2);
  s = await session(page);
  expect(s.tracks[0].clips[1]).toMatchObject({ sourceId: 'ghost', start: 3 }); // snapped to the beat
});

test('the Musical Typing window drags by its title bar and stays there', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ControlOrMeta+k');
  const kb = page.getByTestId('musical-typing');
  const before = (await kb.boundingBox())!;
  const title = kb.locator('header strong');
  const t = (await title.boundingBox())!;
  await page.mouse.move(t.x + 5, t.y + 5);
  await page.mouse.down();
  await page.mouse.move(t.x - 100, t.y - 150, { steps: 6 });
  await page.mouse.up();
  const after = (await kb.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(-105);
  expect(Math.round(after.y - before.y)).toBe(-155);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('ControlOrMeta+k');
  expect(Math.round((await kb.boundingBox())!.y)).toBe(Math.round(after.y)); // remembered
});

test('Piano Roll: a note click plays the region\'s sample; dragging on empty grid selects a rectangle', async ({ page }) => {
  await logSources(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'pluck.wav', mimeType: 'audio/wav', buffer: sineWav(2) });
  await expect(page.getByTestId('track-t1')).toContainText('pluck');
  const s0 = await session(page);
  const srcId = s0.tracks[0].clips[0].sourceId;
  await page.evaluate((sid) => window.lattice!.runTool('add_track', { name: 'Keys' }), srcId);
  await page.evaluate((sid) => window.lattice!.runTool('record_midi', {
    track_id: 't3', start: 0, duration: 2,
    notes: [{ pitch: 60, velocity: 100, start: 0, duration: 0.25 }, { pitch: 62, velocity: 100, start: 0.5, duration: 0.25 }, { pitch: 72, velocity: 100, start: 1, duration: 0.25 }],
    instrument: 'pluck', sample: { source_id: sid, offset: 0, duration: 2, root: 60 },
  }), srcId);
  const clip = (await page.locator('[data-track-row][data-track-id="t3"] [data-clip-container]').boundingBox())!;
  await page.mouse.dblclick(clip.x + clip.width / 2, clip.y + clip.height / 2);
  const notes = page.getByTestId('pr-note');
  await expect(notes).toHaveCount(3);

  const before = (await sources(page)).length;
  await notes.nth(0).click();
  await expect.poll(async () => (await sources(page)).slice(before)).toContain(2); // the 2 s sample, not the piano

  // rubber band over the two low notes (C4, D4), from empty grid below-right of them
  const a = (await notes.nth(0).boundingBox())!;
  const b = (await notes.nth(1).boundingBox())!;
  await page.mouse.move(b.x + b.width + 6, a.y + a.height + 6);
  await page.mouse.down();
  await page.mouse.move(a.x + 2, b.y - 6, { steps: 6 });
  await expect(page.getByTestId('pr-marquee')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[data-testid="pr-note"].sel')).toHaveCount(2);
  await expect(notes.nth(2)).not.toHaveClass(/sel/);
});

test('a sound taken off its track and put back lights its card waveform in the track colour again', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  const { id: clip, sourceId } = (await session(page)).tracks[0].clips[0];
  /** The waveform's middle bar against the card's dot (the dot is always the current colour). */
  const match = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.idea-wave')!;
      const px = c.getContext('2d')!.getImageData(0, Math.floor(c.height / 2), c.width, 1).data;
      let i = 0;
      while (i < px.length && px[i + 3] < 255) i += 4; // the first solid pixel of a bar
      const dot = getComputedStyle(document.querySelector('.idea-head .dot')!).backgroundColor;
      return dot === `rgb(${px[i]}, ${px[i + 1]}, ${px[i + 2]})`;
    });
  await expect.poll(match).toBe(true);
  await page.evaluate((id) => window.lattice!.runTool('delete_clip', { clip_id: id }), clip);
  await expect(page.locator('.idea-meta')).toContainText('not on a track');
  await expect.poll(match).toBe(true); // greyed out
  await page.evaluate((id) => window.lattice!.runTool('place_sound', { source_id: id, track_id: 't1', start: 0 }), sourceId);
  await expect(page.locator('.idea-meta')).toContainText('on hum');
  await expect.poll(match).toBe(true); // lit again
});
