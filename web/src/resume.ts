// A note picking up where it left off, after a note on another track had its
// voice for a while. Played as a variant of the note's instrument that starts
// part-way through: its first frame sets the waveform, pitch, pulse width and
// filter to where the note had got, and then it joins the instrument's own
// programs at the row the note was on (the rest of that row first, if it was
// part-way through a wait or a sweep). Everything is ordinary GoatTracker
// data: an instrument whose tables start at rows of their own.
//
// Where the note had got is read off a trace of the instrument, so it is the
// player's own idea of it, not this file's.

import { ATTACK_MS, DECAY_MS } from './adsr';
import type { Trace } from './engine/analyzer';
import type { Sound } from './instruments';
import { filterAction, filterStep, pitchRight, pulseAction, pulseStep, waveAction, waveLeft, waveStorable, type Program, type Step, type Target } from './tables';
import { freqOf } from './vibrato';

/**
 * A resume's gate timer: the instrument's own frames of gate off before a
 * note (so the envelope starts again, and the player's tick, which decides
 * the frames it runs effects like vibrato, keeps in step), but no hard
 * restart. Its lead is the instrument's, like any note's.
 */
const NO_HARD_RESTART = 0x80;
/** The quickest attack and decay, to land on the sustain level at once */
const SNAP_AD = 0x00;
const KEY = 48;

/** An instrument played on a key, and an octave up (to tell pitches that follow the key from fixed ones) */
export interface ResumeTraces {
  key: Trace;
  octave: Trace;
  /** On the key without its vibrato (with one), to see where the vibrato starts */
  plain: Trace | null;
}
export const RESUME_KEYS = [KEY, KEY + 12];

/** Frames an envelope takes to get to its sustain level, at a clock */
function envelopeFrames(ad: number, fps: number, clock: number): number {
  const ms = ATTACK_MS[ad >> 4] + DECAY_MS[ad & 15];
  return (ms / 1000) * (1e6 / clock) * fps;
}

/** Frames already spent on the row a frame runs from, counting back while it stayed there */
function spent(pos: Uint8Array, f: number, rowFrames: number): number {
  let e = f;
  while (e > 0 && pos[e - 1] === pos[f]) e--;
  return (f - e) % rowFrames;
}

/** The nearest note to a frequency */
function noteOf(freq: number): number {
  let best = 0;
  for (let n = 1; n < 96; n++) if (Math.abs(freqOf(n) - freq) < Math.abs(freqOf(best) - freq)) best = n;
  return best;
}

/**
 * The variant of a sound that picks a note up `at` frames in, or 'silent'
 * when there is nothing left to pick up (the instrument had let go of it
 * itself), or null when it can't be done (a waveform the table can't hold).
 */
export function resumeSound(base: Sound, at: number, t: ResumeTraces, fps: number, clock: number): Sound | 'silent' | null {
  const s = base.shape;
  if (s.release !== null && at >= s.release) return 'silent';
  if (at < 1 || at + 1 >= t.key.frames) return null;
  const { key, octave } = t;
  const next = at + 1;

  // The waveform and pitch where the note had got, then on from the row it was on
  const wave = key.control[at];
  if (!waveStorable(wave)) return null;
  const freq = key.freq[at];
  // The same on another key: a fixed pitch; else a step from the key played
  const pitch = !freq ? 0x80 : freq === octave.freq[at] ? pitchRight({ type: 'fixed', note: noteOf(freq) }) : pitchRight({ type: 'relative', semitones: noteOf(freq) - KEY });
  const waveSteps: Step[] = [{ left: waveLeft({ type: 'wave', wave }), right: pitch }];
  const waveNext = join(base.wave, key.pos[0], next, waveSteps, (row) => {
    const a = waveAction(row);
    // A wait lasts its frames and one more; its pitch comes on the last
    if (a.type !== 'wait') return null;
    return { frames: a.frames + 1, rest: (left) => ({ left: left - 1, right: row.right }) };
  });

  let pulse: Program | null = null;
  if (base.pulse) {
    const steps: Step[] = [pulseStep({ type: 'width', width: key.pulse[at] })];
    const n = join(base.pulse, key.pos[1], next, steps, (row) => {
      const a = pulseAction(row);
      return a.type === 'sweep' ? { frames: a.frames, rest: (left) => pulseStep({ ...a, frames: left }) } : null;
    });
    pulse = { name: `${s.name} from ${at}`, steps, next: n };
  }

  let filter: Program | null = null;
  if (base.filter) {
    // The type, resonance and routing, and the cutoff in the same frame
    const steps: Step[] = [
      filterStep({ type: 'setup', passband: key.mode[at] & 0x70, resonance: key.routing[at] >> 4, voices: key.routing[at] & 0x07 }),
      filterStep({ type: 'cutoff', cutoff: key.cutoff[at] }),
    ];
    const n = join(base.filter, key.pos[2], next, steps, (row) => {
      const a = filterAction(row);
      return a.type === 'sweep' ? { frames: a.frames, rest: (left) => filterStep({ ...a, frames: left }) } : null;
    });
    filter = { name: `${s.name} from ${at}`, steps, next: n };
  }

  // Past the attack and decay: get back to the sustain level at once
  const settled = at >= envelopeFrames(s.ad, fps, clock);
  const firstWave = key.control[at - 1] | 0x01;
  return {
    name: `${s.name} from ${at}`,
    shape: s,
    wave: { name: `${s.name} from ${at}`, steps: waveSteps, next: waveNext },
    pulse,
    filter,
    speeds: [],
    vibrato: base.vibrato,
    base,
    overrides: {
      ad: settled ? SNAP_AD : s.ad,
      gateTimer: Math.max(1, s.gateFrames & 0x3f) | NO_HARD_RESTART,
      firstWave: firstWave >= 0xfe ? 0x09 : firstWave,
      // Once the vibrato is going: straight away (see tuneVibrato for before)
      vibratoDelay: s.vibrato ? 1 : 0,
    },
  };
}

/** The first frame the vibrato moves the pitch (-1: never, in the trace) */
export function vibratoStart(t: ResumeTraces): number {
  if (!t.plain) return -1;
  for (let f = 0; f < t.key.frames; f++) if (t.key.freq[f] !== t.plain.freq[f]) return f;
  return -1;
}

/**
 * Where a variant's program goes after its first rows: the row the note's
 * program runs `frame` from. If it was part-way through a row that lasts
 * (a wait, a sweep), the rest of that row is added to `steps` first, and
 * it goes on from the row after.
 */
function join(program: Program, pos: Uint8Array, frame: number, steps: Step[], lasting: (row: Step) => { frames: number; rest: (left: number) => Step } | null): Target | null {
  const at = pos[frame];
  if (!at) return null;
  // On the jump at its end: where it jumps to (the jump takes no frame of its own)
  if (at - 1 === program.steps.length) return program.next;
  if (at - 1 > program.steps.length) return null;
  const row = program.steps[at - 1];
  const long = lasting(row);
  const done = long ? spent(pos, frame, long.frames) : 0;
  if (!long || !done) return { program, step: at - 1 };
  steps.push(long.rest(long.frames - done));
  // The row after; past the last, where the program's jump goes (the player
  // follows one jump a frame, so it mustn't jump onto another)
  return at < program.steps.length ? { program, step: at } : program.next;
}
