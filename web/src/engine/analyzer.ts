// A second engine instance on the main thread, for looking at songs rather
// than playing them: it converts any .sng version to the current format and
// scans playback silently to find when every row plays.

import createSidKid, { type SidKidModule } from '@engine/sidkid.js';
import { configure } from './configure';
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
}
