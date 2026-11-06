//
// The worklet's render, a frame made a part at a time as it's played,
// against whole frames (sk_render_frame): the same to the sample. And a
// frame ended early for a note played live ends where the chip has got to.
//
// Usage: node streamcompare.mjs sidkid.js examples-dir
//

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, examples] = process.argv.slice(2);
const { default: createSidKid } = await import(pathToFileURL(resolve(modulePath)));
const SAMPLES = 44100 * 20;
const BLOCK = 128;

async function load(file) {
  const sk = await createSidKid();
  sk._sk_init(44100, 0, 0, 0);
  if (!file) return sk;
  sk.FS.writeFile('/song.sng', readFileSync(`${examples}/${file}`));
  const path = sk._malloc(16);
  sk.HEAPU8.set(new TextEncoder().encode('/song.sng\0'), path);
  if (!sk._sk_load_song(path)) throw new Error(`could not load ${file}`);
  sk._sk_play(0);
  return sk;
}

let fail = false;
const report = (ok, name, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(26)} ${ok ? '' : detail}`);
  if (!ok) fail = true;
};

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sng')).sort()) {
  const whole = await load(file);
  const parts = await load(file);
  const want = new Int16Array(SAMPLES);
  const frame = whole._malloc(8192);
  for (let pos = 0; pos < SAMPLES; ) {
    const n = whole._sk_render_frame(frame);
    want.set(whole.HEAP16.subarray(frame >> 1, (frame >> 1) + Math.min(n, SAMPLES - pos)), pos);
    pos += n;
  }
  const block = parts._malloc(BLOCK * 2);
  let bad = -1;
  for (let pos = 0; pos < SAMPLES && bad < 0; pos += BLOCK) {
    parts._sk_render(block, BLOCK);
    const got = parts.HEAP16.subarray(block >> 1, (block >> 1) + BLOCK);
    for (let i = 0; i < BLOCK && pos + i < SAMPLES; i++) if (got[i] !== want[pos + i]) bad = pos + i;
  }
  report(bad < 0, `stream ${file.replace('.sng', '')}`, `differs at sample ${bad}`);
}

// A frame part played: ending it now leaves only what's made (a little), not the rest of the frame
const sk = await load(null);
const block = sk._malloc(BLOCK * 2);
for (let i = 0; i < 3; i++) sk._sk_render(block, BLOCK);
const before = sk._sk_frame_left();
sk._sk_frame_now();
const after = sk._sk_frame_left();
report(before > BLOCK && after === 0, 'stream frame now', `left ${before}, then ${after}`);

process.exit(fail ? 1 : 0);
