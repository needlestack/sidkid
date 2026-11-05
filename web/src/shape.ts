// Instruments as shapes on a timeline, for the second instrument maker:
// waveforms are bars in time, one row per oscillator, and bars that overlap
// in time play together as a combined waveform. The shape is turned into a
// GoatTracker wave program for the player.

import { fastestSweep, pulseStep, sweepRows, waveLeft, WAVE_GATE, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI, type Program, type Step } from './tables';

/** The waveform rows, top to bottom. */
export const LANES = [WAVE_TRI, WAVE_SAW, WAVE_PULSE, WAVE_NOISE];

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
 * last one, or repeating from the `loop` point (the last point is kept at
 * the loop point's width, so each time round starts where it began).
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
 * on) and waits out its time; the program then stops on the last one.
 */
export function waveProgram(bars: Bar[], name: string): Program {
  const steps: Step[] = [];
  for (const s of spans(bars)) {
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
  return { name, steps, next: null };
}

/**
 * The pulse program for a shape that uses pulse: set the first width, then
 * sweep to each point in turn over the time to it; then stop (holding the
 * width), or jump back to the sweep that leaves the loop point. Setting the
 * width takes the first frame and each sweep a frame per frame of it, so
 * each point's width is reached exactly at its time.
 */
export function pulseProgram(bars: Bar[], pulse: PulseShape, name: string): Program | null {
  if (!bars.some((b) => b.wave & WAVE_PULSE)) return null;
  const pts = pulse.points;
  const steps: Step[] = [pulseStep({ type: 'width', width: pts[0].w })];
  const leaving: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    leaving.push(steps.length);
    const change = pts[i + 1].w - pts[i].w;
    // Too steep for the player (127 up or 128 down a frame) takes a little longer
    const frames = Math.max(pts[i + 1].t - pts[i].t, fastestSweep(change));
    for (const sw of sweepRows(change, frames)) steps.push(pulseStep({ type: 'sweep', ...sw }));
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
    const body = pts.slice(pulse.loop + 1);
    const period = last.t - pts[pulse.loop].t;
    for (let n = 1; last.t + (n - 1) * period < frames; n++) for (const p of body) out.push({ t: p.t + n * period, w: p.w });
  } else out.push({ t: frames, w: last.w });
  return out;
}

/** Whether a pulse width point can go to a width: no faster a change from its neighbours than the player can sweep. */
export function pulseRange(pts: PulsePoint[], i: number): [number, number] {
  let lo = 0;
  let hi = PULSE_MAX;
  const t = pts[i].t;
  const prev = pts[i - 1];
  const next = pts[i + 1];
  if (prev) {
    lo = Math.max(lo, prev.w - 128 * (t - prev.t));
    hi = Math.min(hi, prev.w + 127 * (t - prev.t));
  }
  if (next) {
    lo = Math.max(lo, next.w - 127 * (next.t - t));
    hi = Math.min(hi, next.w + 128 * (next.t - t));
  }
  return lo <= hi ? [lo, hi] : [0, PULSE_MAX];
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
