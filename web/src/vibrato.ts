// Vibrato and pitch slides, worked out the way GoatTracker's player does
// them, so their settings can be shown as a picture and in plain numbers.
//
// Both read a row of the speed table. For vibrato the left byte is how many
// frames before the direction turns (less is faster) and the right byte is
// how far the pitch moves each frame. For a slide the two bytes are one
// 16-bit amount added to the pitch each frame. With the left byte's top bit
// set, the amount is instead worked out from the note: a semitone's step,
// halved right-byte times, so it sounds the same on every note.

const EVEN = 0x80;

/** The chip's frequency register for a GoatTracker note (PAL; A-4, note 57, is 440 Hz). */
export function freqOf(note: number): number {
  return Math.min(0xffff, Math.round((440 * 2 ** ((note - 57) / 12) * 16777216) / 985248));
}

/** A semitone's step at a note, in frequency register units. */
function semitoneStep(note: number): number {
  return freqOf(note + 1) - freqOf(note);
}

export interface Wobble {
  /** Frames before the direction turns (0-127): more is slower */
  turn: number;
  /** The same depth on every note: depth is then how many times a semitone's step is halved */
  even: boolean;
  depth: number;
}

export function wobbleOf(left: number, right: number): Wobble {
  return { turn: left & 0x7f, even: (left & EVEN) !== 0, depth: right };
}

export function wobbleRow(w: Wobble): [number, number] {
  return [(w.even ? EVEN : 0) | (w.turn & 0x7f), w.depth & 0xff];
}

/** How far the pitch moves each frame, in register units. */
function perFrame(w: Wobble, note: number): number {
  return w.even ? semitoneStep(note) >> Math.min(15, w.depth) : w.depth;
}

/**
 * The pitch, in semitones from the note, each frame of a held note:
 * steady for the delay, then wobbling. As in the player, the delay counts
 * down to 1 and the vibrato runs from there.
 */
export function vibratoCurve(w: Wobble, note: number, delay: number, frames: number): Float64Array {
  const out = new Float64Array(frames);
  const base = freqOf(note);
  const speed = perFrame(w, note);
  let freq = base;
  let time = 0;
  let wait = delay;
  for (let f = 0; f < frames; f++) {
    if (wait > 1) wait--;
    else if (wait) {
      if (time < 0x80 && time > w.turn) time ^= 0xff;
      time = (time + 2) & 0xff;
      freq = (freq + (time & 1 ? -speed : speed)) & 0xffff;
    }
    out[f] = 12 * Math.log2(Math.max(1, freq) / base);
  }
  return out;
}

/** How many times a second the pitch swings up and back, and by how much either way (semitones). */
export function vibratoSize(w: Wobble, note: number): { rate: number; depth: number } {
  const curve = vibratoCurve(w, note, 1, 400);
  let turns = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let f = 100; f < curve.length; f++) {
    lo = Math.min(lo, curve[f]);
    hi = Math.max(hi, curve[f]);
    const a = curve[f - 1] - curve[f - 2];
    const b = curve[f] - curve[f - 1];
    if (a && b && Math.sign(a) !== Math.sign(b)) turns++;
  }
  // Two turns make a swing; the curve covers 300 frames, 6 seconds
  return { rate: turns / 2 / 6, depth: Number.isFinite(hi) ? (hi - lo) / 2 : 0 };
}

/** A slide's movement each frame, in semitones at a note (signed by direction elsewhere). */
export function slideSemitones(left: number, right: number, note: number): number {
  const speed = left & EVEN ? semitoneStep(note) >> Math.min(15, right) : (left << 8) | right;
  return 12 * Math.log2((freqOf(note) + speed) / freqOf(note));
}

/** Plain words for an amount of pitch, e.g. "a quarter of a semitone". */
export function semitoneText(n: number): string {
  if (n >= 0.95) return `${Math.round(n * 10) / 10} semitone${Math.abs(n - 1) < 0.05 ? '' : 's'}`;
  if (n >= 0.01) return `${Math.round(n * 100)} cents`;
  return 'under a cent';
}
