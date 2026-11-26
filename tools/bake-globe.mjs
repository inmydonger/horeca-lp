// Bakes the clay globe land texture into public/globe/land.png using headless Chromium.
//   node tools/bake-globe.mjs [size=4096] [outDir=../public/globe]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const here = fileURLToPath(new URL('.', import.meta.url));
const W = +(process.argv[2] || 4096);
const outDir = resolve(here, process.argv[3] || '../public/globe');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('  ' + m.text()));
await page.goto('file://' + here + 'bake-globe.html');
const svg = readFileSync(here + 'world.svg', 'utf8');
console.time('bake');
const out = await page.evaluate(([s, w]) => window.bake(s, { size: w }), [svg, W]);
console.timeEnd('bake');
mkdirSync(outDir, { recursive: true });
const b = Buffer.from(out.land.split(',')[1], 'base64');
writeFileSync(resolve(outDir, 'land.png'), b);
console.log('land.png', (b.length / 1024 | 0) + ' KB', `(range ${out.range} texels, ${out.size}px)`);
await browser.close();
