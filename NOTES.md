# Working notes

Notes for picking the work up again. Last updated 2026-11-05.

## How we work

- Commit locally; don't push unless asked. The owner prefers running it locally
  (`cd web && npx vite --port 5173 --strictPort`, then http://localhost:5173/instruments.html).
- Commit as `Jonathan Field <needlestack@users.noreply.github.com>`.
- No warnings in the UI. Make it clear enough that they aren't needed: sane
  defaults that can be bypassed, and loaded songs load exactly as they are.
- The test: someone can use it without knowing about an advanced feature, even
  though that feature is in the UI.
- Patterns are shared. Editing one changes every use; variations get a new pattern.

## Testing

- Chrome: `cd web && npx tsc --noEmit -p . && npm test` (about 6 min because of the export tests; run it in the background).
- Firefox: `FIREFOX=$HOME/sidkid/build/browsers/firefox/mac_arm-stable_158.0.1/Firefox.app/Contents/MacOS/firefox npm run test:firefox`.
- The audio playback tests ("ui plays", "test note runs the program", "quick tap",
  and sometimes "pulse sweep to a goal") fail when the machine's audio is
  unavailable. Rerun before assuming a regression; they passed at `fb0ab9f`.
- Page hook for scripts: `window.instrumentMaker` (state, loadSong, trace, frameSteps, ready, idle, status).
- Node can't import `src/tables.ts` (extensionless imports). Test pure functions from a copy.

## Where things are (instrument maker)

- `web/src/instrumentmaker.ts`: the page. Wave/Pulse/Filter programs, steps, the bottom bar,
  the Note start… and Vibrato… popovers (only one is open at a time).
- `web/src/tables.ts`: table helpers, including the sweeps (`sweepRows`, `sweepLength`, `fastestSweep`).
- `web/src/vibrato.ts`: vibrato and slide maths (simulates GoatTracker's vibtime).
- `web/src/envelope.ts`, `analyzer.ts`, `adsr.ts`, `filtercurve.ts`, `waveicon.ts`.
- Speed table rows: `speedRow()` reuses or appends rows. Song rows are `speedFixed` and never changed.
- Sweeps are goal-based ("to X over N frames"). Editing a goal keeps later goals
  (`laterGoals`/`keepGoals`) and keeps closed loops closed (`loopCloses`/`closeLoop`).

## Instrument maker 2 (experiment, `instruments2.html`)

The owner wants to nail instruments before the song editor, and is trying a
second approach next to the first (keep both): no step list, just shaping on a
zoomable timeline, aiming for a GarageBand feel.

- One timeline with folding sections (the owner preferred this to tabs, which
  were disorienting): **Volume** (ADSR handles; folded, a thin picture of the
  envelope) and **Waveform** (a coloured strip of what is heard; open, rows for
  Triangle/Saw/Pulse/Noise with bars moved and resized like clips; overlapping
  bars play together; a dropped bar overwrites what it lands on; double-click adds
  one grid step). Pitch and Filter should be further folding sections, not tabs.
- `web/src/shape.ts`: the model (`Shape`, `Bar`) and `waveProgram()`, which turns
  bars into a wave program. A delay row of N lasts N+1 frames (checked against the engine).
- `web/src/maker2.ts`: the page. Own storage (`sidkid.maker2.v1`), not shared with
  the first maker.
- Pulse width: a "Width" automation row directly under the Pulse row (only while pulse
  is used). Points joined by sweeps (`pulseProgram` in shape.ts, via `sweepRows`),
  holding after the last, or repeating from a loop point. A repeat jumps back to the
  line just after the loop point each time (a set-width row starts that stretch), so it
  can be smooth or sawtooth-like; drawn as a shaded band with a draggable start edge. Stretches steeper than the player's sweeps (127 up/128 down a
  frame, a GoatTracker limit, not the SID's) become one set-width row per frame.
- Waveform repeat (`waveLoop`, a frame where the sound changes): from there to the end
  of the last bar, as a jump back in the wave program (no extra frame). Same pull-out ↻
  and draggable ends as pulse; needs every bar to end (pulling one out ends open bars).
  The wave table also carries pitch, so Pitch must share this repeat.
- Still missing from Volume/Waveform: an instrument that lets go by itself (gate-off
  rows), Note start (hard restart, first wave, legato), sync/ring mod.
- Timeline is 32 s (slowest attack 8 s + decay 24 s). Zooming out stops when everything
  fills a quarter of the view; zooming never jumps (it can stay further out than a
  tightened limit), and the slider's range is frozen during a drag. Pinch zooms around
  the pointer; buttons and slider around the middle of the instrument.
- "key up" (the ruler tab, or the sustain capsule sideways) sets how long Play holds
  the note and where the picture releases. It's a preview, not part of the instrument.
- Envelope handles (settled with the owner 2026-11-05, after several tries):
  - Attack, decay, release: dots that move sideways, label centred above. Hover shows
    arrows; no cursor change. The grabbed dot stays filled under the pointer.
  - Snapping: halfway between settings, but never more than `STEP_GAP` (40 px) from
    the setting it came from, so wide gaps still answer the pointer. No greyed
    preview ("less is more").
  - Sustain: a dot at key up; up/down = level, sideways = key up. The key-up tab sits
    just under the ruler with a little triangle pointing at its time.
  - Decay is a rate (time to fall all the way), so its dot moves with sustain. The
    whole decay to silence is always drawn faintly to make that visible.
- Ideas raised, not done: an instrument-level "lets go by itself" (wave rows with the
  gate off, for drums/plucks); hover "let go here" release tails; locking the
  capsule drag to one axis.
- Not yet: loading instruments from songs, pitch, filter, vibrato.

## Song editor plan (agreed 2026-11-05, expect tweaks)

- Patterns stay shared. Instruments hold wave and pulse programs (pulse is part of the patch).
- **Filter**: one per chip, so it gets its own lane under the voice tracks, like an
  automation lane on a shared effect. Each voice has a route-through-filter toggle.
  The lane shows which instrument drives the filter at each moment (last note with
  a filter program wins), so that's visible rather than warned about.
- **Tracks on voices**: any number of tracks; each is assigned to one of the 3 voices
  (picked automatically for the fewest overlaps, shown as a chip, changeable). No
  per-note reshuffling: filter routing and ring/sync depend on the voice.
- Merging: on a shared voice the newer note takes it; when that note ends the held
  note restarts (the classic bass-plus-drums-on-one-channel trick). The interrupted
  stretch is drawn hatched in its track instead of a warning.
- Loading a .sng: one track per voice, split by instrument, pinned to their voices,
  so it round-trips identically. SIDKid's own save keeps tracks; .sng export merges.

## Next ideas

1. Instrument maker 2: the Pitch tab, then Filter.
2. Drag handles on the first maker's graph to move sweep end points.
3. The song editor (plan above).
4. Saving to .sng.

## Known loose ends

- 9/A (switch program) commands store raw table positions, which break if programs
  are edited. Not fixed because no example uses them.
- The program name input doesn't update if it has focus while a song loads.
- Undecided: a README note about attack/decay ≈ 0.
- Safari is untested.
