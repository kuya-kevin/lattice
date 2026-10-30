// B14 "Muse talks back" (web build, mock voice: no model download): the speaker toggle in the
// prompt bar is the set_voice_reply tool; when on, Muse's reply is spoken (the mock voice just
// takes time), playback pauses while it speaks, push-to-talk cuts it off, and it never speaks
// while a track records. window.latticeVoice reports what the voice is doing.
import { expect, test, type Page } from '@playwright/test';

function sineWav(seconds = 20, sr = 22050): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 6000), 44 + i * 2);
  return b;
}

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const speaking = (page: Page) => page.evaluate(() => window.latticeVoice!.speaking());
const spoken = (page: Page) => page.evaluate(() => window.latticeVoice!.spoken());
const toggle = (page: Page) => page.getByRole('button', { name: 'Speak Muse’s replies' });

async function load(page: Page, msPerChar = 20) {
  await page.goto('/');
  await page.evaluate((ms) => (window.latticeVoice!.mockMsPerChar = ms), msPerChar);
  await page.getByTestId('file-input').setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
}

async function ask(page: Page, text = 'list the tracks') {
  await page.getByLabel('Message Muse').fill(text);
  await page.getByLabel('Message Muse').press('Enter');
}

test('the toggle is off by default and is the set_voice_reply tool', async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => window.latticeVoice!.kind)).toBe('mock');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  expect((await session(page)).voiceReply).toBeFalsy();

  await ask(page);
  await expect(page.locator('.msg.muse').last()).toContainText('offline mock');
  await page.waitForTimeout(300);
  expect(await spoken(page)).toEqual([]); // off: nothing said

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  expect((await session(page)).voiceReply).toBe(true);

  // Muse (or anyone) calling the tool moves the toggle too
  await page.evaluate(() => window.lattice!.runTool('set_voice_reply', { on: false }));
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('when on, the reply is spoken (first sentence of a long one) and playback pauses meanwhile', async ({ page }) => {
  await load(page, 25);
  await toggle(page).click();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await session(page)).transport.playing).toBe(true);

  await ask(page);
  await expect.poll(() => speaking(page)).toBe(true);
  await expect(page.getByTestId('voice-status')).toHaveText(/Muse is speaking/);
  expect((await session(page)).transport.playing).toBe(false); // paused while Muse speaks
  const said = await spoken(page);
  expect(said).toHaveLength(1);
  expect(said[0]).toMatch(/^\(offline mock, no Muse in the browser build\) Session: Tempo one hundred twenty bee pee em/);
  expect(said[0].length).toBeLessThan(200); // the mock's reply is long: first sentence only

  await expect.poll(() => speaking(page), { timeout: 10_000 }).toBe(false);
  await expect(page.getByTestId('voice-status')).toBeHidden();
  await expect.poll(async () => (await session(page)).transport.playing).toBe(true); // playback picks up again
});

test('pressing push-to-talk stops the speech', async ({ page }) => {
  await load(page, 400); // a long speech
  await toggle(page).click();
  await ask(page);
  await expect.poll(() => speaking(page)).toBe(true);
  await page.locator('body').click({ position: { x: 5, y: 600 } }); // out of the prompt box
  await page.keyboard.down('Backquote');
  await expect.poll(() => speaking(page)).toBe(false);
  await expect(page.getByTestId('ptt-status')).toHaveText(/Listening/);
  await page.keyboard.up('Backquote');
});

test('never speaks while a track is recording', async ({ page }) => {
  await page.goto('/');
  await toggle(page).click();
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByTestId('lcd')).toContainText('REC');

  await ask(page);
  await expect(page.locator('.msg.muse').last()).toContainText('offline mock');
  await page.waitForTimeout(300);
  expect(await spoken(page)).toEqual([]);
  expect(await speaking(page)).toBe(false);
  await page.getByRole('button', { name: 'Record' }).click();
});

test('while the voice model downloads, the prompt bar says so; a failed load says why', async ({ page }) => {
  await load(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.latticeVoice!.mockStatus({ state: 'loading', progress: 42 }));
  await expect(page.getByTestId('voice-loading')).toHaveText(/Loading Muse's voice… 42%/);
  await page.evaluate(() => window.latticeVoice!.mockStatus({ state: 'loading', progress: 100 }));
  await expect(page.getByTestId('voice-loading')).toHaveText("Starting Muse's voice…");
  await page.evaluate(() => window.latticeVoice!.mockStatus({ state: 'error', error: 'network down' }));
  await expect(page.getByTestId('voice-loading')).toHaveText(/didn't load: network down/);
  await page.evaluate(() => window.latticeVoice!.mockStatus({ state: 'ready' }));
  await expect(page.getByTestId('voice-loading')).toHaveCount(0);
  // nothing to say about the model while the voice is off
  await page.evaluate(() => window.latticeVoice!.mockStatus({ state: 'loading', progress: 5 }));
  await toggle(page).click();
  await expect(page.getByTestId('voice-loading')).toHaveCount(0);
});
