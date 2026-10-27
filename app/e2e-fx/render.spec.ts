// Renders every case in $FX_OUT/cases.json through the real engine in headless Chromium.
// Input: raw little-endian float32 per channel (<signal>.L.f32 / .R.f32, or .f32 for mono).
// Output: $FX_OUT/renders/<case>.L.f32 and .R.f32, plus renders/index.json with timings.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

const OUT = process.env.FX_OUT;
const ONLY = process.env.FX_ONLY ? new RegExp(process.env.FX_ONLY) : null;

interface Case {
  name: string;
  signal: string; // base path relative to FX_OUT, without extension
  devices: { kind: string; params?: Record<string, unknown>; on?: boolean }[];
  tail?: number;
  tempo?: number;
}

function readSignal(base: string): Buffer[] {
  const mono = `${base}.f32`;
  if (fs.existsSync(mono)) return [fs.readFileSync(mono)];
  return [fs.readFileSync(`${base}.L.f32`), fs.readFileSync(`${base}.R.f32`)];
}

test('render verification cases', async ({ page }) => {
  test.skip(!OUT, 'set FX_OUT to the folder with cases.json');
  const spec = JSON.parse(fs.readFileSync(path.join(OUT!, 'cases.json'), 'utf8')) as { sampleRate: number; cases: Case[] };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/fxlab.html');
  await expect(page.locator('body[data-ready="1"]'), errors.join('\n')).toHaveCount(1);
  const renderDir = path.join(OUT!, 'renders');
  fs.mkdirSync(renderDir, { recursive: true });
  const index: Record<string, { ms: number; samples: number }> = {};
  for (const c of spec.cases) {
    if (ONLY && !ONLY.test(c.name)) continue;
    const channels = readSignal(path.join(OUT!, c.signal)).map((b) => b.toString('base64'));
    const r = await page.evaluate(
      (req) => window.fxLab!.render(req),
      { channels, devices: c.devices, sampleRate: spec.sampleRate, tail: c.tail ?? 0, tempo: c.tempo },
    );
    const bufs = r.channels.map((b64: string) => Buffer.from(b64, 'base64'));
    fs.writeFileSync(path.join(renderDir, `${c.name}.L.f32`), bufs[0]);
    fs.writeFileSync(path.join(renderDir, `${c.name}.R.f32`), bufs[1]);
    index[c.name] = { ms: Math.round(r.ms), samples: bufs[0].length / 4 };
  }
  fs.writeFileSync(path.join(renderDir, 'index.json'), JSON.stringify(index, null, 1));
  expect(errors).toEqual([]);
});
