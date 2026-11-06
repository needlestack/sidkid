// Plays a long note of every instrument of the example songs with its
// voice taken for a step at points through it (a note getting its voice
// back in the song maker), and sums up how closely it then plays on as the
// note alone would (waveform, pitch within 10
// cents, pulse width within 2, cutoff). Needs the dev server (npm run dev)
// on localhost:5173.
//
//   node scripts/resumesurvey.mjs

import puppeteer from 'puppeteer-core';
import fs from 'fs';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const m = await b.newPage();
m.on('pageerror', (e) => console.log('ERR', e.message));
await m.goto('http://localhost:5173/instruments2.html');
await m.waitForFunction(() => window.maker2?.ready());
const shapes = [];
for (const f of fs.readdirSync('public/examples').filter((f) => f.endsWith('.sng'))) {
  const bytes = [...fs.readFileSync(`public/examples/${f}`)];
  const res = await m.evaluate((bytes) => window.maker2.importSong(new Uint8Array(bytes)).map((r) => ({ name: r.name, shape: r.shape })), bytes);
  for (const r of res) shapes.push({ name: `${f} ${r.name}`, shape: r.shape });
}
const p = await b.newPage();
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5173/songs.html');
await p.waitForFunction(() => window.songMaker?.ready());
const ats = [1, 2, 3, 5, 8, 13, 21];
const out = await p.evaluate((shapes, ats) => shapes.map(({ name, shape }) => {
  const bad = [];
  let silent = 0, none = 0;
  for (const at of ats) {
    const d = window.songMaker.resumeCheck(shape, at, 150);
    if (d === 'too big') none++;
    else if (d === 'silent') silent++;
    else if (d === null) none++;
    else if (d.length) bad.push(`@${at} ${d[0]} (${d.length})`);
  }
  return { name, bad, silent, none };
}), shapes, ats);
const kinds = {};
for (const r of out) for (const b of r.bad) { const k = b.replace(/@\d+ \d+: /, '').replace(/ \(\d+\)/, ''); kinds[k] = (kinds[k] || 0) + 1; }
console.log(`${out.length} instruments x ${ats.length} steps: ${out.filter((r) => !r.bad.length).length} always the same`);
console.log('kinds', kinds, 'silent', out.reduce((a, r) => a + r.silent, 0), 'too big for the tables', out.reduce((a, r) => a + r.none, 0));
for (const r of out.filter((r) => r.bad.length).slice(0, 25)) console.log(r.name, r.bad.slice(0, 3).join(' | '));
await b.close();
