// GoatTracker instruments into shapes for the second instrument maker.
//
// Rather than read the tables row by row (with their commands, shared rows
// and jumps between instruments), an instrument is played silently and its
// shape is read off what the player does each frame: the waveform, pitch,
// pulse width and filter. Where the tables' positions start repeating, the
// shape repeats too. What a shape can't hold is listed as gaps.

import type { Trace } from './engine/analyzer';
import { defaultFilter, defaultPulse, FIXED_BASE, NOTE_HIGH, NOTE_LOW, type Bar, type FilterChunk, type Note, type PulsePoint, type Shape } from './shape';
import type { Instrument } from './song';
import { WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI } from './tables';
import { freqOf } from './vibrato';

/** Plays an instrument on a key for some frames, as the analyzer does */
export type Tracer = (ins: Instrument, note: number, frames: number) => Trace;

export interface Imported {
  shape: Shape;
  /** What didn't come across, in words */
  gaps: string[];
}

/** The key traced, and another to tell played pitches from fixed ones */
export const KEY = 48;
const OTHER_KEY = 60;

const GATE = 0x01;
const PITCH_KEEP = 0x80;
const SYNC = 0x02;
const RING = 0x04;
const TEST = 0x08;
const OSCILLATORS = [WAVE_TRI, WAVE_SAW, WAVE_PULSE, WAVE_NOISE];
/** A note past the end of the frequency table, where they're all 0: a pitch of 0 */
const SILENT_NOTE = 96;
/** How near a whole semitone a pitch must be to count as one */
const WHOLE = 0.08;

/**
 * Where a table's run stops (its position going to 0), or where it starts
 * repeating and the frame it would come back round. A repeat is the
 * positions and what they set (`values`) coming round together: a row can
 * sit on one position for many frames while what it sets keeps moving.
 */
export function runOf(pos: Uint8Array, ...values: ArrayLike<number>[]): { end: number; loop: number | null } {
  const n = pos.length;
  const stop = pos.indexOf(0);
  if (stop >= 0) return { end: stop, loop: null };
  const same = (a: number, b: number) => pos[a] === pos[b] && values.every((v) => v[a] === v[b]);
  // The repeat that starts soonest (and of those the shortest), seen at
  // least twice: two frames alike near the end are no repeat
  let best: { end: number; loop: number } | null = null;
  for (let period = 1; period * 3 <= n; period++) {
    let from = n - period;
    while (from > 0 && same(from - 1, from - 1 + period)) from--;
    if (n - from >= period * 2 && (!best || from < best.loop)) best = { end: from + period, loop: from };
  }
  return best ?? { end: n, loop: null };
}

/**
 * The corners of a line of values a frame apart: each straight stretch as
 * long as every frame on it is within a unit of the line (the player drops
 * pulse width's lowest bit, so a steady sweep reads as uneven steps).
 */
function corners(v: ArrayLike<number>, from: number, to: number, slack: number): PulsePoint[] {
  const out: PulsePoint[] = [{ t: from, w: v[from] }];
  let a = from;
  while (a < to) {
    let b = a + 1;
    const straight = (z: number) => {
      for (let f = a + 1; f < z; f++) if (Math.abs(v[a] + ((v[z] - v[a]) * (f - a)) / (z - a) - v[f]) > slack) return false;
      return true;
    };
    while (b < to && straight(b + 1)) b++;
    out.push({ t: b, w: v[b] });
    a = b;
  }
  return out;
}

/**
 * The note a frequency register value plays: a note's own value where it
 * is one (the top notes all clamp to $FFFF), else in between by its pitch
 */
function noteOf(freq: number): number {
  // Notes past the table's 96 all play 0: the first of them
  if (!freq) return SILENT_NOTE;
  for (let n = 0; n < 96; n++) if (Math.abs(freqOf(n) - freq) <= 2) return n;
  return 12 * Math.log2(freq / freqOf(0));
}

/** A line over frames [0, end) as points, with its repeat from `loop` (frames loop..end-1 going round) */
function lineOf(v: ArrayLike<number>, end: number, loop: number | null, slack = 0): { points: PulsePoint[]; loop: number | null } {
  if (loop === null) return { points: corners(v, 0, Math.max(0, end - 1), slack), loop: null };
  // A shape's repeat runs from just after a point to the last point: one
  // round on if the repeat starts on the very first frame
  const period = end - loop;
  const shift = loop === 0 ? period : 0;
  const from = loop - 1 + shift;
  const to = end - 1 + shift;
  const points = corners(v, 0, to, slack);
  if (!points.some((p) => p.t === from)) {
    points.push({ t: from, w: v[from] });
    points.sort((a, b) => a.t - b.t);
  }
  return { points, loop: points.findIndex((p) => p.t === from) };
}

/** 12-bit values with their wraps undone: each frame within half the range of the last */
function unwrap(v: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!i) out.push(v[0]);
    else {
      let d = v[i] - v[i - 1];
      if (d > 0x800) d -= 0x1000;
      if (d < -0x800) d += 0x1000;
      out.push(out[i - 1] + d);
    }
  }
  return out;
}

/** Runs of frames in [from, to) where a value holds, skipping where it is null */
function runs<T>(at: (f: number) => T | null, from: number, to: number): { start: number; end: number; value: T }[] {
  const out: { start: number; end: number; value: T }[] = [];
  for (let f = from; f < to; f++) {
    const v = at(f);
    const last = out[out.length - 1];
    if (v === null) continue;
    if (last && last.end === f && last.value === v) last.end = f + 1;
    else out.push({ start: f, end: f + 1, value: v });
  }
  return out;
}

const COMMAND_NAMES: Record<number, string> = {
  0x4: 'vibrato from the wave table',
  0x7: 'sets the waveform by command',
  0x8: 'switches pulse programs',
  0x9: 'switches filter programs',
  0xa: 'sets the filter routing by command',
  0xb: 'sets the cutoff by command',
  0xf: 'sets the volume',
};

/**
 * Converts a song's instrument. `frames` is how long to play it for (the
 * longer, the more of a slow repeat is seen).
 */
export function importInstrument(ins: Instrument, tables: { left: Uint8Array; right: Uint8Array }[], trace: Tracer, frames: number): Imported {
  const gaps: string[] = [];
  const [, pulsePtr, filterPtr, speedPtr] = ins.tables;
  // Without its vibrato, for the pitches underneath; on another key, to tell fixed pitches
  const plainIns: Instrument = { ...ins, tables: [ins.tables[0], pulsePtr, filterPtr, 0] };
  const t = trace(plainIns, KEY, frames);
  const other = trace(plainIns, OTHER_KEY, frames);

  // The wave program: where it stops or repeats
  const wave = runOf(t.pos[0], t.control, t.freq);
  const end = Math.min(wave.end, frames);
  const loop = wave.loop;

  // Waveforms: a bar for each oscillator's runs
  const bars: Bar[] = [];
  for (const osc of OSCILLATORS) {
    for (const r of runs((f) => (t.control[f] & osc ? true : null), 0, end)) bars.push({ wave: osc, start: r.start, end: r.end });
  }
  bars.sort((a, b) => a.start - b.start);
  // After it stops, the player keeps the last waveform: held, unless that was silence
  const hold = loop !== null || (end > 0 && (t.control[end - 1] & 0xf0) !== 0);

  // The register's other bits, the same way (on all the way through, held: on for the whole note)
  const bits: Bar[] = [];
  for (const bit of [TEST, RING, SYNC]) {
    const on = runs((f) => (t.control[f] & bit ? true : null), 0, end);
    if (on.length === 1 && on[0].start === 0 && on[0].end === end && hold) bits.push({ wave: bit, start: 0, end: null });
    else for (const r of on) bits.push({ wave: bit, start: r.start, end: r.end });
  }

  // Letting go of the key itself: the gate going off and staying off
  let release: number | null = null;
  const off = Array.from(t.control).findIndex((c) => !(c & GATE));
  if (off >= 0) {
    release = off;
    if (Array.from(t.control).slice(off).some((c) => c & GATE)) gaps.push('the gate going back on after letting go');
  }

  // Pitch: fixed where another key plays the same (all of it: the whole
  // instrument, else those steps), else from the key played
  // A pitch left from the note before at first (the program sets none yet:
  // 0, played on its own), as many instruments start, for the frames it lasts
  let leading = 0;
  const pitchSet = (f: number) => {
    const p = t.pos[0][f];
    return !!p && tables[0].right[p - 1] !== PITCH_KEEP && tables[0].left[p - 1] < 0xf0;
  };
  while (leading < end && t.freq[leading] === 0 && other.freq[leading] === 0 && !pitchSet(leading)) leading++;
  // A step up past the note table plays 0 on the keys traced (it's a pitch
  // on lower ones): where both are 0, the step the row itself sets
  const tableStep = (f: number): number | null => {
    if (t.freq[f] || !pitchSet(f)) return null;
    const right = tables[0].right[t.pos[0][f] - 1];
    return right < PITCH_KEEP ? (right < 0x60 ? right : right - 0x80) : null;
  };
  const span = Math.max(1, end);
  const sameOnBoth = Array.from({ length: span }, (_, f) => t.freq[f] === other.freq[f] && tableStep(f) === null);
  const fixed = leading < end && sameOnBoth.slice(leading).every(Boolean);
  const absolute = (f: number) => noteOf(t.freq[f]);
  let fixedNote: number | null = null;
  const stepFixed = (f: number) => !fixed && sameOnBoth[Math.min(f, span - 1)];
  let semis = (f: number) => tableStep(f) ?? (stepFixed(f) ? absolute(f) - FIXED_BASE : noteOf(t.freq[f]) - KEY);
  if (fixed && end > 0) {
    const notes = Array.from({ length: end - leading }, (_, f) => Math.round(absolute(f + leading)));
    const [lo, hi] = [Math.min(...notes), Math.max(...notes)];
    fixedNote = Math.max(hi - NOTE_HIGH, Math.min(lo - NOTE_LOW, notes[0]));
    const base = fixedNote;
    semis = (f) => absolute(f) - base;
  }
  const notes: Note[] = [];
  let cur = leading ? NaN : 0;
  let curFixed = false;
  const step = (start: number, n: number, f: number, glide = 0): Note => ({ start, semis: n, ...(glide ? { glide } : {}), ...(stepFixed(f) ? { fixed: true } : {}) });
  let outside = false;
  const keep = (n: number) => {
    if (n < NOTE_LOW || n > NOTE_HIGH) outside = true;
    return Math.max(NOTE_LOW, Math.min(NOTE_HIGH, n));
  };
  const whole = (f: number) => Math.abs(semis(f) - Math.round(semis(f))) < WHOLE;
  for (let f = leading; f < end; ) {
    if (whole(f)) {
      const n = keep(Math.round(semis(f)));
      if (n !== cur || stepFixed(f) !== curFixed) notes.push(step(f, n, f));
      cur = n;
      curFixed = stepFixed(f);
      f++;
      continue;
    }
    // Between semitones: a glide to where it lands
    const from = f;
    while (f < end && !whole(f)) f++;
    if (f >= end) {
      gaps.push('slides that don’t land on a note');
      const n = keep(Math.round(semis(end - 1)));
      notes.push(step(from, n, end - 1, Math.max(1, end - 1 - from)));
      break;
    }
    const n = keep(Math.round(semis(f)));
    notes.push(step(from, n, f, f - from));
    cur = n;
    curFixed = stepFixed(f);
    f++;
  }
  if (outside) gaps.push(`pitches beyond ${NOTE_LOW} to +${NOTE_HIGH} semitones`);
  // Setting the pitch it is already on: kept too. It starts vibrato's wobble
  // again, and in a song it brings in a note slid to (the note changes, the
  // program's pitch with it)
  {
    for (let f = leading; f < end; f++) {
      const p = t.pos[0][f];
      const right = p ? tables[0].right[p - 1] : PITCH_KEEP;
      const left = p ? tables[0].left[p - 1] : 0;
      // A row sets its pitch as it finishes (a delay row on its last frame)
      const finishes = f === end - 1 || p !== t.pos[0][f + 1];
      if (!finishes || right === PITCH_KEEP || left >= 0xf0) continue;
      if (!notes.some((n) => n.start <= f && f <= n.start + (n.glide ?? 0))) {
        const n = keep(Math.round(semis(f)));
        notes.push(step(f, n, f));
      }
    }
    notes.sort((a, b) => a.start - b.start);
  }

  // Vibrato, from its speed table row
  let vibrato: Shape['vibrato'] = null;
  if (speedPtr) {
    const [left, right] = [tables[3].left[speedPtr - 1] ?? 0, tables[3].right[speedPtr - 1] ?? 0];
    vibrato = { delay: ins.vibratoDelay, turn: left & 0x7f, even: (left & 0x80) !== 0, depth: right };
  }

  // Pulse width
  let pulse = defaultPulse();
  if (pulsePtr) {
    const run = runOf(t.pos[1], t.pulse);
    // A program that doesn't start by setting a width carries on from the
    // voice's: its sweeps are all it does, so where one wraps round the
    // 12 bits (as the player's do) it carries on past, not jumps back
    const inherit = tables[1].left[pulsePtr - 1] < 0x80;
    const widths = inherit ? unwrap(t.pulse) : t.pulse;
    pulse = lineOf(widths, Math.max(1, run.end), run.loop, 1);
    if (inherit) {
      pulse.inherit = true;
      // Its first frame's move, from the program itself (traced, the width loses its lowest bit)
      const right = tables[1].right[pulsePtr - 1];
      pulse.points[0].w = tables[1].left[pulsePtr - 1] ? (right >= 0x80 ? right - 0x100 : right) : 0;
    }
  }

  // The filter
  const filter = defaultFilter();
  if (filterPtr) {
    const run = runOf(t.pos[2], t.cutoff, t.routing, t.mode);
    const fEnd = run.loop === null ? frames : run.end;
    // Chunks of a type and the voices it filters (GoatTracker's are the same whichever voice plays it)
    // (and the external input, bit 3, as routed)
    const on = (f: number) => (t.routing[f] & 0x0f ? ((t.mode[f] & 0x70) << 4) | (t.routing[f] & 0x0f) : null);
    filter.types = runs(on, 0, fEnd).map((r): FilterChunk => ({ start: r.start, end: run.loop === null && r.end === fEnd ? Math.min(r.end, frames) : r.end, passband: r.value >> 4, voices: r.value & 0x0f }));
    const lineEnd = run.loop === null ? Math.max(1, Math.min(frames, lastChange(t.cutoff, t.routing) + 1)) : run.end;
    filter.cutoff = lineOf(t.cutoff, lineEnd, run.loop);
    const res = Array.from(t.routing, (r) => r >> 4);
    filter.resonance = { points: steps(res, run.loop === null ? lineEnd : run.end + (run.loop === 0 ? run.end - run.loop : 0)), loop: null };
    if (new Set(Array.from(t.mode, (m) => m & 0x0f)).size > 1) gaps.push('volume changes');
  }

  // Envelope changes partway, and commands the shape has no place for
  if (new Set(t.ad).size > 1 || new Set(t.sr).size > 1) gaps.push('envelope changes partway');
  const commands = new Set<string>();
  for (let f = 0; f < frames; f++) {
    const p = t.pos[0][f];
    const l = p ? tables[0].left[p - 1] : 0;
    if (l >= 0xf0 && l < 0xff && COMMAND_NAMES[l & 0xf]) commands.add(COMMAND_NAMES[l & 0xf]);
  }
  gaps.push(...commands);

  const shape: Shape = {
    name: ins.name || 'Imported',
    ad: ins.ad,
    sr: ins.sr,
    bars,
    pulse,
    notes,
    waveLoop: loop,
    hold,
    vibrato,
    filter,
    fixedNote,
    release,
    hardRestart: !(ins.gateTimer & 0x80),
    bits,
    legato: (ins.gateTimer & 0x40) !== 0,
    gateFrames: ins.gateTimer & 0x3f,
    firstWave: ins.firstWave,
    pulseFromSong: !pulsePtr,
    ...(leading ? { pitchFromSong: true } : {}),
  };
  return { shape, gaps };
}

/** The last frame a value (or the routing) changes */
function lastChange(v: ArrayLike<number>, w: ArrayLike<number>): number {
  for (let f = v.length - 1; f > 0; f--) if (v[f] !== v[f - 1] || w[f] !== w[f - 1]) return f;
  return 0;
}

/** A line that plays as these steps: a point either side of each change */
function steps(v: number[], end: number): PulsePoint[] {
  const out: PulsePoint[] = [{ t: 0, w: v[0] }];
  for (let f = 1; f < end; f++) {
    if (v[f] === v[f - 1]) continue;
    if (out[out.length - 1].t !== f - 1) out.push({ t: f - 1, w: v[f - 1] });
    out.push({ t: f, w: v[f] });
  }
  return out;
}
