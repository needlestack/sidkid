// GoatTracker's tables as programs.
//
// Each of the wave, pulse and filter tables is one list of up to 255 rows,
// shared by every instrument. A row is a step the player runs, 50 times a
// second while a note plays, and an FF row ends a run of steps by jumping
// somewhere (or stopping). SIDKid shows each run as a program: a list of
// steps that then stops or loops. Programs are laid back out into a table
// when they change, so jumps follow the steps they point at.

import { describeCommand, noteName } from './song';

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

/** The program and step a 1-based table position falls in. */
export function locate(programs: Program[], layout: Layout, pos: number): { program: number; step: number } | null {
  for (let i = programs.length - 1; i >= 0; i--) {
    if (pos < layout.starts[i]) continue;
    const step = pos - layout.starts[i];
    return step <= programs[i].steps.length ? { program: i, step } : null;
  }
  return null;
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
      return PITCH_KEEP | Math.max(1, Math.min(0x5f, p.note));
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
  if (s.left >= 0x80) return { type: 'setup', passband: s.left & 0x70, resonance: s.right >> 4, voices: s.right & 0x07 };
  if (s.left === 0) return { type: 'cutoff', cutoff: s.right };
  return { type: 'sweep', frames: s.left, speed: signed(s.right) };
}

export function filterStep(a: FilterAction): Step {
  switch (a.type) {
    case 'setup':
      return { left: 0x80 | (a.passband & 0x70), right: ((a.resonance & 0x0f) << 4) | (a.voices & 0x07) };
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

function voiceList(bits: number): string {
  const v = [1, 2, 3].filter((n) => bits & (1 << (n - 1)));
  if (!v.length) return 'no voices';
  return `voice${v.length > 1 ? 's' : ''} ${v.join(', ')}`;
}

function signed(b: number): number {
  return b < 0x80 ? b : b - 0x100;
}

function clampFrames(n: number): number {
  return Math.max(1, Math.min(0x7f, Math.round(n)));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What a step does, in plain words. */
export function describeStep(kind: number, s: Step): string {
  if (kind === WAVE) {
    const a = waveAction(s);
    const pitch = describePitch(pitchOf(s.right));
    switch (a.type) {
      case 'wave': {
        const gate = a.wave & WAVE_GATE ? '' : ', gate off';
        const extras = [a.wave & WAVE_SYNC && 'sync', a.wave & WAVE_RING && 'ring', a.wave & WAVE_TEST && 'test bit'].filter(Boolean);
        return `${waveName(a.wave)}${extras.length ? ` (${extras.join(', ')})` : ''}${gate} · ${pitch}`;
      }
      case 'keep':
        return `Same wave · ${pitch}`;
      case 'wait':
        return `Wait ${plural(a.frames, 'frame')}, then ${pitch}`;
      case 'command':
        return describeCommand(a.command, s.right) || 'Does nothing';
    }
  }
  if (kind === PULSE) {
    const a = pulseAction(s);
    switch (a.type) {
      case 'width':
        return `Width ${percent(a.width / 4096)}`;
      case 'sweep':
        return `${a.speed >= 0 ? 'Widen' : 'Narrow'} by ${Math.abs(a.speed)} a frame for ${plural(a.frames, 'frame')}`;
      case 'hold':
        return 'Hold here';
    }
  }
  if (kind === FILTER) {
    const a = filterAction(s);
    switch (a.type) {
      case 'setup':
        return `${cap(passbandName(a.passband))}, resonance ${a.resonance}, on ${voiceList(a.voices)}`;
      case 'cutoff':
        return `Cutoff ${a.cutoff}`;
      case 'sweep':
        return `${a.speed >= 0 ? 'Open' : 'Close'} by ${Math.abs(a.speed)} a frame for ${plural(a.frames, 'frame')}`;
    }
  }
  return '';
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

export function percent(f: number): string {
  return `${Math.round(f * 100)}%`;
}

// --- Starting points ------------------------------------------------------

interface Preset {
  name: string;
  hint: string;
  rows: [number, number][];
  /** Step to loop back to, or null to stop. */
  loop: number | null;
}

// Mostly from the examples in GoatTracker's readme
export const PRESETS: Preset[][] = [
  [
    { name: 'Saw', hint: 'Sawtooth at the note played: bright and buzzy', rows: [[0x21, 0x00]], loop: null },
    { name: 'Flute', hint: 'A frame of pulse, then triangle', rows: [[0x41, 0x00], [0x11, 0x00]], loop: null },
    { name: 'Koto', hint: 'Starts a semitone high for one frame, with the gate off after it', rows: [[0x41, 0x01], [0x40, 0x00]], loop: null },
    {
      name: 'Snare',
      hint: 'Noise and pulse at fixed pitches, so it sounds the same on any note. Pair with a 50% pulse width.',
      rows: [[0x81, 0xd0], [0x41, 0xaa], [0x41, 0xa4], [0x80, 0xd4], [0x80, 0xd1]],
      loop: null,
    },
    { name: 'Tick + pulse', hint: 'A frame of high noise, like a hi-hat, then pulse', rows: [[0x81, 0xdf], [0x41, 0x00]], loop: null },
    { name: 'Major arpeggio', hint: 'Cycles root, third, fifth and octave every frame: a chord on one voice', rows: [[0x41, 0x00], [0x00, 0x04], [0x00, 0x07], [0x00, 0x0c], [0x00, 0x00]], loop: 1 },
    { name: 'Minor chord', hint: 'A slower minor arpeggio, three frames a note', rows: [[0x21, 0x00], [0x02, 0x03], [0x02, 0x07], [0x02, 0x00]], loop: 1 },
    { name: 'Pulse / triangle', hint: 'Swaps between pulse and triangle every few frames, leaving the pitch free for slides', rows: [[0x41, 0x00], [0x03, 0x80], [0x11, 0x80], [0x03, 0x80], [0x41, 0x80]], loop: 1 },
  ],
  [
    { name: 'Square', hint: 'Width 50%: a hollow square wave', rows: [[0x88, 0x00]], loop: null },
    { name: 'Thin', hint: 'A narrow pulse: thin and nasal', rows: [[0x81, 0x00]], loop: null },
    { name: 'Slow sweep', hint: 'Starts thin, then widens and narrows forever', rows: [[0x80, 0x10], [0x20, 0x40], [0x40, 0xe0], [0x40, 0x20]], loop: 2 },
  ],
  [
    { name: 'Low pass', hint: 'Low pass on voice 1, fairly closed: muffled', rows: [[0x90, 0xf1], [0x00, 0x40]], loop: null },
    { name: 'Wah sweep', hint: 'Band pass on all voices, cutoff opening and closing forever', rows: [[0xa0, 0x87], [0x00, 0x00], [0x7f, 0x01], [0x7f, 0x01], [0x7f, 0xff], [0x7f, 0xff]], loop: 2 },
    { name: 'High then low', hint: 'A frame of bright high pass on voice 2, then low pass', rows: [[0xc0, 0xf2], [0x00, 0xf0], [0x90, 0xf2], [0x00, 0x50]], loop: null },
    { name: 'Filter off', hint: 'Takes every voice out of the filter', rows: [[0x80, 0x00]], loop: null },
  ],
];

export function programFromPreset(p: Preset): Program {
  const program: Program = { name: p.name, steps: p.rows.map(([left, right]) => ({ left, right })), next: null };
  if (p.loop !== null) program.next = { program, step: p.loop };
  return program;
}

/** A new step that fits after the given one. */
export function defaultStep(kind: number): Step {
  if (kind === WAVE) return { left: 0x41, right: 0x00 };
  if (kind === PULSE) return { left: 0x88, right: 0x00 };
  return { left: 0x00, right: 0x80 };
}
