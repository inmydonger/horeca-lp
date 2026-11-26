// Bakes the clay globe textures into public/globe/ using headless Chromium.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const W = +(process.argv[2] || 4096);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + here + 'bake-globe.html');
const svg = readFileSync(here + 'world.svg', 'utf8');
console.time('bake');
const out = await page.evaluate(([s, w]) => window.bake(s, w), [svg, W]);
console.timeEnd('bake');
for (const [k, ext] of [['color', 'webp'], ['normal', 'webp'], ['height', 'png']]) {
  const b = Buffer.from(out[k].split(',')[1], 'base64');
  writeFileSync(here + `../public/globe/${k}.${ext}`, b);
  console.log(k, (b.length / 1024 | 0) + ' KB');
}
await browser.close();
