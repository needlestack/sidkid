// GoatTracker's tables as programs.
//
// Each of the wave, pulse and filter tables is one list of up to 255 rows,
// shared by every instrument. A row is a step the player runs, 50 times a
// second while a note plays, and an FF row ends a run of steps by jumping
// somewhere (or stopping). SIDKid shows each run as a program: a list of
// steps that then stops or loops. Programs are laid back out into a table
// when they change, so jumps follow the steps they point at.

import { noteName } from './song';

export const WAVE = 0;
export const PULSE = 1;
export const FILTER = 2;
export const SPEED = 3;

export const TABLE_LENGTH = 255;
const JUMP = 0xff;

export interface Step {
  left: number;
  right: number;
}

export interface Target {
  program: Program;
  /** A step, or steps.length for the program's end row. */
  step: number;
}

export interface Program {
  name: string;
  steps: Step[];
  /** Where to go after the last step, or null to stop. */
  next: Target | null;
}

export interface Table {
  left: Uint8Array;
  right: Uint8Array;
}

export interface Split {
  programs: Program[];
  /** The step at a 1-based table position, or null if it is not a step. */
  target(pos: number): Target | null;
}

/** Splits a table into programs at its jump rows. */
export function splitTable(table: Table, kind: number): Split {
  const programs: Program[] = [];
  // Table row of each program's first step, and where each jumps to
  const starts: number[] = [];
  const jumps: number[] = [];
  let steps: Step[] = [];
  let start = 0;
  const end = () => {
    programs.push({ name: `${KIND_NAMES[kind]} ${programs.length + 1}`, steps, next: null });
    starts.push(start);
  };
  for (let i = 0; i < table.left.length; i++) {
    if (table.left[i] === JUMP) {
      end();
      jumps.push(table.right[i]);
      steps = [];
      start = i + 1;
    } else {
      steps.push({ left: table.left[i], right: table.right[i] });
    }
  }
  // Rows after the last jump: the player would run on into empty rows
  if (steps.length) {
    end();
    jumps.push(0);
  }
  const target = (pos: number): Target | null => {
    const row = pos - 1;
    for (let i = programs.length - 1; i >= 0; i--) {
      if (row < starts[i]) continue;
      const step = row - starts[i];
      // Jumping onto an end row is undefined in GoatTracker, but some songs
      // do it, so it is kept
      return step <= programs[i].steps.length ? { program: programs[i], step } : null;
    }
    return null;
  };
  programs.forEach((p, i) => {
    if (jumps[i]) p.next = target(jumps[i]);
  });
  return { programs, target };
}

export interface Layout {
  table: Table;
  /** 1-based table position of each program's first step. */
  starts: number[];
  /** Rows the programs need; over TABLE_LENGTH means they don't fit. */
  length: number;
}

/** Lays programs out into a table, each followed by its jump row. */
export function layOut(programs: Program[]): Layout {
  const starts: number[] = [];
  let length = 0;
  for (const p of programs) {
    starts.push(length + 1);
    length += p.steps.length + 1;
  }
  const n = Math.min(length, TABLE_LENGTH);
  const table = { left: new Uint8Array(n), right: new Uint8Array(n) };
  programs.forEach((p, i) => {
    let row = starts[i] - 1;
    for (const s of p.steps) {
      if (row >= n) return;
      table.left[row] = s.left;
      table.right[row] = s.right;
      row++;
    }
    if (row >= n) return;
    table.left[row] = JUMP;
    table.right[row] = p.next ? positionOf(programs, starts, p.next) : 0;
  });
  return { table, starts, length };
}

function positionOf(programs: Program[], starts: number[], t: Target): number {
  const i = programs.indexOf(t.program);
  if (i < 0 || t.step > t.program.steps.length) return 0;
  const pos = starts[i] + t.step;
  return pos <= TABLE_LENGTH ? pos : 0;
}

export const KIND_NAMES = ['Wave', 'Pulse', 'Filter', 'Speed'];

// --- Wave steps -----------------------------------------------------------

export const WAVE_GATE = 0x01;
export const WAVE_SYNC = 0x02;
export const WAVE_RING = 0x04;
export const WAVE_TEST = 0x08;
export const WAVE_TRI = 0x10;
export const WAVE_SAW = 0x20;
export const WAVE_PULSE = 0x40;
export const WAVE_NOISE = 0x80;

const WAVE_LAST_DELAY = 0x0f;
const WAVE_SILENT = 0xe0;
const WAVE_CMD = 0xf0;
const PITCH_KEEP = 0x80;

export type WaveAction =
  /** Set the waveform register: oscillators and control bits. */
  | { type: 'wave'; wave: number }
  /** Leave the waveform as it is. */
  | { type: 'keep' }
  /** Hold this step for 1-15 more frames before its pitch change. */
  | { type: 'wait'; frames: number }
  /** Run a pattern command (1-F) with right as its value. */
  | { type: 'command'; command: number };

export type Pitch =
  | { type: 'relative'; semitones: number }
  | { type: 'fixed'; note: number }
  | { type: 'keep' };

export function waveAction(s: Step): WaveAction {
  const l = s.left;
  if (l === 0) return { type: 'keep' };
  if (l <= WAVE_LAST_DELAY) return { type: 'wait', frames: l };
  if (l < WAVE_SILENT) return { type: 'wave', wave: l };
  if (l < WAVE_CMD) return { type: 'wave', wave: l & 0x0f };
  return { type: 'command', command: l & 0x0f };
}

/** The left byte for a wave action. */
export function waveLeft(a: WaveAction): number {
  switch (a.type) {
    case 'keep':
      return 0;
    case 'wait':
      return Math.max(1, Math.min(WAVE_LAST_DELAY, a.frames));
    case 'command':
      return WAVE_CMD | (a.command & 0x0f);
    case 'wave':
      // Without an oscillator the value moves up to the silent range
      return a.wave & 0xf0 ? a.wave : WAVE_SILENT | a.wave;
  }
}

/** Whether a waveform can be stored: the noise combinations above $DF collide with commands. */
export function waveStorable(wave: number): boolean {
  return (wave & 0xf0) < WAVE_SILENT;
}

export function pitchOf(right: number): Pitch {
  if (right === PITCH_KEEP) return { type: 'keep' };
  if (right > PITCH_KEEP) return { type: 'fixed', note: right & 0x7f };
  return { type: 'relative', semitones: right < 0x60 ? right : right - 0x80 };
}

export function pitchRight(p: Pitch): number {
  switch (p.type) {
    case 'keep':
      return PITCH_KEEP;
    case 'fixed':
      // (notes past the table's 96 play a pitch of 0)
      return PITCH_KEEP | Math.max(1, Math.min(0x7f, p.note));
    case 'relative': {
      const n = Math.max(-32, Math.min(95, Math.round(p.semitones)));
      return n < 0 ? n + 0x80 : n;
    }
  }
}

/** Names of the oscillators in a waveform value, e.g. "Pulse + Triangle". */
export function waveName(wave: number): string {
  const names = [];
  if (wave & WAVE_TRI) names.push('Triangle');
  if (wave & WAVE_SAW) names.push('Saw');
  if (wave & WAVE_PULSE) names.push('Pulse');
  if (wave & WAVE_NOISE) names.push('Noise');
  return names.length ? names.join(' + ') : 'Silent';
}

export function describePitch(p: Pitch): string {
  switch (p.type) {
    case 'keep':
      return 'pitch unchanged';
    case 'fixed':
      return `always ${noteName(p.note)}`;
    case 'relative':
      if (p.semitones === 0) return 'the note played';
      return `${p.semitones > 0 ? '+' : '−'}${Math.abs(p.semitones)} semitone${Math.abs(p.semitones) === 1 ? '' : 's'}`;
  }
}

// --- Pulse and filter steps -------------------------------------------------

export type PulseAction = { type: 'width'; width: number } | { type: 'sweep'; frames: number; speed: number } | { type: 'hold' };

export function pulseAction(s: Step): PulseAction {
  if (s.left >= 0x80) return { type: 'width', width: ((s.left & 0x0f) << 8) | s.right };
  if (s.left === 0) return { type: 'hold' };
  return { type: 'sweep', frames: s.left, speed: signed(s.right) };
}

export function pulseStep(a: PulseAction): Step {
  switch (a.type) {
    case 'width': {
      const w = Math.max(0, Math.min(0xfff, Math.round(a.width)));
      return { left: 0x80 | (w >> 8), right: w & 0xff };
    }
    case 'sweep':
      return { left: clampFrames(a.frames), right: a.speed & 0xff };
    case 'hold':
      return { left: 0, right: 0 };
  }
}

export const FILTER_LOW = 0x10;
export const FILTER_BAND = 0x20;
export const FILTER_HIGH = 0x40;

export type FilterAction =
  /** Passband bits, resonance 0-15 and which voices (bits 0-2) go through the filter. */
  | { type: 'setup'; passband: number; resonance: number; voices: number }
  | { type: 'cutoff'; cutoff: number }
  | { type: 'sweep'; frames: number; speed: number };

export function filterAction(s: Step): FilterAction {
  // (voices: bits 0-2, and bit 3 the chip's external input)
  if (s.left >= 0x80) return { type: 'setup', passband: s.left & 0x70, resonance: s.right >> 4, voices: s.right & 0x0f };
  if (s.left === 0) return { type: 'cutoff', cutoff: s.right };
  return { type: 'sweep', frames: s.left, speed: signed(s.right) };
}

export function filterStep(a: FilterAction): Step {
  switch (a.type) {
    case 'setup':
      return { left: 0x80 | (a.passband & 0x70), right: ((a.resonance & 0x0f) << 4) | (a.voices & 0x0f) };
    case 'cutoff':
      return { left: 0, right: Math.max(0, Math.min(255, Math.round(a.cutoff))) };
    case 'sweep':
      return { left: clampFrames(a.frames), right: a.speed & 0xff };
  }
}

export function passbandName(bits: number): string {
  const names = [];
  if (bits & FILTER_LOW) names.push('low');
  if (bits & FILTER_BAND) names.push('band');
  if (bits & FILTER_HIGH) names.push('high');
  return names.length ? `${names.join(' + ')} pass` : 'no passband';
}

function signed(b: number): number {
  return b < 0x80 ? b : b - 0x100;
}

function clampFrames(n: number): number {
  return Math.max(1, Math.min(0x7f, Math.round(n)));
}

export function percent(f: number): string {
  return `${Math.round(f * 100)}%`;
}

// --- Starting points ------------------------------------------------------

// --- Sweeps as goals --------------------------------------------------------

// The player sweeps by adding a signed byte each frame, for up to 127 frames
// a row. A sweep to a goal is laid out as one or two runs of rows: the first
// at a speed one faster than the second, so it lands exactly on the goal,
// with long runs split at 127 frames.

const ROW_FRAMES = 0x7f;
export const FASTEST_UP = 127;
export const FASTEST_DOWN = 128;

export interface Sweep {
  frames: number;
  speed: number;
}

/** The fewest frames a sweep can make a change in. */
export function fastestSweep(change: number): number {
  return Math.max(1, Math.ceil(change >= 0 ? change / FASTEST_UP : -change / FASTEST_DOWN));
}

/** Rows that change a value by exactly `change` over `frames` (at least fastestSweep). */
export function sweepRows(change: number, frames: number): Sweep[] {
  const sign = change < 0 ? -1 : 1;
  const size = Math.abs(change);
  const slow = Math.floor(size / frames);
  const fast = size - slow * frames;
  const out: Sweep[] = [];
  const run = (n: number, speed: number) => {
    for (; n > 0; n -= ROW_FRAMES) out.push({ frames: Math.min(ROW_FRAMES, n), speed });
  };
  run(fast, sign * (slow + 1));
  run(frames - fast, sign * slow);
  return out;
}
