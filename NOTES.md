# Working notes

Notes for picking the work up again. Last updated 2026-11-05.

## How we work

- Commit locally; don't push unless asked. The owner prefers running it locally
  (`cd web && npx vite --port 5173 --strictPort`, then http://localhost:5173/songs.html).
- Two pages (2026-11-05): Instrument Maker (`instruments2.html`) and Song Maker (`songs.html`),
  switched in the middle of the top bar. The old song player (`index.html`) and first
  instrument maker (`instruments.html`) are set aside: unlinked, still built and tested.
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
- Waveform repeat (`waveLoop`, a frame where the sound or pitch changes): from there to
  the end of the last bar or note, as a jump back in the wave program (no extra frame).
  Same pull-out ↻ and draggable ends as pulse; shared with Notes.
- Endings: after the last bar/note, `hold` (→: program stops, last sound held, pitch left
  free for effects) or silence (a silent row, gate on), or the shared repeat (↻). Bars are
  always finite now; old "keeps going" bars load as finite bars with hold on.
- Pitch (was Notes): a third fold, a roll of semitones (−12..+24) from the key played.
  A pitch is a change at a time (`Note {start, semis}`, no end: the player has none), drawn
  as one continuous line of steps. Dragging along draws a change and a change back. The
  owner may want a fake "end" later so a pitch can set the repeat's end. Notes and waveform make one wave program
  (`stretches()` in shape.ts: each row sets what changed; the repeat target sets both).
  Not yet: fixed pitches (drums), slides. The roll shows the pitch as the engine makes it.
- Vibrato: a lane under the Pitch roll (instrument vibrato: a speed-table row + delay).
  The player counts the delay only on frames it runs effects (not a song row's first
  tick, nor rows that set the pitch), so the start is measured by tracing with and
  without; dragging picks the delay that lands nearest. Repeating pitches override it.
- Filter: a fourth fold with three rows: Type, Cutoff, Resonance. Type is chunks (with
  filter-shape icons) handled like waveform bars; gaps aren't filtered (voice routed past),
  and no chunks means no filter program at all (no on/off switch). Cutoff (0-255) is a line
  like pulse width (they share one editor, `LineLane`/`drawLine`); Resonance is a line too,
  played as steps (16 levels, no sweep). One filter program, so one repeat: dragged on the
  Cutoff row but its band spans all three rows, and type chunks and resonance steps are
  drawn coming round after it (`filterRepeat`/`filterSource`). A chunk ending on the
  repeat's end covers that frame too (else one unfiltered frame per pass). One filter program, so the cutoff's repeat is shared; setup rows
  for type/resonance changes share a frame with a cutoff set (`filterProgram`). A scope
  under the timeline shows the response at the playhead or the hovered moment, from the
  engine trace. The setup row routes voice 1
  for the preview; the song editor must set the instrument's actual voice (and own the
  shared filter: see the song editor plan).
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

1. Instrument maker 2: loading instruments from songs; Note start (hard restart, legato);
   releasing by itself; sync/ring mod.
2. Drag handles on the first maker's graph to move sweep end points.
3. The song editor (plan above).
4. Saving to .sng.

## Known loose ends

- 9/A (switch program) commands store raw table positions, which break if programs
  are edited. Not fixed because no example uses them.
- The program name input doesn't update if it has focus while a song loads.
- Undecided: a README note about attack/decay ≈ 0.
- Safari is untested.

- Drums (maker2): `release` (fixed key up: wave rows lose the gate bit from that frame; a
  release inside a waveform repeat unrolls the repeat to there, then loops a gate-off copy),
  `fixedNote` (pitch rows written as absolute notes), `hardRestart` (gate timer bit $80).
  Both choices are "As played" / "Fixed" in a hover popup (`showChoice`) on the key-up tab and
  on the Pitch gutter's "played" label. A song key-off still cuts a fixed key up short.
- Glides: `Note.glide` frames from `start`, arriving at `arrival(n)`. `waveProgram` is now
  frame by frame: each glide frame picks the nearest of wait, a semitone set, or portamento
  (wave cmd 1/2) by a calculated speed row (left $80, right = shift: a fraction of the
  semitone above the last note set), so it is the same on every key. One row per glide frame.
  `waveProgram` returns the speed rows it used; the audition puts vibrato's row first.
- Importer (`goatimport.ts`, `importSong` on the maker2 hook): plays each song instrument
  silently and reads the shape off the trace (loops = table positions *and* values repeating,
  the earliest-starting repeat wins); then traces the shape and compares frame by frame.
  Vibrato delay is re-searched so it starts where the original's does; pitch re-sets kept
  for vibrato (a delay row sets its pitch on its last frame). `node scripts/importsurvey.mjs`
  surveys the examples: 213/226 play the same (notes read from the note table, the top
  notes all clamp to $FFFF). No Import button yet (loaded things must load as they are).
  Left: a pitch of 0, envelope changes partway, very long sweeps, late vibrato drift.
- Per-step fixed (`Note.fixed`: semis from C-4, `FIXED_BASE`), "Fixed to C-4" in a selected
  step's readout; the master As played/Fixed stays (hides the per-step option). The roll
  shows 36 semitones (`state.rollLow`, ▲▼ in the gutter, `fitRoll` on switching), steps
  -32..+48, clipped to the roll. `Shape.bits`: test/ring/sync stretches (no rows; ring and
  sync are checkboxes: whole note, or partly as imported). Also kept without UI:
  `legato`, `gateFrames`, `firstWave`, `pulseFromSong`.

## Song maker (`songs.html`, started 2026-11-05)

- `web/src/songdoc.ts`: the model (SongDoc → Track {instrument id, voice, muted, clips} → Clip
  {start, length, span, notes}; in steps) and the compiler. Tempo is `bpm`, any value: a step
  starts on the nearest frame (`frameAt`, `framesPerStep`), like GoatTracker's alternating
  tempos, at most a frame off; switching PAL/NTSC keeps the BPM. Old saves (`stepFrames`) are
  converted as PAL.
  `voiceSegments`: per voice, the held note that started last plays (same frame: higher track
  wins); a note that gets the voice back restarts. `songSequence` turns that into timed note
  on/offs, each started `leadOf` (gate timer + 1) frames early so it sounds on its frame;
  a note-off is skipped when the next note's start comes first, or the instrument has a
  fixed key up. Cycling: a first pass from the playhead, then the cycle round and round
  (`lead` events replay before each jump back).
- `web/src/engine/sequencer.ts`: plays a Sequence a frame at a time, in the worklet (which
  now renders up to frame boundaries with `sk_frame_left`, new in the engine) and in
  `Analyzer.traceSequence` for tests. Status reports `sequence` (the frame reached).
- `web/src/instruments.ts`: maker2's storage, migration and shape → tables (`sound`,
  `sounds`, `soundTables`) now shared. Instruments have ids (`giveIds`; starting ones are
  'lead', 'bass', 'snare'). An instrument per (instrument, voice): the filter needs the voice.
  The song page follows maker2 edits live (storage event).
- Page (`songmaker.ts`): track heads (instrument, voice 1-3, mute, remove, + Track), clips
  (double-click a lane; drag; ⌥-drag copies; lower right edge = length, upper right = repeat;
  ⌘D duplicates), ruler (click = playhead, top strip = cycle), editor for the open clip
  (double-click adds, drag moves/lengthens, rubber band, arrows), keys play the selected
  track; R records (quantized to steps, into the clip under it or a take clip growing by
  bars), C cycle, Space play, Return to start, Z/X octave. Double-clicks are detected from
  press timing (the first press redraws the SVG). Stored in `sidkid.song2.v1`, one song.
- Metronome (M) and count-in: `Sequence.beats/bars` frames, returned by `Sequencer.tick`, a
  short sine tick mixed in the worklet after the chip (no SID voice). Count-in is a bar of the
  song's beats before the playhead (preroll grows to a bar). ⏮/Return goes to the cycle's
  start when cycling.
- Resume (`resume.ts`): a note getting its voice back picks up where it left off, as a variant
  instrument of its sound: a first frame setting waveform, pitch, pulse width and filter as the
  note had them (read off a trace of the instrument), then joining its programs at the row it
  was on (the rest of a wait or sweep first; never onto a jump row: the player follows one jump
  a frame). The quickest AD once past the attack and decay; the instrument's gate frames (so
  the player's tick, which decides effect frames, keeps in step) without hard restart. Vibrato
  delay found by trying (`tuneVibrato`). Variants are shared when alike and kept within 63
  instruments and 255 table rows (else the note restarts) by `songPlan` in songmaker.ts.
  `node scripts/resumesurvey.mjs`: 187/226 example instruments resume exactly at 12 points;
  the rest differ a little in pitch (vibrato a frame off in jam-mode ticks, which reset per
  note: a song exported to patterns keeps them in step; slides resume on the nearest note).
  Released notes (fixed key up) aren't resumed. No per-track "start again" option yet.
- Tempo (2026-11-05): `SongDoc.bpm` is the tempo from the start, `SongDoc.tempo` the changes
  (held, or `ramp` from the one before). Steps → frames through a cached running total of each
  step's length (`exactFrame` / `frameAt` / `stepAt` in songdoc.ts), so everything follows it.
  The Tempo lane under the ruler edits it (drag points; double-click adds/removes; ⌥-click a
  point ramps to it); the BPM box shows and edits the tempo at the playhead. Imports read each
  row's length (a step a row), so GoatTracker's tempo and funk tempo commands come across;
  per-voice tempos ("voices at different tempos") don't yet.
- Slides, bends, vibrato (2026-11-05): `SongNote.slide` (goes on from the note before, at a
  speed; null: at once) and `SongNote.effects` (up / down / slide / vibrato over steps
  [from, to), a speed-table row each; GoatTracker's commands 1-4, one a step). Every step is a
  row on every voice (`sk_row`: tick 0, length, command); a slide is `sk_slide` (note row with
  tone portamento). Song speeds go after the instruments' in the speed table (`songSpeeds`).
  Imported songs are timed as GoatTracker's player: rows read `GOAT_READ` frames before the
  step's frame (notes start, let go, pulse rests), tick 0 the instrument's gate frames after.
  Editor: a note's pitch line drawn through it (`pitchLine`), a band per effect along its foot
  (ends: where; up/down: speed), and buttons over the one selected note (`fx-bar`). Instruments
  now keep their pitch re-sets (a note slid to is heard at once). Imports exact: everlasting,
  sixpack, tempo2test.
- Export (`songexport.ts`, Export button): what Song Maker plays, a step a row per voice (notes and
  instruments, resumes as their variant instruments, key-offs, effects' commands, tempo commands
  on a row with none), cut into patterns where playback has them (`patternStarts`: imported
  songs' own, else every `patternSteps`), alike patterns once, looping to the start. Every song
  now plays with GoatTracker's pulse optimization (pulse rests a frame each row, and after each
  pattern's last row, the last one included), as its player does by default, so exports play the
  same. `songMaker.exportCheck()` loads the file in the engine and compares GoatTracker's playing
  with Song Maker's: exact for a song made here and for the imports (except 2-frame steps, which
  need funk tempo: listed as a gap). Resumes are traced in their song (`resumeTraces` plays the
  note alone with the song's tempo, rows and rests).
- Tracks: S solos (any number); Delete with no clip picked up asks to clear or delete the selected
  track; deleting a song asks first.
- Several songs (`songs` + `current` in `sidkid.song2.v1`), a picker with New / Import… / Delete.
  Undo keeps either the song open or the whole list (`before` / `beforeSongs`).
- Importing GoatTracker songs (`songimport.ts`, 2026-11-05): tracks per voice and instrument, one
  step a row, timed from the scan; clips per pattern, joined where a note is held over. Played
  by the sequencer it matches GoatTracker's player exactly given: a note sounds 2 frames after
  its row is read (`ROW_TO_NOTE`); notes let go their instrument's lead before their end (also
  for Song Maker's own songs: as a key-off row does); and `SongDoc.goat` keeps the player's pulse
  optimization (pulse holds still a frame on each row, the lead before it, and the frame after
  each pattern's last row; `sk_skip_pulse` in the engine wrapper, restoring pulse state after
  the frame; the vendor player is untouched). `node scripts/songimportsurvey.mjs` compares every
  example frame by frame and marks `importable` / `needs` in public/examples/index.json; only
  importable ones are offered, and a test checks they still play exactly. So far: everlasting.
  The rest need tempo changes, slides to notes, vibrato and pitch-bend commands, envelope /
  waveform / program changes mid-song, funk tempo, multispeed.
- Instrument import gained (no UI): `pitchFromSong` (pitch left from the note before until the
  first step), `PulseShape.inherit` (carries on from the voice's width; first move from the
  program's own first row; sweeps unwrapped), `FilterChunk.voices` (absolute routing, may change
  partway), fixed notes past 95 (a pitch of 0, a drum trick). Survey: 218/226 exact.
- Not yet: voice priority settings, filter sharing, several songs, .sng export, tempo
  changes, copy/paste, selecting several clips.

## Song construction: stack and pre-empt (the plan)

The user's direction: pre-planning every voice breaks how musicians think. Any number of
tracks; the 3 voices do their best to recreate them, stealing from each other, gating and
overriding (the newest note takes a voice). Normal flow: make a bass sound, make a drum
sound, run two tracks that share a voice and take turns, mostly transparent to the
composer. Instruments that put the track logic inside ("drum & bass" instruments) are
still supported, but aren't the way you have to work. Experimental: departs from
GoatTracker where it must.
