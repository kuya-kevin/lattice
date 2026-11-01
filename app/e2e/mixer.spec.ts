// The mixer (X) and the take drawn in the arrange while it records. Asserts on session state
// (window.lattice.getSession) and on the strips' data attributes, not pixels.
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { shot } from './evidence';

const SHOTS = 'screenshots/mixer';
mkdirSync(SHOTS, { recursive: true });

const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());
const track = async (page: Page, id: string) => (await session(page)).tracks.find((t) => t.id === id)!;

function sineWav(seconds = 3, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

async function load(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
}

test('X shows a strip per track; the fader and pan knob are the Utility gain and pan', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  for (const name of ['Keys', 'Bass']) await page.evaluate((n) => window.lattice!.runTool('add_track', { name: n }), name);
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('x');
  const mixer = page.getByTestId('mixer');
  await expect(mixer).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Mixer' })).toHaveAttribute('aria-selected', 'true');
  await expect(mixer.locator('.strip')).toHaveCount(2);
  await expect(page.getByTestId('strip-t2')).toContainText('Bass');

  // the fader: keys move it, release commits set_utility_gain (adding a Utility); the track volume stays
  const fader = page.getByRole('slider', { name: 'Bass volume' });
  await fader.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown'); // 0.5 dB steps
  await expect.poll(async () => (await track(page, 't2')).devices.map((d) => [d.kind, d.params.gain])).toEqual([['utility', -3]]);
  await expect(page.getByTestId('gain-t2')).toHaveText('-3.0');
  expect((await track(page, 't2')).gainDb).toBe(0);
  // the Utility's gain set elsewhere (device panel, Muse) moves the fader
  const utility = (await track(page, 't2')).devices[0].id;
  await page.evaluate((id) => window.lattice!.runTool('set_param', { track_id: 't2', device_id: id, param: 'gain', value: -10 }), utility);
  await expect(fader).toHaveValue('-10');
  // the readout takes a typed value: Enter sets it, Escape leaves it
  await page.getByTestId('gain-t2').click();
  await page.getByTestId('gain-input-t2').fill('-8');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await track(page, 't2')).devices[0].params.gain).toBe(-8);
  await expect(page.getByTestId('gain-t2')).toHaveText('-8.0');
  await expect(fader).toHaveValue('-8');
  await page.getByTestId('gain-t2').click();
  await page.getByTestId('gain-input-t2').fill('5');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('gain-t2')).toHaveText('-8.0');
  expect((await track(page, 't2')).devices[0].params.gain).toBe(-8);

  // pan: the knob adds a Utility on first use, and then moves that Utility's Pan knob
  const knob = page.getByRole('slider', { name: 'Bass pan' });
  await knob.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await track(page, 't2')).devices.map((d) => [d.kind, d.params.pan])).toEqual([['utility', -0.2]]); // the fader's Utility
  await expect(knob).toHaveAttribute('aria-valuetext', '20% L');
  // the Utility's knob moved elsewhere (device panel, Muse) moves the mixer's knob
  await page.evaluate((id) => window.lattice!.runTool('set_param', { track_id: 't2', device_id: id, param: 'pan', value: 0.6 }), utility);
  await expect(knob).toHaveAttribute('aria-valuenow', '0.6');
  await expect(page.getByTestId('strip-t2').locator('.pan-text')).toHaveText('60R');
  await knob.dblclick(); // centre
  await expect.poll(async () => (await track(page, 't2')).devices[0].params.pan).toBe(0);
  expect((await track(page, 't2')).devices).toHaveLength(1); // still the one Utility

  // M / S and selection
  await page.getByRole('button', { name: 'Mute Keys' }).click();
  await expect.poll(async () => (await track(page, 't1')).muted).toBe(true);
  await page.getByRole('button', { name: 'Solo Bass' }).click();
  await expect.poll(async () => (await track(page, 't2')).soloed).toBe(true);
  await page.getByTestId('strip-t1').locator('.strip-name').click();
  await expect.poll(async () => (await session(page)).selection.trackId).toBe('t1');
  await shot(page, `${SHOTS}/mixer.png`);

  await page.keyboard.press('x'); // toggles it away again
  await expect(mixer).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the meters show each track’s level while it plays, with the peak held', async ({ page }) => {
  await load(page);
  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  await page.evaluate(() => window.lattice!.runTool('add_track', { name: 'Empty' }));
  await page.getByRole('button', { name: 'Mixer' }).click();
  await expect(page.getByTestId('mixer').locator('.strip')).toHaveCount(2);
  const byName = async (n: string) => (await session(page)).tracks.find((t) => t.name === n)!.id;
  const [hum, empty] = [await byName('hum'), await byName('Empty')];
  await page.getByRole('button', { name: 'Play' }).click();
  // a 220 Hz sine at 8000/32768 peaks at -12.2 dBFS; the playlist's panner takes 3 dB at centre
  const peak = async () => {
    const p = await page.getByTestId(`peak-${hum}`).getAttribute('data-peak');
    return p ? Number(p) : -Infinity;
  };
  await expect.poll(peak, { timeout: 5000 }).toBeGreaterThan(-17);
  expect(await peak()).toBeLessThan(-13);
  await expect.poll(async () => Number((await page.getByTestId(`meter-${hum}`).getAttribute('data-level'))!.split(',')[0])).toBeGreaterThan(-20);
  await expect(page.getByTestId(`meter-${empty}`)).toHaveAttribute('data-level', '-inf,-inf');
  await shot(page, `${SHOTS}/meters-playing.png`);
  await page.getByRole('button', { name: 'Stop' }).click();
  // the held peak stays until clicked
  await page.getByTestId(`peak-${hum}`).click();
  await expect(page.getByTestId(`peak-${hum}`)).toHaveAttribute('data-peak', '');
});

test('a MIDI take shows in the arrange while it records, notes appearing as played', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await expect.poll(async () => (await session(page)).tracks.length).toBe(1);
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC MIDI');
  const live = page.locator('[data-track-row][data-track-id="t1"] [data-testid="live-take"]');
  await expect(live).toBeVisible();
  const w0 = (await live.boundingBox())!.width;
  for (const k of ['a', 'd']) {
    await page.keyboard.down(k);
    await page.waitForTimeout(300);
    await page.keyboard.up(k);
  }
  await expect(live).toHaveAttribute('data-notes', '2');
  await expect(live.locator('svg.lt-notes rect')).toHaveCount(2);
  expect((await live.boundingBox())!.width).toBeGreaterThan(w0 + 10); // it grows with the playhead
  await shot(page, `${SHOTS}/midi-take-live.png`);
  await page.keyboard.press('r');
  await expect(live).toHaveCount(0); // the recorded region takes its place
  await expect(page.locator('[data-track-row][data-track-id="t1"] [data-clip-container]')).toHaveCount(1);
});

test('a mic take shows its waveform in the arrange while it records', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByTestId('lcd')).toContainText('REC');
  const preview = page.locator('[data-clip-container][data-lt-recording]');
  await expect(preview).toHaveCount(1, { timeout: 5000 });
  const id = (await session(page)).tracks[0].id;
  await expect(page.locator(`[data-track-row][data-track-id="${id}"] [data-clip-container][data-lt-recording]`)).toHaveCount(1);
  await page.waitForTimeout(800);
  await shot(page, `${SHOTS}/mic-take-live.png`);
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const clip = (await session(page)).tracks[0].clips[0];
  expect(clip.name).toMatch(/^Take/);
  expect(clip.duration).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});

test('Space ends a mic take and stops the transport, keeping the take', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: /Enable mic/ }).click();
  await expect(page.getByRole('button', { name: /Enable mic/ })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('r');
  await expect(page.getByTestId('lcd')).toContainText('REC');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('lcd')).not.toContainText('REC');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible(); // the transport stopped
  await expect.poll(async () => (await session(page)).tracks[0].clips.length).toBe(1);
  const s = await session(page);
  expect(s.transport.playing).toBe(false);
  expect(s.tracks[0].clips[0].duration).toBeGreaterThan(0.5);
  await expect(page.locator('[data-clip-container][data-lt-recording]')).toHaveCount(0);
});
