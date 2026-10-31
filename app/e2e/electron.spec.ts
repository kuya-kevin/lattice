// Launches the built Electron app (run `npm run build` first) and checks the IPC bridge:
// import -> main-process session -> renderer. Sends no chat, so no Meta calls.
// Most tests share one app (a launch is ~0.5-1 s) and start from an empty session; the relaunch
// test has its own userData. Renderer-only behaviour (one-shots and Space, trims) is covered by
// the web specs (playback, trim-twice, audio-editor).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electronApp, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EVIDENCE } from './evidence';

test.skip(!existsSync('dist-electron/main.cjs') || !existsSync('dist/index.html'), 'run `npm run build` first');

const freshUserData = () => mkdtempSync(join(tmpdir(), 'lattice-userdata-'));
/** Launch with its own userData folder (B11 autosaves there), fresh unless one is given. */
const electron = {
  launch: (opts: Parameters<typeof electronApp.launch>[0] & { userData?: string }) => {
    const { userData = freshUserData(), env, ...rest } = opts;
    return electronApp.launch({ ...rest, env: { ...(env ?? process.env), LATTICE_USER_DATA: userData } as Record<string, string> });
  },
};

function wavBytes(n: number, sample: (i: number) => number, sr = 22050): Buffer {
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(sample(i), 44 + i * 2);
  return wav;
}
const sineWav = (seconds: number) => wavBytes(Math.round(seconds * 22050), (i) => Math.round(Math.sin((2 * Math.PI * 220 * i) / 22050) * 6000));

test.describe('one shared app', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication;
  let page: Page;
  const session = () => page.evaluate(() => window.lattice!.getSession());
  const tool = (name: string, args: object = {}) => page.evaluate(([nm, a]) => window.lattice!.runTool(nm as string, a as Record<string, unknown>), [name, args] as const);

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '.'],
      env: {
        ...process.env,
        LATTICE_DATA_DIR: 'tests/fixtures/library',
        LATTICE_ENGINEER_MOCK: '1',
        LATTICE_SIDECAR_WORK: mkdtempSync(join(tmpdir(), 'lattice-sidecar-')),
        LATTICE_STT_MOCK: 'make the drums punchier',
      } as Record<string, string>,
    });
    page = await app.firstWindow();
  });
  test.afterAll(async () => app?.close());
  test.beforeEach(async () => {
    if ((await session()).tracks.length) await tool('new_session');
    await expect.poll(async () => (await session()).tracks.length).toBe(0);
  });

  test('electron app imports audio through the main-process session', async () => {
    await expect(page.locator('.chat header')).toHaveText('Muse'); // no "offline mock" badge
    expect(await page.evaluate(() => window.lattice?.mode)).toBe('electron');
    await page.getByTestId('file-input').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: wavBytes(22050, () => 0) });
    await expect.poll(async () => (await session()).tracks.length).toBe(1);
    const t = (await session()).tracks[0];
    await expect(page.getByTestId(`track-${t.id}`)).toContainText('silence');
    expect(t.clips[0]).toMatchObject({ id: expect.stringMatching(/^c\d+$/), duration: 1 });
  });

  /** What the window really shows (Playwright's own screenshot misreads a page-zoomed window). */
  async function shoot(path: string) {
    if (!EVIDENCE) return;
    await new Promise((r) => setTimeout(r, 300)); // let the zoomed layout paint
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(png, 'base64'));
  }

  /** After a zoom the layout fills the new CSS viewport: the floating chrome hugs its edges. */
  async function expectChromeAtEdges() {
    const m = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, zoom: document.querySelector('.zoombar')!.getBoundingClientRect() }));
    expect(Math.abs(m.w - 16 - m.zoom.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.h - 16 - m.zoom.bottom)).toBeLessThanOrEqual(2);
  }

  test('electron: the bottom-right zoom scales the whole window, not just the timeline', async () => {
    const zoom = page.getByTestId('window-zoom');
    await expect(zoom).toHaveText('100%');
    const timelinePct = () => page.getByRole('group', { name: 'Timeline zoom' }).locator('.zoom-pct').allTextContents();
    const timeline0 = await timelinePct();
    const wide = await page.evaluate(() => window.innerWidth); // CSS px: shrinks as the page zooms in
    await page.getByRole('button', { name: 'Zoom in window' }).click();
    await page.getByRole('button', { name: 'Zoom in window' }).click();
    await expect(zoom).toHaveText('125%');
    expect(await page.evaluate(() => window.lattice!.getZoom!())).toBeCloseTo(1.25);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(wide);
    await shoot('screenshots/window-zoom/zoom-125.png');
    await expectChromeAtEdges();
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out window' }).click();
    await expect(zoom).toHaveText('80%');
    await shoot('screenshots/window-zoom/zoom-80.png');
    await expectChromeAtEdges();
    expect(await timelinePct()).toEqual(timeline0); // the timeline's own zoom (tracks toolbar) is separate
    await zoom.click(); // back to 100 %
    await expect(zoom).toHaveText('100%');
  });

  test('electron serves the sound library over IPC (fixture data dir)', async () => {
    const items = await page.evaluate(() => window.lattice!.listLibrary());
    expect(items.map((i) => i.id)).toContain('fs:103');
    expect(items[0]).not.toHaveProperty('file');
    const bytes = await page.evaluate(async () => (await window.lattice!.loadLibraryAudio('fs:103')).byteLength);
    expect(bytes).toBe(44 + 0.4 * 8000 * 2);
    await expect(page.evaluate(() => window.lattice!.loadLibraryAudio('../../etc/passwd'))).rejects.toThrow();
  });

  test('electron: measure_track renders in the window over IPC (B9); cleanup swaps in a processed take (B3, mock sidecar)', async () => {
    let seed = 3;
    const noise = wavBytes(2 * 22050, () => Math.round((((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1) * 8000));
    await page.getByTestId('file-input').setInputFiles({ name: 'noise.wav', mimeType: 'audio/wav', buffer: noise });
    await expect.poll(async () => (await session()).tracks.length).toBe(1);
    const id = (await session()).tracks[0].id;
    await expect(page.getByTestId(`track-${id}`)).toContainText('noise');

    await expect.poll(async () => (await tool('measure_track', { track_id: id })).ok).toBe(true);
    await tool('insert_device', { track_id: id, device: 'eq', params: { lp_on: true, lp_freq: 4000 } });
    const m = await tool('measure_track', { track_id: id });
    expect((m.result as { what_the_fx_do: string[] }).what_the_fx_do.join('\n')).toMatch(/brightness -\d+%/);

    const original = (await session()).tracks[0].clips[0].sourceId;
    const r = await tool('cleanup_noise', { track_id: id });
    expect(r).toMatchObject({ ok: true, result: { method: expect.stringMatching(/mock/) } });
    const cleaned = (r.result as { new_source_id: string }).new_source_id;
    expect((await session()).tracks[0].clips[0].sourceId).toBe(cleaned);
    await expect.poll(() => page.evaluate(() => (window as unknown as { latticeDebug: { audioIds(): string[] } }).latticeDebug.audioIds())).toContain(cleaned);
    await tool('undo');
    expect((await session()).tracks[0].clips[0].sourceId).toBe(original);
  });

  test('electron: push-to-talk clips reach the transcriber over IPC (B2, $LATTICE_STT_MOCK, no Meta call)', async () => {
    // only the transcription hop: holding ` here would send the text to live Muse
    const r = await page.evaluate(() => window.lattice!.transcribe(new Uint8Array(44).buffer));
    expect(r).toEqual({ ok: true, text: 'make the drums punchier' });
    await expect(page.getByRole('button', { name: 'Hold to talk to Muse' })).toBeVisible();
  });

  test('electron: R records a vocal on the first press (the mic opens, then the take starts)', async () => {
    await tool('add_track', { name: 'Vox' });
    await expect.poll(async () => (await session()).tracks.length).toBe(1);
    const id = (await session()).tracks[0].id;
    await page.getByTestId(`track-${id}`).locator('.track-num').click();
    await page.locator('body').click({ position: { x: 5, y: 600 } });
    await page.keyboard.press('r');
    await expect(page.getByTestId('lcd')).toContainText('REC', { timeout: 5000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press('r');
    await expect.poll(async () => (await session()).tracks[0].clips.length).toBe(1);
  });
});

test('electron: the session and its audio come back after a relaunch; versions too (B11)', async () => {
  const userData = freshUserData();
  const wav = sineWav(1);
  const onDisk = join(mkdtempSync(join(tmpdir(), 'lattice-import-')), 'vox.wav');
  writeFileSync(onDisk, wav);

  let app = await electron.launch({ args: ['.'], userData });
  let page = await app.firstWindow();
  const session = () => page.evaluate(() => window.lattice!.getSession());
  const audioIds = () => page.evaluate(() => ((window as any).latticeDebug?.audioIds() ?? []) as string[]);
  const deviceCount = async () => (await session()).tracks.flatMap((t) => t.devices).length;
  await page.getByTestId('file-input').setInputFiles(onDisk); // kept by path
  await page.getByTestId('file-input').setInputFiles({ name: 'synth.wav', mimeType: 'audio/wav', buffer: wav }); // no path: kept as bytes
  await expect.poll(async () => (await session()).tracks.length).toBe(2);
  await page.getByTestId('device-panel').getByTestId('fx-add').selectOption('eq');
  await expect.poll(deviceCount).toBe(1);
  await page.getByTestId('versions-open').click();
  await page.getByTestId('version-name').fill('one eq');
  await page.getByTestId('version-name').press('Enter');
  await expect(page.locator('.version-row', { hasText: 'one eq' })).toHaveCount(1);
  const saved = await session();
  await page.getByTestId('device-panel').getByTestId('fx-add').selectOption('comp');
  await expect.poll(deviceCount).toBe(2);
  const before = await session();
  const autosaved = () => JSON.parse(readFileSync(join(userData, 'project', 'session.json'), 'utf8')).session.tracks;
  await expect.poll(() => { try { return autosaved(); } catch { return null; } }).toEqual(before.tracks); // 500 ms debounce
  await app.close();
  const refs = Object.values(JSON.parse(readFileSync(join(userData, 'project', 'audio', 'refs.json'), 'utf8')).refs);
  expect(refs).toEqual(expect.arrayContaining([{ path: onDisk }, { file: expect.stringMatching(/\.audio$/) }]));

  app = await electron.launch({ args: ['.'], userData });
  page = await app.firstWindow();
  await expect(page.getByTestId('versions-open')).toBeVisible(); // renderer is up
  await expect.poll(async () => (await session()).tracks).toEqual(before.tracks);
  await expect.poll(async () => (await audioIds()).sort()).toEqual(Object.keys(before.sources).sort());
  await page.getByTestId('versions-open').click();
  await page.locator('.version-row', { hasText: 'one eq' }).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(async () => (await session()).tracks).toEqual(saved.tracks);
  await expect(page.locator('.error')).toHaveCount(0);
  await app.close();
});
