// Screenshots every mock at desktop size: node mocks/shoot.mjs [name...]
import { chromium } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace('.html', ''));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror', e.message));
for (const n of names) {
  await page.goto(pathToFileURL(join(dir, `${n}.html`)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, 'shots', `${n}.png`) });
  console.log('shot', n);
}
await browser.close();
