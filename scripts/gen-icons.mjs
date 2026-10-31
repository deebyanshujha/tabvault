// Renders the dial logo to the PNG sizes the manifest needs, using Playwright's Chromium.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('public/icons');
mkdirSync(OUT, { recursive: true });

const svg = (fg, bg, stroke) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <rect width="32" height="32" rx="9" fill="${bg}"/>
  <circle cx="16" cy="16" r="8" fill="none" stroke="${fg}" stroke-width="${stroke}"/>
  <path d="M16 16l3.6-3.6" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round"/>
</svg>`;

const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Small sizes need heavier strokes to survive rasterizing.
  await page.setContent(`<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">${svg('#ffffff', '#06184f', size <= 16 ? 3 : size <= 32 ? 2.5 : 2)}</body></html>`);
  await page.screenshot({ path: resolve(OUT, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written to', OUT);
