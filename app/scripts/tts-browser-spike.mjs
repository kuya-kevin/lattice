// B14 spike, browser half: the same five phrases through the app's own MmsVoice (Web Worker,
// Transformers.js on WASM, fp32) in headless Chromium, logging model load and time per phrase.
// Needs a dev server: npm run dev:web -- --port 5392 --strictPort; then node scripts/tts-browser-spike.mjs
// The weights download into the browser profile's cache (a temp profile here, so every run
// downloads again; Electron keeps them in its userData cache).
import { chromium } from '@playwright/test';

const url = process.env.SPIKE_URL ?? 'http://localhost:5392/?voice=mms';
const PHRASES = [
  'Panned the double 30 percent right.',
  'Moved the vocal up two bars.',
  'Brighter how: raise the top end, or cut the low mids?',
  'Quantized the drums to sixteenths.',
  'Added a compressor to the bass.',
];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => m.text().startsWith('[voice]') && console.log(m.text()));
await page.goto(url);
const t0 = Date.now();
await page.evaluate(async (phrases) => {
  const vr = window.latticeVoice;
  if (vr?.kind !== 'mms') throw new Error(`voice is ${vr?.kind}, open with ?voice=mms`);
  const { MmsVoice } = await import('/src/renderer/voice.ts');
  const { speakable } = await import('/src/core/voiceTools.ts');
  const v = new MmsVoice();
  for (const p of phrases) await v.speak(speakable(p)).done; // the first one waits for the model
}, PHRASES);
console.log(`total ${Date.now() - t0} ms (download + load + 5 phrases synthesized and played)`);
await browser.close();
