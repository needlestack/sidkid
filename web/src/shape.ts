// Instruments as shapes on a timeline, for the second instrument maker:
// waveforms are bars in time, one row per oscillator, and bars that overlap
// in time play together as a combined waveform. The shape is turned into a
// GoatTracker wave program for the player.

import { fastestSweep, pulseStep, sweepRows, waveLeft, WAVE_GATE, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI, type Program, type Step } from './tables';

/** The waveform rows, top to bottom: pulse last, so its width row sits under everything */
export const LANES = [WAVE_TRI, WAVE_SAW, WAVE_NOISE, WAVE_PULSE];

/** A waveform playing for a while: frames from the start of the note. */
export interface Bar {
  wave: number;
  start: number;
  /** The first frame after it, or null to keep going until the note ends. */
  end: number | null;
}

/** A pulse width (0-4095) at a time, in frames from the start of the note. */
export interface PulsePoint {
  t: number;
  w: number;
}

/**
 * Pulse width over the note: a line through points, holding after the
 * last one, or repeating from the `loop` point: from the last point it
 * goes straight back to the loop point's width and on again, so a repeat
 * can rise and fall back smoothly or jump.
 */
export interface PulseShape {
  points: PulsePoint[];
  loop: number | null;
}

/** A square wave: half the 12-bit range */
export const SQUARE = 0x800;
export const PULSE_MAX = 0xfff;

export function defaultPulse(): PulseShape {
  return { points: [{ t: 0, w: SQUARE }], loop: null };
}

export interface Shape {
  name: string;
  ad: number;
  sr: number;
  bars: Bar[];
  pulse: PulseShape;
  /** Where the waveform repeats from (a frame where it changes), or null to play through once */
  waveLoop: number | null;
}

/** Where the waveform's repeat would end: the end of the last bar, or null if a bar keeps going. */
export function loopEnd(bars: Bar[]): number | null {
  if (!bars.length || bars.some((b) => b.end === null)) return null;
  return Math.max(...bars.map((b) => b.end!));
}

/** Whether a shape's waveform repeats: from its loop point to the end of its last bar. */
export function waveLooping(shape: Pick<Shape, 'bars' | 'waveLoop'>): boolean {
  const end = loopEnd(shape.bars);
  return shape.waveLoop !== null && end !== null && shape.waveLoop < end;
}

/** The times the waveform changes before its end, where a repeat can start. */
export function waveChanges(bars: Bar[]): number[] {
  const end = loopEnd(bars) ?? Infinity;
  return spans(bars)
    .map((s) => s.start)
    .filter((t) => t < end);
}

/** A stretch of time with one waveform (oscillator bits, 0 for none). */
export interface Span {
  start: number;
  end: number | null;
  wave: number;
}

const endOf = (b: { end: number | null }) => b.end ?? Infinity;

/** What plays when, from the start of the note: consecutive spans, the last one open. */
export function spans(bars: Bar[]): Span[] {
  // Time starts with the note: nothing plays before 0
  const cuts = new Set([0]);
  for (const b of bars) {
    cuts.add(Math.max(0, b.start));
    if (b.end !== null && b.end > 0) cuts.add(b.end);
  }
  const times = [...cuts].sort((a, b) => a - b);
  const out: Span[] = [];
  times.forEach((t, i) => {
    let wave = 0;
    for (const b of bars) if (b.start <= t && t < endOf(b)) wave |= b.wave;
    const end = i + 1 < times.length ? times[i + 1] : null;
    const last = out[out.length - 1];
    if (last && last.wave === wave) last.end = end;
    else out.push({ start: t, end, wave });
  });
  return out;
}

/** Whether a shape can be stored: noise with both saw and pulse collides with the table's commands. */
export function storable(bars: Bar[]): boolean {
  return spans(bars).every((s) => (s.wave & 0xf0) < 0xe0);
}

/** Frames a wave table delay row of 1-15 lasts, counting the frame it moves on. */
export const DELAY_FRAMES = (left: number) => left + 1;
const LONGEST_DELAY = 15;
const PITCH_KEEP = 0x80;
/** Relative pitch 0: the note played */
const PITCH_NOTE = 0x00;

/**
 * The wave program for a shape: each span sets its waveform (with the gate
 * on) and waits out its time; the program then stops on the last one, or
 * with a repeat, jumps back to the rows of the span it repeats from.
 */
export function waveProgram(bars: Bar[], name: string, loop: number | null = null): Program {
  const steps: Step[] = [];
  const looping = waveLooping({ bars, waveLoop: loop });
  const end = looping ? loopEnd(bars)! : Infinity;
  let back = 0;
  for (const s of spans(bars)) {
    if (s.start >= end) break;
    if (looping && s.start <= loop!) back = steps.length;
    // The first row plays the note's pitch: the player sets the pitch only from here
    steps.push({ left: waveLeft({ type: 'wave', wave: s.wave | WAVE_GATE }), right: steps.length ? PITCH_KEEP : PITCH_NOTE });
    if (s.end === null) break;
    let rest = s.end - s.start - 1;
    while (rest > 0) {
      if (rest === 1) {
        // A row that changes nothing takes a single frame
        steps.push({ left: 0, right: PITCH_KEEP });
        rest = 0;
      } else {
        const left = Math.min(LONGEST_DELAY, rest - 1);
        steps.push({ left, right: PITCH_KEEP });
        rest -= DELAY_FRAMES(left);
      }
    }
  }
  const program: Program = { name, steps, next: null };
  if (looping) program.next = { program, step: back };
  return program;
}

/**
 * The pulse program for a shape that uses pulse: set the first width, then
 * sweep to each point in turn over the time to it; then stop (holding the
 * width), or jump back to the rows that leave the loop point. Setting the
 * width takes the first frame and each sweep a frame per frame of it, so
 * each point's width is reached exactly at its time.
 *
 * The player's sweeps move at most 127 up or 128 down a frame (the speed is
 * one signed byte); the chip itself takes any width any frame. So a steeper
 * stretch sets the width on each of its frames instead, along the line:
 * exact, at a row a frame.
 */
export function pulseProgram(bars: Bar[], pulse: PulseShape, name: string): Program | null {
  if (!bars.some((b) => b.wave & WAVE_PULSE)) return null;
  const pts = pulse.points;
  const steps: Step[] = [pulseStep({ type: 'width', width: pts[0].w })];
  const leaving: number[] = [];
  const along = (i: number, f: number, frames: number) => pts[i].w + Math.round(((pts[i + 1].w - pts[i].w) * f) / frames);
  for (let i = 0; i + 1 < pts.length; i++) {
    leaving.push(steps.length);
    const frames = Math.max(1, pts[i + 1].t - pts[i].t);
    // The repeat jumps back here, wherever the width has got to, so this
    // stretch starts by setting its first frame's width outright
    const first = i === pulse.loop ? 1 : 0;
    if (first) steps.push(pulseStep({ type: 'width', width: along(i, 1, frames) }));
    const from = first ? along(i, 1, frames) : pts[i].w;
    const change = pts[i + 1].w - from;
    const rest = frames - first;
    if (rest > 0 && fastestSweep(change) <= rest) for (const sw of sweepRows(change, rest)) steps.push(pulseStep({ type: 'sweep', ...sw }));
    else for (let f = first + 1; f <= frames; f++) steps.push(pulseStep({ type: 'width', width: along(i, f, frames) }));
  }
  const program: Program = { name, steps, next: null };
  if (pulse.loop !== null && pulse.loop < pts.length - 1) program.next = { program, step: leaving[pulse.loop] };
  return program;
}

/** The corners of the pulse width line up to `frames`, with a loop repeated to fill it. */
export function pulseLine(pulse: PulseShape, frames: number): PulsePoint[] {
  const pts = pulse.points;
  const last = pts[pts.length - 1];
  const out = pts.map((p) => ({ ...p }));
  if (pulse.loop !== null && pulse.loop < pts.length - 1) {
    // Each time round starts at the loop point's width (a jump if the last point isn't there)
    const body = pts.slice(pulse.loop);
    const period = last.t - pts[pulse.loop].t;
    for (let n = 1; last.t + (n - 1) * period < frames; n++) for (const p of body) out.push({ t: p.t + n * period, w: p.w });
  } else out.push({ t: frames, w: last.w });
  return out;
}

/**
 * Puts a bar in place: bars it lands on in its own row are cut back or
 * removed, the way a clip dropped on another overwrites it.
 */
export function place(bars: Bar[], bar: Bar): Bar[] {
  const out: Bar[] = [];
  const s = bar.start;
  const e = endOf(bar);
  for (const b of bars) {
    if (b === bar) continue;
    if (b.wave !== bar.wave || endOf(b) <= s || b.start >= e) {
      out.push(b);
      continue;
    }
    if (b.start < s) out.push({ ...b, end: s });
    if (endOf(b) > e) out.push({ ...b, start: e });
  }
  out.push(bar);
  return out.sort((a, b) => a.start - b.start || LANES.indexOf(a.wave) - LANES.indexOf(b.wave));
}

/** The pulse width (0-4095) at a time, from the line's corners (as pulseLine gives them). */
export function widthOn(line: PulsePoint[], t: number): number {
  for (let i = line.length - 1; i > 0; i--) {
    const a = line[i - 1];
    const b = line[i];
    if (t < a.t) continue;
    if (t >= b.t) return b.w;
    return a.w + ((b.w - a.w) * (t - a.t)) / (b.t - a.t);
  }
  return line[0].w;
}

/** A stretch of what is heard; `again` marks a repeat's copies, `from` where each began first time round. */
export interface HeardSpan extends Span {
  again?: boolean;
  from: number;
}

/** What is heard up to `frames`: the spans, with a repeat's copied on after its end. */
export function heardSpans(bars: Bar[], loop: number | null, frames: number): HeardSpan[] {
  const base = spans(bars);
  if (!waveLooping({ bars, waveLoop: loop })) return base.map((s) => ({ ...s, from: s.start }));
  const end = loopEnd(bars)!;
  const out: HeardSpan[] = base.filter((s) => s.start < end).map((s) => ({ ...s, end: Math.min(s.end ?? end, end), from: s.start }));
  const body = out.filter((s) => s.end! > loop!).map((s) => ({ ...s, start: Math.max(s.start, loop!) }));
  const period = end - loop!;
  for (let n = 1; end + (n - 1) * period < frames; n++) {
    for (const s of body) out.push({ start: s.start + n * period, end: s.end! + n * period, wave: s.wave, again: true, from: s.from });
  }
  return out;
}
