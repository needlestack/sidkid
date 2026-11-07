# SIDKid for developers

How SIDKid is built, tested and deployed. To use it, go to
[needlestack.github.io/sidkid](https://needlestack.github.io/sidkid/).

## Running it locally

```sh
cd engine
make wasm     # build/wasm/sidkid.js + sidkid.wasm (needs Emscripten)
cd ../web
npm install
npm run dev   # http://localhost:5173
```

## Tests

```sh
cd engine && make test   # native vs. GoatTracker's own sources vs. wasm, every example song
cd web && npm test       # headless Chrome: the AudioWorklet against the native engine, and the two pages
cd web && npm run c64check   # optional, needs VICE: exported disks booted on PAL and NTSC C64s
```

`make test` requires the native, reference and wasm builds to write the same
SID registers every frame and the same audio samples. `npm test` drives both
pages in Chrome. `node scripts/screenshots.mjs` takes the screenshots in
`docs/` again.

## Layout

- `vendor/gt2/`: GoatTracker 2.77, untouched, for reference and testing.
- `engine/core/`: GoatTracker's song model, player, packer/relocator (with
  its assembler and `player.s`) and reSID. `goattrk2.h`, `gglue.c` and
  `gpack.c` stand in for the editor; reSID's `wave.cpp` is changed so the
  noise survives a short test bit, as on the chip.
- `engine/sidkid.[ch]`: the engine's API (play songs, scan them, play and
  trace single notes, sequence notes from outside, pack songs for the C64).
  `engine/tools/` has the native test tools.
- `web/`: the app (Vite and TypeScript). The engine runs in an
  AudioWorklet (`src/engine/`). `instruments.html` and `src/maker2.ts` are
  the Instrument Maker; `songs.html` and `src/songmaker.ts` the Song Maker,
  with the song model in `src/songdoc.ts`, GoatTracker import and export
  in `src/songimport.ts` and `src/songexport.ts`, and the C64 disk in
  `src/c64export.ts`.
- `NOTES.md`: working notes, for picking the work up again.

## Deployment

`.github/workflows/deploy.yml` builds the engine with Emscripten, runs the
engine and browser tests, and publishes the site to GitHub Pages on every
push to `main`.
