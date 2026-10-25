// The GoatTracker song model, read from the engine's own .sng output (GTS5).
// The engine converts older formats on load, so only GTS5 is parsed here.

export const MAX_PATTERN_ROWS = 128;

// Order list bytes
export const REPEAT = 0xd0;
export const TRANSDOWN = 0xe0;
export const TRANSUP = 0xf0;
export const LOOPSONG = 0xff;

// Pattern note bytes
export const FIRSTNOTE = 0x60;
export const LASTNOTE = 0xbc;
export const REST = 0xbd;
export const KEYOFF = 0xbe;
export const KEYON = 0xbf;
export const ENDPATT = 0xff;

export const CMD_TONEPORTA = 3;

export interface Instrument {
  name: string;
  ad: number;
  sr: number;
  /** Wave, pulse, filter and speed table pointers (1-based, 0 = none). */
  tables: [number, number, number, number];
  vibratoDelay: number;
  gateTimer: number;
  firstWave: number;
}

export interface Row {
  /** FIRSTNOTE..LASTNOTE, REST, KEYOFF or KEYON. */
  note: number;
  /** 0 = keep the current instrument. */
  instrument: number;
  command: number;
  data: number;
}

export interface OrderList {
  /** Pattern numbers and REPEAT/TRANSPOSE commands, without the loop. */
  entries: number[];
  /** Index into entries the voice jumps back to at the end. */
  restart: number;
}

export interface Song {
  title: string;
  author: string;
  copyright: string;
  /** Per subsong, one order list per voice. */
  subsongs: OrderList[][];
  /** Index 1-63; index 0 is unused, as in GoatTracker. */
  instruments: Instrument[];
  /** Wave, pulse, filter and speed tables: left and right columns. */
  tables: { left: Uint8Array; right: Uint8Array }[];
  patterns: Row[][];
}

class Reader {
  pos = 0;
  constructor(private bytes: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error('Song file is truncated');
    return this.bytes[this.pos++];
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error('Song file is truncated');
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  text(n: number): string {
    const field = this.take(n);
    const end = field.indexOf(0);
    return String.fromCharCode(...(end < 0 ? field : field.subarray(0, end))).trim();
  }
}

export function parseSong(bytes: Uint8Array): Song {
  const r = new Reader(bytes);
  if (r.text(4) !== 'GTS5') throw new Error('Not a GTS5 song');
  const title = r.text(32);
  const author = r.text(32);
  const copyright = r.text(32);

  const subsongs: OrderList[][] = [];
  const songCount = r.byte();
  for (let s = 0; s < songCount; s++) {
    const voices: OrderList[] = [];
    for (let c = 0; c < 3; c++) {
      // Stored length counts the loop command; its target byte follows
      const length = r.byte();
      const data = r.take(length + 1);
      voices.push({ entries: Array.from(data.subarray(0, length - 1)), restart: data[length] });
    }
    subsongs.push(voices);
  }

  const instruments: Instrument[] = [emptyInstrument()];
  const instrumentCount = r.byte();
  for (let i = 1; i <= instrumentCount; i++) {
    const [ad, sr, wave, pulse, filter, speed, vibratoDelay, gateTimer, firstWave] = r.take(9);
    instruments.push({ ad, sr, tables: [wave, pulse, filter, speed], vibratoDelay, gateTimer, firstWave, name: r.text(16) });
  }
  while (instruments.length < 64) instruments.push(emptyInstrument());

  const tables = [];
  for (let t = 0; t < 4; t++) {
    const n = r.byte();
    tables.push({ left: r.take(n), right: r.take(n) });
  }

  const patterns: Row[][] = [];
  const patternCount = r.byte();
  for (let p = 0; p < patternCount; p++) {
    const data = r.take(r.byte() * 4);
    const rows: Row[] = [];
    for (let i = 0; i < data.length && data[i] !== ENDPATT; i += 4) {
      rows.push({ note: data[i], instrument: data[i + 1], command: data[i + 2], data: data[i + 3] });
    }
    patterns.push(rows);
  }

  return { title, author, copyright, subsongs, instruments, tables, patterns };
}

function emptyInstrument(): Instrument {
  return { name: '', ad: 0, sr: 0, tables: [0, 0, 0, 0], vibratoDelay: 0, gateTimer: 0, firstWave: 0 };
}

export interface OrderStep {
  /** Index of the pattern entry in the order list. */
  order: number;
  pattern: number;
  /** Semitones, -16 to +14. */
  transpose: number;
  /** True for the first pattern after jumping back to the loop point. */
  looped: boolean;
}

/**
 * Steps through an order list the way the playroutine's sequencer does:
 * transpose and repeat commands apply to the pattern after them, and the
 * end jumps back to the restart position. Yields forever unless the
 * restart position is invalid, where GoatTracker stops the song.
 */
export function* orderSteps(list: OrderList): Generator<OrderStep> {
  const bytes = [...list.entries, LOOPSONG, list.restart];
  const length = list.entries.length;
  let ptr = 0;
  let transpose = 0;
  let repeat = 0;
  let looped = false;
  for (;;) {
    if (bytes[ptr] === LOOPSONG) {
      ptr = bytes[ptr + 1];
      if (ptr >= length) return;
      looped = true;
    }
    if (bytes[ptr] >= TRANSDOWN && bytes[ptr] < LOOPSONG) transpose = bytes[ptr++] - TRANSUP;
    if (bytes[ptr] >= REPEAT && bytes[ptr] < TRANSDOWN) repeat = bytes[ptr++] - REPEAT;
    const order = ptr;
    const pattern = bytes[ptr];
    if (repeat) repeat--;
    else ptr++;
    yield { order, pattern, transpose, looped };
    looped = false;
  }
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** GoatTracker note number (0 = C-0) as a name, e.g. "C#3". */
export function noteName(n: number): string {
  return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
}

const COMMANDS: Record<number, (d: number) => string> = {
  1: (d) => `Slide up (speed ${hex2(d)})`,
  2: (d) => `Slide down (speed ${hex2(d)})`,
  3: (d) => (d ? `Slide into this note (speed ${hex2(d)})` : 'Slide into this note'),
  4: (d) => `Vibrato (${hex2(d)})`,
  5: (d) => `Attack ${hex1(d >> 4)}, decay ${hex1(d & 15)}`,
  6: (d) => `Sustain ${hex1(d >> 4)}, release ${hex1(d & 15)}`,
  7: (d) => `Waveform ${hex2(d)}`,
  8: (d) => `Wave program ${hex2(d)}`,
  9: (d) => `Pulse program ${hex2(d)}`,
  10: (d) => `Filter program ${hex2(d)}`,
  11: (d) => `Filter routing ${hex2(d)}`,
  12: (d) => `Filter cutoff ${hex2(d)}`,
  13: (d) => `Volume ${d & 15}`,
  14: (d) => `Swing tempo (${hex2(d)})`,
  15: (d) => (d >= 0x80 ? `Tempo ${d & 0x7f} for this voice` : `Tempo ${d}`),
};

/** A plain-language description of a pattern command, or "" for none. */
export function describeCommand(command: number, data: number): string {
  return COMMANDS[command]?.(data) ?? '';
}

function hex1(n: number) {
  return n.toString(16).toUpperCase();
}

function hex2(n: number) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
