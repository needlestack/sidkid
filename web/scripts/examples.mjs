// Writes public/examples/index.json from the .sng files in public/examples,
// reading the song/author/copyright texts from each file's header.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../public/examples/', import.meta.url);

function text(bytes, offset) {
  const field = bytes.subarray(offset, offset + 32);
  const end = field.indexOf(0);
  return new TextDecoder('latin1').decode(end < 0 ? field : field.subarray(0, end)).trim();
}

const songs = readdirSync(dir)
  .filter((f) => f.endsWith('.sng'))
  .sort()
  .map((file) => {
    const bytes = readFileSync(new URL(file, dir));
    return { file, title: text(bytes, 4) || file, author: text(bytes, 36), copyright: text(bytes, 68) };
  });

writeFileSync(new URL('index.json', dir), JSON.stringify(songs, null, 2) + '\n');
console.log(`${songs.length} examples`);
