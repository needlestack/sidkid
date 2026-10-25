//
// Render every example song with the wasm engine and compare the SID
// registers and audio with the native render that compare.sh left behind.
//
// Usage: node wasmcompare.mjs sidkid.js examples-dir test-dir
//

import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, examples, testDir] = process.argv.slice(2);
const { default: createSidKid } = await import(pathToFileURL(resolve(modulePath)));

function readWav(path) {
  const b = readFileSync(path).subarray(44);
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
}

let fail = false;

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sng')).sort()) {
  const name = basename(file, '.sng');
  const regs = readFileSync(`${testDir}/${name}.new.txt`, 'utf8').trim().split('\n');
  const wav = readWav(`${testDir}/${name}.new.wav`);

  // Fresh instance per song, as each sngrender run is a fresh process
  const sk = await createSidKid();
  sk.FS.writeFile('/song.sng', readFileSync(`${examples}/${file}`));
  sk._sk_init(44100, 0, 0, 0);
  const path = sk._malloc(16);
  sk.HEAPU8.set(new TextEncoder().encode('/song.sng\0'), path);
  if (!sk._sk_load_song(path)) throw new Error(`could not load ${file}`);
  sk._sk_play(0);

  const buf = sk._malloc(4096 * 2);
  let pos = 0;
  let bad = null;
  for (let f = 0; f < regs.length && !bad; f++) {
    const n = Math.min(sk._sk_render_frame(buf), wav.length - pos);
    const r = sk.HEAPU8.subarray(sk._sk_sidregs(), sk._sk_sidregs() + 25);
    if (Array.from(r, (x) => x.toString(16).padStart(2, '0')).join(' ') !== regs[f]) {
      bad = `registers differ at frame ${f}`;
    }
    const s = sk.HEAP16.subarray(buf >> 1, (buf >> 1) + n);
    for (let i = 0; i < n && !bad; i++) {
      if (s[i] !== wav[pos + i]) bad = `audio differs at sample ${pos + i}`;
    }
    pos += n;
  }
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  wasm ${name.padEnd(20)} ${bad ?? ''}`);
  if (bad) fail = true;
}

process.exit(fail ? 1 : 0);
