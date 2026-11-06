// The C64 export checked on a C64, in VICE (needs VICE's x64sc; skipped
// without it): each song made into a disk as Song Maker makes one, booted
// on a PAL and an NTSC machine, its SID writes logged. The player must be
// called at the song's own rate on both, and write what the engine plays
// (GoatTracker's editor player, sngrender) frame by frame, as near as
// GoatTracker's own C64 player does.
//
// Usage: node scripts/c64check.mjs [song.sng ...]   (default: the example songs Song Maker imports)
//        VICE=/path/to/x64sc

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${ROOT}build/c64check`;
const VICE = process.env.VICE ?? '/Applications/vice-arm64-gtk3-3.9/bin/x64sc';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SNGRENDER = `${ROOT}build/native/sngrender`;
const EXAMPLES = `${ROOT}web/public/examples`;
const PAL_CLOCK = 985248;
const NTSC_CLOCK = 1022727;
// (autostart loading the disk takes most of it, in warp)
const CYCLES = 30000000;

if (!existsSync(VICE)) {
  console.log(`  skip  no VICE at ${VICE} (set VICE=)`);
  process.exit(0);
}
const INDEX = JSON.parse(readFileSync(`${EXAMPLES}/index.json`, 'utf8'));
const songs = process.argv.length > 2 ? process.argv.slice(2) : INDEX.filter((e) => e.importable).map((e) => `${EXAMPLES}/${e.file}`);
// Where GoatTracker's own two players differ
const KNOWN = { everlasting: "GoatTracker's C64 player runs voice 2's pulse program, its editor's holds it" };
// An example's player settings (pulse optimization off, for one)
const optionsOf = (song) => INDEX.find((e) => `${EXAMPLES}/${e.file}` === song)?.settings ?? {};
mkdirSync(OUT, { recursive: true });

let fail = false;
const report = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
  if (!ok) fail = true;
};

// The disks, made in the page as Song Maker makes them
const server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
await page.goto(`${server.resolvedUrls.local[0]}songs.html`);
const disk = (song, ntsc) =>
  page.evaluate(
    async (bytes, ntsc, options) => {
      const m = await import('/src/c64export.ts');
      const settings = { multiplier: 1, hardRestart: 0x0f00, pulseOptimization: true, realtimeOptimization: true, ...options, ntsc };
      const packed = await m.packSong(Uint8Array.from(bytes), settings, 0, 1);
      return Array.from(m.diskOf('check', m.playingProgram(packed, 'check', settings)));
    },
    Array.from(readFileSync(song)),
    ntsc,
    optionsOf(song),
  );

/** VICE's log of SID writes (cycles since the last, register, value) as the registers after each player call */
function calls(dumpFile) {
  const regs = new Array(25).fill(0);
  const out = [];
  let cycle = 0;
  let last = -Infinity;
  for (const line of readFileSync(dumpFile, 'utf8').trim().split('\n')) {
    const [d, r, v] = line.trim().split(/\s+/).map(Number);
    cycle += d;
    if (r >= 25) continue;
    // (a call's writes come close together)
    if (cycle - last > 3000) out.push({ at: cycle, regs: null });
    last = cycle;
    regs[r] = r === 3 || r === 10 || r === 17 ? v & 15 : v;
    out[out.length - 1].regs = regs.slice();
  }
  return out;
}

for (const song of songs) {
  const name = basename(song, '.sng');
  for (const ntsc of [false, true]) {
    const file = `${OUT}/${name}-${ntsc ? 'ntsc' : 'pal'}.d64`;
    writeFileSync(file, Uint8Array.from(await disk(song, ntsc)));
    for (const machine of ['pal', 'ntsc']) {
      const dump = `${OUT}/${name}-${ntsc ? 'ntsc' : 'pal'}-on-${machine}.dump`;
      spawnSync(VICE, ['-default', `-${machine}`, '-autostart', file, '-warp', '-limitcycles', String(CYCLES), '-sounddev', 'dump', '-soundarg', dump], { stdio: 'ignore' });
      const got = calls(dump);
      // The song's own rate, on either machine
      const want = (machine === 'pal' ? PAL_CLOCK : NTSC_CLOCK) / (ntsc ? 60 : 50);
      const gaps = got.slice(-200).map((c, i, a) => (i ? c.at - a[i - 1].at : 0)).slice(1).sort((x, y) => x - y);
      const median = gaps[gaps.length >> 1];
      // What it writes, frame by frame, against the engine (calls writing nothing: the frame before again)
      const regsFile = `${OUT}/${name}-${ntsc ? 'ntsc' : 'pal'}.txt`;
      const o = optionsOf(song);
      execFileSync(SNGRENDER, [song, '-s', '60', '-r', regsFile, '-N', ntsc ? '1' : '0', ...(o.pulseOptimization === false ? ['-O', '0'] : [])], { stdio: 'ignore' });
      const ours = readFileSync(regsFile, 'utf8').trim().split('\n').map((l) => l.split(' ').map((h, r) => parseInt(h, 16) & (r === 3 || r === 10 || r === 17 ? 15 : 255)).join(','));
      const frames = [];
      got.forEach((c, i) => {
        const n = i + 1 < got.length ? Math.max(1, Math.round((got[i + 1].at - c.at) / want)) : 1;
        for (let k = 0; k < n; k++) frames.push(c.regs.join(','));
      });
      const start = frames.findIndex((f) => ours.includes(f) && f.split(',').some((v, r) => (r === 4 || r === 11 || r === 18) && v & 1));
      const at = ours.indexOf(frames[start]);
      const n = Math.min(frames.length - start, ours.length - at);
      let same = 0;
      // (a pulse width a step or two apart counts as the same: the players round a sweep's steps differently, by 1/4096)
      const alike = (a, b) => {
        const [x, y] = [a.split(',').map(Number), b.split(',').map(Number)];
        return x.every((v, r) => {
          const pw = r % 7;
          if (r > 20 || (pw !== 2 && pw !== 3)) return v === y[r];
          const base = r - pw + 2;
          return Math.abs((x[base] | (x[base + 1] << 8)) - (y[base] | (y[base + 1] << 8))) <= 2;
        });
      };
      for (let i = 0; i < n; i++) if (alike(frames[start + i], ours[at + i])) same++;
      const rateOk = Math.abs(median - want) < 4;
      // (the packer is GoatTracker's own, its output the same as gt2reloc's: where its 6502 player and its
      // editor player, which the engine is, part ways, so does the disk)
      const known = KNOWN[name];
      const regsOk = n > 50 && same / n > (known ? 0.5 : 0.95);
      report(rateOk && regsOk, `c64 ${name} ${ntsc ? 'ntsc' : 'pal'} song on ${machine}`, `every ${median} cycles (${Math.round(want)}), ${same}/${n} frames as the engine${known ? ` (${known})` : ''}`);
    }
  }
}

await browser.close();
await server.close();
process.exit(fail ? 1 : 0);
