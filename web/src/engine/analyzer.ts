// A second engine instance on the main thread, for looking at songs rather
// than playing them: it converts any .sng version to the current format,
// scans playback silently to find when every row plays, and traces what a
// single note does frame by frame.

import createSidKid, { type SidKidModule } from '@engine/sidkid.js';
import type { Instrument } from '../song';
import { configure, writeInstrument, writeTables, type TableData } from './configure';
import type { Settings } from './protocol';
import { wasmBytes } from './wasm';

const SONG_PATH = '/song.sng';
const CANONICAL_PATH = '/canonical.sng';
const MAX_EVENTS = 400000;
// 20 minutes at PAL speed; songs that never loop stop here
const MAX_SECONDS = 20 * 60;

export class Analyzer {
  private constructor(
    private sk: SidKidModule,
    private events: number,
  ) {}

  static async create(): Promise<Analyzer> {
    const sk = await createSidKid({ wasmBinary: await wasmBytes() });
    sk._sk_init(44100, 0, 0, 0);
    return new Analyzer(sk, sk._malloc(MAX_EVENTS * 8));
  }

  private path(path: string): number {
    const ptr = this.sk._malloc(path.length + 1);
    for (let i = 0; i < path.length; i++) this.sk.HEAPU8[ptr + i] = path.charCodeAt(i);
    this.sk.HEAPU8[ptr + path.length] = 0;
    return ptr;
  }

  /** Loads a song; returns it re-saved in the current (GTS5) format, or null if it is not a song. */
  load(bytes: ArrayBuffer): Uint8Array | null {
    const { sk } = this;
    sk.FS.writeFile(SONG_PATH, new Uint8Array(bytes));
    const songPath = this.path(SONG_PATH);
    const canonicalPath = this.path(CANONICAL_PATH);
    try {
      if (!sk._sk_load_song(songPath)) return null;
      if (!sk._sk_save_song(canonicalPath)) return null;
      return sk.FS.readFile(CANONICAL_PATH);
    } finally {
      sk._free(songPath);
      sk._free(canonicalPath);
    }
  }

  /** Rows read during one pass of the song: see sk_scan in engine/sidkid.h. */
  scan(subsong: number, settings: Settings): Uint32Array {
    const { sk } = this;
    configure(sk, settings);
    const fps = (settings.ntsc ? 60 : 50) * (settings.multiplier || 0.5);
    const count = sk._sk_scan(subsong, Math.round(MAX_SECONDS * fps), this.events, MAX_EVENTS);
    return new Uint32Array(sk.HEAPU8.buffer, this.events, count * 2).slice();
  }

  /**
   * Plays one note silently and records what the player writes to the SID
   * each frame, from when the note starts. Uses instrument 63, and leaves
   * the engine's tables set.
   */
  trace(tables: TableData[], instrument: Instrument, note: number, frames: number, settings: Settings): Trace {
    const { sk } = this;
    configure(sk, settings);
    sk._sk_reset();
    writeTables(sk, tables);
    writeInstrument(sk, TRACE_INSTRUMENT, instrument);
    sk._sk_note_on(0, note, TRACE_INSTRUMENT);
    const trace: Trace = {
      frames,
      freq: new Uint16Array(frames),
      control: new Uint8Array(frames),
      pulse: new Uint16Array(frames),
      cutoff: new Uint8Array(frames),
      routing: new Uint8Array(frames),
      mode: new Uint8Array(frames),
      pos: [new Uint8Array(frames), new Uint8Array(frames), new Uint8Array(frames)],
    };
    // The note starts after the instrument's gate timer: wait for it, so
    // frame 0 is the first frame of the wave program
    for (let i = 0; i < 64 && !sk._sk_table_pos(0, 0); i++) sk._sk_tick();
    const regs = sk._sk_sidregs();
    for (let f = 0; f < frames; f++) {
      for (let t = 0; t < 3; t++) trace.pos[t][f] = sk._sk_table_pos(0, t);
      sk._sk_tick();
      const r = sk.HEAPU8;
      trace.freq[f] = r[regs] | (r[regs + 1] << 8);
      trace.pulse[f] = r[regs + 2] | ((r[regs + 3] & 0x0f) << 8);
      trace.control[f] = r[regs + 4];
      trace.cutoff[f] = r[regs + 0x16];
      trace.routing[f] = r[regs + 0x17];
      trace.mode[f] = r[regs + 0x18];
    }
    sk._sk_reset();
    return trace;
  }
}

const TRACE_INSTRUMENT = 63;

/** SID registers after each frame of a note. */
export interface Trace {
  frames: number;
  freq: Uint16Array;
  /** Voice 1's waveform register. */
  control: Uint8Array;
  /** 12-bit pulse width. */
  pulse: Uint16Array;
  /** High 8 bits of the filter cutoff, as GoatTracker sets it. */
  cutoff: Uint8Array;
  /** Resonance (high nibble) and filtered voices (low bits). */
  routing: Uint8Array;
  /** Passband (high nibble) and volume. */
  mode: Uint8Array;
  /** Wave, pulse and filter table positions each frame ran from (1-based, 0 = not running). */
  pos: Uint8Array[];
}
