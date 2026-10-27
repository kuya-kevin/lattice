// [S3 midi] Extract MIDI in the web build: import a WAV, select its clip, extract (the dev
// middleware answers with tests/fixtures/source_prep/manifest.json), and get MIDI tracks that
// play through the built-in synth. Then quantize one with the same tool Muse uses, and undo.
import { expect, test } from '@playwright/test';

function sineWav(seconds = 2, sr = 22050, hz = 220): Buffer {
  const n = seconds * sr;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 8000), 44 + i * 2);
  return b;
}

const session = (page: import('@playwright/test').Page) => page.evaluate(async () => window.lattice!.getSession());

test('extracts MIDI tracks from a voice note and plays them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Extract MIDI' });
  await expect(button).toBeDisabled(); // nothing to extract yet

  await page.getByTestId('file-input').setInputFiles({ name: 'hum.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await expect(page.getByTestId('track-t1')).toContainText('hum');
  await page.locator('[data-track-row][data-track-id="t1"] [data-clip-container] > :first-child').click();
  await expect.poll(async () => (await session(page)).selection.clipId).toBe('c2');

  await page.getByLabel('Extract MIDI mode').selectOption('hum');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('extract-midi-result')).toContainText('melody 4, drums 3');

  const s = await session(page);
  expect(s.tracks.map((t) => t.name)).toEqual(['hum', 'hum melody', 'hum drums']); // empty bass stem skipped
  expect(s.tracks[1].clips[0]).toMatchObject({ start: 0, duration: 2, midi: { instrument: 'piano' } });
  expect(s.tracks[1].clips[0].midi!.notes).toHaveLength(4);
  expect(s.tracks[2].clips[0].midi).toMatchObject({ drum: true });
  expect(s.tempo).toBe(120);
  expect(s.key).toBe('A minor');

  // both MIDI clips render through the built-in synth and show up as regions
  const melodyId = s.tracks[1].id;
  await expect(page.locator(`[data-track-row][data-track-id="${melodyId}"] [data-clip-container]`)).toHaveCount(1);
  await expect(page.locator(`[data-track-row][data-track-id="${s.tracks[2].id}"] [data-clip-container]`)).toHaveCount(1);

  // quantize to quarter notes at 90 BPM through the tool layer (0.5 s -> 0.667 s), then undo
  const clipId = s.tracks[1].clips[0].id;
  const r = await page.evaluate(async (id) => {
    await window.lattice!.runTool('set_tempo', { bpm: 90 });
    return window.lattice!.runTool('quantize_midi', { clip_id: id, grid: '1/4' });
  }, clipId);
  expect(r.ok).toBe(true);
  await expect.poll(async () => (await session(page)).tracks[1].clips[0].midi!.notes[1].start).toBeCloseTo(0.6667, 3);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await session(page)).tracks[1].clips[0].midi!.notes[1].start).toBe(0.5);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.screenshot({ path: 'test-results/extract-midi.png' });
  expect(errors).toEqual([]);
});
