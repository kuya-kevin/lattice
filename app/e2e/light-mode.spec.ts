// Light mode: the zoom bar's theme button switches the whole page to the light tokens (soft gray
// ground, off-white islands, pastel track colours), and the choice survives a reload.
import { expect, test, type Page } from '@playwright/test';

const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);

test('the theme button switches to light mode and back, and is remembered', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light'); // dark is the default
  expect(await bg(page, 'body')).toBe('rgb(12, 13, 16)');

  await page.getByRole('button', { name: 'Light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg(page, 'body')).toBe('rgb(220, 222, 227)'); // soft gray ground
  expect(await bg(page, '.zoombar')).toBe('rgb(244, 245, 247)'); // off-white island
  expect(await token(page, '--track-0')).toBe('#e8896d'); // pastel ink coral

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await token(page, '--track-0')).toBe('#f08a6c');
});
