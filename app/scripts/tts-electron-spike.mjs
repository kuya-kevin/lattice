// B14 spike, Electron half: launch the built app (npm run build first), speak the five phrases
// through window.latticeVoice (MMS-TTS in the renderer's Web Worker), and print the voice log:
// model load and time per phrase. Uses a persistent userData folder under out/ (git-ignored) so
// a second run shows the cached load. TTS_DEVICE=wasm|webgpu|auto (default auto: WebGPU if there).
// Run from app/: node scripts/tts-electron-spike.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const userData = join(import.meta.dirname, '..', '..', 'out', 'tts-spike', 'electron-userdata');
mkdirSync(userData, { recursive: true });
const PHRASES = [
  'Panned the double 30 percent right.',
  'Moved the vocal up two bars.',
  'Brighter how: raise the top end, or cut the low mids?',
  'Quantized the drums to sixteenths.',
  'Added a compressor to the bass.',
];

const app = await electron.launch({ args: ['.'], env: { ...process.env, LATTICE_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('console', (m) => m.text().startsWith('[voice]') && console.log(m.text()));
await page.waitForFunction(() => window.latticeVoice);
await page.evaluate((d) => localStorage.setItem('lattice.ttsDevice', d), process.env.TTS_DEVICE ?? 'auto');
await page.reload();
await page.waitForFunction(() => window.latticeVoice);
console.log('voice:', await page.evaluate(() => window.latticeVoice.kind), process.env.TTS_DEVICE ?? 'auto');
const t0 = Date.now();
for (const p of PHRASES) {
  const t = Date.now();
  await page.evaluate((text) => window.latticeVoice.say(text), p);
  await page.waitForFunction(() => !window.latticeVoice.speaking(), null, { timeout: 600_000, polling: 50 });
  console.log(`  said in ${Date.now() - t} ms (synthesis + playback)`);
}
console.log(`total ${Date.now() - t0} ms`);
await app.close();
