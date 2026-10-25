# SIDKid

A beginner-friendly, browser-based C64 SID music composer built on the
GoatTracker 2 engine by Lasse Öörni (Cadaver).

## Layout

- `vendor/gt2/` – GoatTracker 2.77, unmodified, for reference and testing
- `engine/core/` – GoatTracker's song model, playroutine and reSID. `gsong.c`,
  `gplay.c`, `gsid.cpp` and `resid*/` are unmodified copies; `goattrk2.h` and
  `gglue.c` stand in for the editor, and `gtables.c` is the data-only part of
  `gtable.c`
- `engine/sidkid.[ch]` – the engine API (load, play, render frames)
- `engine/tools/sngrender.c` – renders a `.sng` to WAV and a SID register log

## Building

```sh
cd engine
make          # build/native/sngrender
make wasm     # build/wasm/sidkid.js + sidkid.wasm (needs emscripten)
make test     # native vs. untouched vendor sources vs. wasm, all example songs
```

`make test` requires the native, reference and wasm builds to produce
identical SID registers for every frame and identical audio samples.

## License

GPL v2, as GoatTracker (see `vendor/gt2/copying`).
