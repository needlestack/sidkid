// Imports every instrument of the example songs into the second instrument
// maker and sums up what didn't come across: the gaps the importer names,
// and where playing the shape differs from the original. Needs the dev
// server (npm run dev) on localhost:5173. Writes the details as JSON to the
// path given (default: import-survey.json).
//
//   node scripts/importsurvey.mjs [out.json]

import puppeteer from 'puppeteer-core';
import fs from 'fs';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5173/instruments2.html');
await p.waitForFunction(() => window.maker2?.ready());
const songs = fs.readdirSync('public/examples').filter((f) => f.endsWith('.sng'));
const all = [];
for (const f of songs) {
  const bytes = [...fs.readFileSync(`public/examples/${f}`)];
  const res = await p.evaluate((bytes) => window.maker2.importSong(new Uint8Array(bytes)).map((r) => ({ name: r.name, gaps: r.gaps, differs: r.differs })), bytes);
  for (const r of res) all.push({ song: f, ...r });
}
fs.writeFileSync(process.argv[2] ?? 'import-survey.json', JSON.stringify(all, null, 1));
const exact = all.filter((r) => !r.differs.length);
console.log(`${all.length} instruments, ${exact.length} play the same, ${all.filter((r) => !r.differs.length && !r.gaps.length).length} with no gaps`);
const count = (key) => { const c = {}; for (const r of all) for (const g of r[key]) { const k = g.replace(/ from frame \d+/, '').replace(/\$[0-9a-f]+/, '$xx').replace(/\d+ frames/, 'N frames'); c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
console.log('GAPS', count('gaps'));
console.log('DIFFERS', count('differs'));
await b.close();
