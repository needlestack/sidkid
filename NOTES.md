# Working notes

Notes for picking the work up again. Last updated 2026-10-30, at `fb0ab9f`.

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

## Next ideas

1. Drag handles on the graph to move sweep end points on the width/cutoff line.
2. The song editor: pattern effects, filter routing per voice, filter ownership on
   the timeline, programs that change mid-note.
3. Saving to .sng.

## Known loose ends

- 9/A (switch program) commands store raw table positions, which break if programs
  are edited. Not fixed because no example uses them.
- The program name input doesn't update if it has focus while a song loads.
- Undecided: a README note about attack/decay ≈ 0.
- Safari is untested.
