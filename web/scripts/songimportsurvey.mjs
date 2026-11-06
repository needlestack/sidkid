// Imports every example song into the Song Maker, plays it with the Song
// Maker's sequencer and with GoatTracker's own player, and compares them
// frame by frame. Marks the ones that play exactly as importable in
// public/examples/index.json, and notes what the others need. Needs the
// dev server (npm run dev) on localhost:5173.
//
//   node scripts/songimportsurvey.mjs

import puppeteer from 'puppeteer-core';
import fs from 'fs';

const INDEX = 'public/examples/index.json';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5173/songs.html');
await p.waitForFunction(() => window.songMaker?.ready());
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
for (const ex of index) {
  const r = await p.evaluate((f) => window.songMaker.importCheck(f), ex.file);
  const differs = Object.keys(r?.differ ?? {});
  ex.importable = !!r && !r.gaps.length && !differs.length;
  // What it needs: the song's gaps, without the instruments' names; else where it plays differently
  const needs = r ? [...new Set(r.gaps.map((g) => g.replace(/^[^:]*: /, '')))] : ['a song this can read'];
  if (ex.importable) delete ex.needs;
  else ex.needs = needs.length ? needs : [`plays differently (${differs.join(', ')})`];
  console.log(`${ex.importable ? 'ok  ' : 'not '} ${ex.file}${ex.needs ? '  ' + ex.needs.join(', ') : ''}`);
}
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
await b.close();
