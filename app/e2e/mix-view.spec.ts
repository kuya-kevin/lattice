// B18 dry / wet in the web build: the control-bar A/B switch bypasses every effect without
// changing the session's devices (loudness-matched), and Stems exports a dry and a wet set, one
// WAV per track, where the dry stems are the source audio sample for sample.
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';

function toneWav(seconds: number, hz: number, amp = 9000, sr = 48000): Buffer {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * amp), 44 + i * 2);
  return b;
}

/** Our stems are 32-bit float WAV (encodeWav): channels, rate and the samples of channel 0. */
function readFloatWav(bytes: Buffer) {
  const ch = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const n = bytes.readUInt32LE(40) / (4 * ch);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = bytes.readFloatLE(44 + i * ch * 4);
  return { ch, sampleRate, n, left };
}

const tool = (page: Page, name: string, args: object) => page.evaluate(([n, a]) => window.lattice!.runTool(n as string, a as Record<string, unknown>), [name, args] as const);
const session = (page: Page) => page.evaluate(() => window.lattice!.getSession());

async function twoTracks(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'Lead.wav', mimeType: 'audio/wav', buffer: toneWav(1, 440) },
    { name: 'Bass: low.wav', mimeType: 'audio/wav', buffer: toneWav(1.5, 110) },
  ]);
  await expect.poll(async () => (await session(page)).tracks.length).toBe(2);
  for (const t of ['t1', 't3']) await expect.poll(async () => (await tool(page, 'measure_track', { track_id: t })).ok).toBe(true); // audio loaded
  // a loud wet chain on the lead (saturation and a big reverb), a pan on the bass
  await tool(page, 'insert_device', { track_id: 't1', device: 'reverb', params: { decay: 2.5, mix: 60 } });
  await tool(page, 'insert_device', { track_id: 't1', device: 'utility', params: { gain: 9 } });
  await tool(page, 'insert_device', { track_id: 't3', device: 'eq', params: { b1_gain: 6 } });
}

test('the Dry / Wet switch bypasses every effect without changing the devices, loudness-matched', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await twoTracks(page);
  const before = await session(page);
  const toggle = page.getByRole('button', { name: 'Dry', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  await expect.poll(async () => (await session(page)).mixView?.mode).toBe('dry');
  const dry = await session(page);
  expect(dry.tracks.map((t) => t.devices)).toEqual(before.tracks.map((t) => t.devices)); // devices unchanged
  expect(dry.tracks.map((t) => t.gainDb)).toEqual(before.tracks.map((t) => t.gainDb));
  expect(dry.mixView).toMatchObject({ mode: 'dry', matchLoudness: true });
  // the utility's +9 dB stays (gain is balance); the reverb (60 % wet) and the eq boost change the
  // loudness, and the dry mix gets the difference
  expect(Math.abs(dry.mixView!.dryGainDb)).toBeGreaterThan(0.5);
  const again = (await tool(page, 'set_mix_view', { mode: 'dry' })).result as { dry_gain_db: number; wet_loudness_db: number; dry_loudness_db: number };
  expect(again.dry_gain_db).toBe(dry.mixView!.dryGainDb);
  expect(again.dry_gain_db).toBeCloseTo(again.wet_loudness_db - again.dry_loudness_db, 0);
  await expect(toggle).toHaveAttribute('data-match-db', String(dry.mixView!.dryGainDb));
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // a listening switch is not an edit: undo takes back the last device, not the switch
  await tool(page, 'undo', {});
  expect((await session(page)).mixView?.mode).toBe('dry');
  await tool(page, 'redo', {});

  await toggle.click();
  await expect.poll(async () => (await session(page)).mixView?.mode).toBe('wet');
  expect((await session(page)).tracks.map((t) => t.devices)).toEqual(before.tracks.map((t) => t.devices));
  expect(errors).toEqual([]);
});

test('Stems exports one WAV per track per set; dry stems are the source audio', async ({ page }) => {
  await twoTracks(page);
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByTestId('export-stems').click();
  await expect.poll(() => downloads.length).toBe(4);
  const files = new Map<string, Buffer>();
  for (const d of downloads) files.set(d.suggestedFilename(), readFileSync((await d.path())!));
  expect([...files.keys()].sort()).toEqual([
    'Lattice stems - dry - 01 Lead.wav', 'Lattice stems - dry - 02 Bass_ low.wav',
    'Lattice stems - wet - 01 Lead.wav', 'Lattice stems - wet - 02 Bass_ low.wav',
  ]);

  const dryLead = readFloatWav(files.get('Lattice stems - dry - 01 Lead.wav')!);
  const dryBass = readFloatWav(files.get('Lattice stems - dry - 02 Bass_ low.wav')!);
  const wetLead = readFloatWav(files.get('Lattice stems - wet - 01 Lead.wav')!);
  expect(dryLead.ch).toBe(2);
  expect(dryLead.n).toBe(dryBass.n); // a set lines up: same length, from the session start
  expect(dryLead.n).toBe(Math.round(1.5 * dryLead.sampleRate));
  expect(wetLead.n).toBeGreaterThan(dryLead.n); // the reverb tail rings past the last region

  // the dry stems are the decoded source audio (at the rate the app decoded it), sample for sample
  const decoded = async (wav: Buffer, rate: number) =>
    page.evaluate(async ([b64, sr]) => {
      const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
      const buf = await new OfflineAudioContext(1, 1, sr as number).decodeAudioData(bytes.buffer);
      return Array.from(buf.getChannelData(0));
    }, [wav.toString('base64'), rate] as const);
  for (const [stem, src, utilityDb] of [[dryLead, toneWav(1, 440), 9], [dryBass, toneWav(1.5, 110), 0]] as const) {
    const ref = await decoded(src, stem.sampleRate);
    const k = Math.pow(10, utilityDb / 20); // dry keeps the utility's gain (the balance)
    let worst = 0;
    for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(stem.left[i] - ref[i] * k));
    expect(worst).toBeLessThan(1e-4);
    for (let i = ref.length; i < stem.n; i++) expect(stem.left[i]).toBe(0);
  }
});
