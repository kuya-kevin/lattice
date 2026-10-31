// Musical Typing (⌘K): letter keys play notes live; single-letter shortcuts pause while it is on
// (except R: Record, which then records a MIDI take).
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { shot, evidenceVideo } from './evidence';

test.use({ video: evidenceVideo });

const SHOTS = 'screenshots/musical-typing';
mkdirSync(SHOTS, { recursive: true });

function sineWav(seconds = 6, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const notes = (page: Page) => page.evaluate(() => window.__musicalTypingLog!.map((e) => `${e.type} ${e.pitch} ${e.velocity}`));

async function load(page: Page) {
  await page.addInitScript(() => (window.__musicalTypingLog = []));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } }); // focus nothing in particular
}

const toggle = (page: Page) => page.getByRole('button', { name: 'Musical Typing', exact: true });
const keyboard = (page: Page) => page.getByTestId('musical-typing');
const pianoKey = (page: Page, k: string) => page.locator(`.mt-key[data-key="${k}"]`);

// keep each test's video under a readable name next to the screenshots
test.afterEach(async ({ page }, info) => {
  const video = page.video();
  await page.close();
  await video?.saveAs(`${SHOTS}/${info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.webm`);
});

test('toggles with the button and with Cmd/Ctrl-K', async ({ page }) => {
  await load(page);
  await expect(keyboard(page)).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(keyboard(page)).toBeVisible();
  await expect(keyboard(page)).toContainText('C4–F5');
  await toggle(page).click();
  await expect(keyboard(page)).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(keyboard(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(keyboard(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('A W S play a chord: keys light, note-on and note-off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await load(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.down('a');
  await page.keyboard.down('w');
  await page.keyboard.down('s');
  await page.keyboard.down('a'); // auto-repeat style second keydown: ignored (Playwright sets repeat)
  for (const k of ['A', 'W', 'S']) await expect(pianoKey(page, k)).toHaveAttribute('data-active', 'true');
  await expect(pianoKey(page, 'D')).toHaveAttribute('data-active', 'false');
  await expect(keyboard(page)).toHaveAttribute('data-voices', '3');
  await shot(page, `${SHOTS}/chord-held.png`);
  await shot(keyboard(page), `${SHOTS}/keyboard-chord.png`);
  await page.keyboard.up('w');
  await expect(pianoKey(page, 'W')).toHaveAttribute('data-active', 'false');
  await page.keyboard.up('a');
  await page.keyboard.up('s');
  await expect(keyboard(page)).toHaveAttribute('data-voices', '0');
  expect(await notes(page)).toEqual(['on 60 100', 'on 61 100', 'on 62 100', 'off 61 100', 'off 60 100', 'off 62 100']);

  // X = octave up, V = velocity up; Z/C back down
  await page.keyboard.press('x');
  await page.keyboard.press('v');
  await expect(keyboard(page)).toContainText('C5–F6');
  await expect(page.getByTestId('mt-velocity')).toHaveText('120');
  await page.keyboard.press('a');
  expect((await notes(page)).slice(-2)).toEqual(['on 72 120', 'off 72 120']);
  await page.keyboard.press('z');
  await page.keyboard.press('c');
  await expect(keyboard(page)).toContainText('C4–F5');
  await expect(page.getByTestId('mt-velocity')).toHaveText('100');

  // Tab sustains: the note rings after key-up until Tab is let go
  await page.keyboard.down('Tab');
  await page.keyboard.press('h');
  await expect(pianoKey(page, 'H')).toHaveAttribute('data-active', 'true');
  await page.keyboard.up('Tab');
  await expect(pianoKey(page, 'H')).toHaveAttribute('data-active', 'false');
  expect((await notes(page)).slice(-2)).toEqual(['on 69 100', 'off 69 100']);
  expect(errors).toEqual([]); // the voices played through track 1's effect chain without errors
});

test('K C O pause while on and work again when off; Space still plays', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('k');
  await page.keyboard.press('c');
  await page.keyboard.press('o'); // O is C# here, not the library
  await page.waitForTimeout(400);
  await expect(page.getByTestId('lcd')).not.toContainText('REC');
  expect((await session(page)).metronome.on).toBe(false);
  await expect(page.getByRole('button', { name: 'Cycle' })).not.toHaveClass(/\bon\b/);
  await expect(page.getByRole('button', { name: 'Library', exact: true }).first()).not.toHaveClass(/\bon\b/);
  // K played C5, C stepped the velocity down, O played C#5
  expect(await notes(page)).toEqual(['on 72 100', 'off 72 100', 'on 73 80', 'off 73 80']);

  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.keyboard.press('s'); // play along
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await shot(page, `${SHOTS}/shortcuts-paused.png`);

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('k');
  expect((await session(page)).metronome.on).toBe(true);
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Cycle' })).toHaveClass(/\bon\b/);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC', { timeout: 3000 });
  await page.waitForTimeout(400);
  await page.keyboard.press('r');
  await expect.poll(async () => (await session(page)).tracks.flatMap((t) => t.clips).length).toBe(2);
});

test('typing in the chat box with the mode on types text, no notes', async ({ page }) => {
  await load(page);
  await page.keyboard.press('ControlOrMeta+k');
  const chat = page.getByPlaceholder(/trim the vocal/);
  await chat.focus();
  await page.keyboard.type('ask sd');
  await expect(chat).toHaveValue('ask sd');
  expect(await notes(page)).toEqual([]);
  await expect(keyboard(page)).toHaveAttribute('data-voices', '0');
  await shot(page, `${SHOTS}/chat-typing.png`);
});

test('R records a MIDI take while musical typing is on; Space also ends it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await page.getByRole('button', { name: 'Track', exact: true }).click(); // an empty track to record on
  await page.getByTestId('track-t3').locator('.track-num').click();
  await expect.poll(async () => (await session(page)).selection.trackId).toBe('t3');
  await page.locator('body').click({ position: { x: 5, y: 600 } });

  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible(); // the transport rolls
  await page.waitForTimeout(250);
  for (const k of ['a', 'd', 'g']) {
    await page.keyboard.down(k); // C4, E4, G4
    await page.waitForTimeout(300);
    await page.keyboard.up(k);
    await page.waitForTimeout(100);
  }
  await shot(page, `${SHOTS}/midi-recording.png`);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).not.toContainText('REC');

  await expect.poll(async () => (await session(page)).tracks.find((t) => t.id === 't3')!.clips.length).toBe(1);
  let s = await session(page);
  const clip = s.tracks.find((t) => t.id === 't3')!.clips[0];
  expect(clip.name).toBe('MIDI take 1');
  expect(clip.start).toBe(0);
  expect(clip.duration).toBeGreaterThan(1);
  const played = clip.midi!.notes;
  expect(played.map((n) => n.pitch)).toEqual([60, 64, 67]);
  expect(played.every((n) => n.velocity === 100 && n.duration > 0.2 && n.duration < 0.5)).toBe(true);
  expect(played[1].start - played[0].start).toBeGreaterThan(0.3); // in the order and spacing played
  expect(s.selection.clipId).toBe(clip.id);
  await expect(page.locator('[data-track-row][data-track-id="t3"] [data-clip-container]')).toHaveCount(1);
  await shot(page, `${SHOTS}/midi-take-recorded.png`);

  // a second take, ended with Space instead of R
  await page.keyboard.press('Enter'); // back to the start
  await page.keyboard.press('.'); // bar 2
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.keyboard.down('j'); // B4
  await page.waitForTimeout(300);
  await page.keyboard.up('j');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('lcd')).not.toContainText('REC');
  await expect.poll(async () => (await session(page)).tracks.find((t) => t.id === 't3')!.clips.length).toBe(2);
  s = await session(page);
  const second = s.tracks.find((t) => t.id === 't3')!.clips[1];
  expect(second.start).toBe(2); // bar 2 at 120 BPM
  expect(second.midi!.notes.map((n) => n.pitch)).toEqual([71]);

  // undo removes the take; nothing threw while recording and playing back through the synth
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await session(page)).tracks.find((t) => t.id === 't3')!.clips.length).toBe(1);
  expect(errors).toEqual([]);
});

// ─── the selected audio clip is the instrument (a sampler); A plays it at its own pitch ───

/** Log every buffer source started (rate and buffer length) to see which voice a note used. */
const logSources = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __sources: { rate: number; seconds: number; offline: boolean }[] };
    w.__sources = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: Parameters<AudioBufferSourceNode['start']>) {
      w.__sources.push({
        rate: Math.round(this.playbackRate.value * 1000) / 1000,
        seconds: Math.round((this.buffer?.duration ?? 0) * 10) / 10,
        offline: this.context instanceof OfflineAudioContext,
      });
      return start.apply(this, a);
    };
  });
const sources = (page: Page) => page.evaluate(() => (window as unknown as { __sources: { rate: number; seconds: number; offline: boolean }[] }).__sources);
const clipIn = (page: Page, trackId: string) => page.locator(`[data-track-row][data-track-id="${trackId}"] [data-clip-container]`);

test('the selected audio clip plays as a sampler; MIDI or nothing selected is the piano', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await logSources(page);
  await load(page);
  await clipIn(page, 't1').locator('> :first-child').click();
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');
  const name = (await session(page)).tracks[0].clips[0].name;

  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('mt-instrument')).toHaveText(name);
  await page.evaluate(() => ((window as unknown as { __sources: unknown[] }).__sources.length = 0));
  await page.keyboard.down('a'); // C4: the sample at its own pitch
  await page.keyboard.down('k'); // C5: an octave up
  await page.keyboard.down('g'); // G4: a fifth up
  await expect(keyboard(page)).toHaveAttribute('data-voices', '3');
  await shot(page, `${SHOTS}/sampler-chord.png`);
  await shot(keyboard(page), `${SHOTS}/sampler-header.png`);
  for (const k of ['a', 'k', 'g']) await page.keyboard.up(k);
  await expect(keyboard(page)).toHaveAttribute('data-voices', '0');
  expect(await sources(page)).toEqual([
    { rate: 1, seconds: 6, offline: false },
    { rate: 2, seconds: 6, offline: false },
    { rate: 1.498, seconds: 6, offline: false },
  ]);

  // an empty track selected: the piano (oscillators, no buffer sources)
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await page.getByTestId('track-t3').locator('.track-num').click();
  await expect(page.getByTestId('mt-instrument')).toHaveText('Piano');
  await page.evaluate(() => ((window as unknown as { __sources: unknown[] }).__sources.length = 0));
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('a');
  expect((await notes(page)).slice(-2)).toEqual(['on 60 100', 'off 60 100']);
  expect(await sources(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a MIDI take recorded with a sample plays back with that sample', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await logSources(page);
  await load(page);
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await page.getByTestId('track-t3').getByRole('button', { name: 'R', exact: true }).click(); // record onto t3
  await expect.poll(async () => (await session(page)).tracks.find((t) => t.id === 't3')!.armed).toBe(true);
  await clipIn(page, 't1').locator('> :first-child').click(); // ...with t1's audio as the instrument
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');
  const audio = (await session(page)).tracks[0].clips[0];
  await page.locator('body').click({ position: { x: 5, y: 600 } });

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('mt-instrument')).toHaveText(audio.name);
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  await page.waitForTimeout(200);
  for (const k of ['a', 'g', 'k']) {
    await page.keyboard.down(k);
    await page.waitForTimeout(250);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).not.toContainText('REC');

  await expect.poll(async () => (await session(page)).tracks.find((t) => t.id === 't3')!.clips.length).toBe(1);
  const s = await session(page);
  const take = s.tracks.find((t) => t.id === 't3')!.clips[0];
  expect(take.midi!.notes.map((n) => n.pitch)).toEqual([60, 67, 72]);
  expect(take.midi!.instrument).toBe(audio.name);
  expect(take.midi!.sample).toEqual({ sourceId: audio.sourceId, offset: audio.offset, duration: audio.duration, root: 60 });
  await expect(clipIn(page, 't3')).toHaveCount(1); // the sampler render exists, so the clip draws
  // ...and it was rendered offline from the sample (6 s source), repitched per note
  const offline = (await sources(page)).filter((x) => x.offline);
  expect(offline).toEqual([
    { rate: 1, seconds: 6, offline: true },
    { rate: 1.498, seconds: 6, offline: true },
    { rate: 2, seconds: 6, offline: true },
  ]);
  // the take is selected now and keeps the sample as the instrument
  await expect(page.getByTestId('mt-instrument')).toHaveText(audio.name);
  await shot(page, `${SHOTS}/sampler-take-recorded.png`);

  // play it back
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  expect(errors).toEqual([]);
});
