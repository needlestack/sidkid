// The screenshots in docs/ (the quick start), taken from the pages with a
// starting song and instruments, so they can be taken again when
// the pages change.
//
// Usage: node scripts/screenshots.mjs   (writes docs/images/*.png)

import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${ROOT}docs/images`;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const only = process.argv[2];

mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 });
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const shot = async (name, clip) => {
  if (only && only !== name) return;
  await settle();
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  console.log(`  ${name}.png`);
};
const box = (q) => page.$eval(q, (e) => e.getBoundingClientRect().toJSON());

// --- Song Maker: the song a first visit starts with ---
await page.goto(`${base}songs.html`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.songMaker?.ready());
await page.click('#zoom-fit').catch(() => {});
await settle();
// The first clip open in the editor
const lead = await page.$$eval('.clip2-body', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
if (lead[0]) await page.mouse.click(lead[0].x + 30, lead[0].y + lead[0].height / 2);
await shot('song-maker');

// The Export menu
await page.click('#export-song');
await settle();
const ask = await box('.ask');
const exp = await box('#export-song');
await shot('export', { x: exp.x - 16, y: exp.y - 16, width: Math.max(ask.right, exp.right) - exp.x + 32, height: ask.bottom - exp.y + 32 });
await page.keyboard.press('Escape');

// --- Instrument Maker: the Lead, with its sections open ---
await page.goto(`${base}instruments.html`);
await page.waitForFunction(() => window.maker2?.ready());
await page.evaluate(() => {
  const s = window.maker2.state();
  s.current = 0;
  s.waveOpen = true;
  s.notesOpen = false;
  s.filterOpen = false;
  window.maker2.changed();
});
await shot('instrument-maker');
// The Minor Arp, picked as it would be, its filter open
const arp = await page.evaluate(() => String(window.maker2.state().instruments.findIndex((i) => i.id === 'minor-arp')));
await page.select('#instrument', arp);
await page.evaluate(() => {
  window.maker2.state().filterOpen = true;
  window.maker2.changed();
});
// (tall enough that the keyboard bar, fixed at the bottom, is below it)
await page.setViewport({ width: 1280, height: 1500, deviceScaleFactor: 2 });
await settle();
const shaper = await box('.shaper');
await shot('instrument-filter', { x: shaper.x, y: shaper.y, width: shaper.width, height: shaper.height });

await browser.close();
await server.close();
