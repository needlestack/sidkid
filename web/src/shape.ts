// Instruments as shapes on a timeline, for the second instrument maker:
// waveforms are bars in time, one row per oscillator, and bars that overlap
// in time play together as a combined waveform. The shape is turned into a
// GoatTracker wave program for the player.

import { pulseStep, waveLeft, WAVE_GATE, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI, type Program, type Step } from './tables';

/** The waveform rows, top to bottom. */
export const LANES = [WAVE_TRI, WAVE_SAW, WAVE_PULSE, WAVE_NOISE];

/** A waveform playing for a while: frames from the start of the note. */
export interface Bar {
  wave: number;
  start: number;
  /** The first frame after it, or null to keep going until the note ends. */
  end: number | null;
}

export interface Shape {
  name: string;
  ad: number;
  sr: number;
  bars: Bar[];
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
  const cuts = new Set([0]);
  for (const b of bars) {
    cuts.add(b.start);
    if (b.end !== null) cuts.add(b.end);
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

/**
 * The wave program for a shape: each span sets its waveform (with the gate
 * on) and waits out its time; the program then stops on the last one.
 */
export function waveProgram(bars: Bar[], name: string): Program {
  const steps: Step[] = [];
  for (const s of spans(bars)) {
    steps.push({ left: waveLeft({ type: 'wave', wave: s.wave | WAVE_GATE }), right: PITCH_KEEP });
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

/** A pulse program for shapes that use pulse: a square wave, until pulse gets a shape of its own. */
export function pulseProgram(bars: Bar[], name: string): Program | null {
  if (!bars.some((b) => b.wave & WAVE_PULSE)) return null;
  return { name, steps: [pulseStep({ type: 'width', width: 0x800 })], next: null };
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
