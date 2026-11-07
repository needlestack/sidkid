// A Song Maker song saved inside the GoatTracker song exported for it, so
// that importing the file again gives the song back as it was made, with its
// instruments, not as worked out from what GoatTracker plays.
//
// GoatTracker reads a song file up to its last pattern and no further, so
// the song can follow it: the song and its instruments as JSON, then the
// length of GoatTracker's part, a checksum of it and a mark. A file
// GoatTracker has saved again has none of that; one changed some other way
// fails the checksum. Either way it imports from GoatTracker's part.

import type { Shape } from './shape';
import type { SongDoc } from './songdoc';

const MARK = 'SIDKidSg';
const VERSION = 1;

export interface SavedSong {
  version: number;
  song: SongDoc;
  /** The instruments its tracks play */
  instruments: Shape[];
}

/** FNV-1a, enough to tell GoatTracker's part has changed */
function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

/** A GoatTracker song with the Song Maker song it was made from after it */
export function withSong(goat: Uint8Array, song: SongDoc, instruments: Shape[]): Uint8Array {
  const saved: SavedSong = { version: VERSION, song, instruments };
  const json = new TextEncoder().encode(JSON.stringify(saved));
  const out = new Uint8Array(goat.length + json.length + 16);
  out.set(goat);
  out.set(json, goat.length);
  const tail = new DataView(out.buffer, goat.length + json.length, 16);
  tail.setUint32(0, goat.length, true);
  tail.setUint32(4, checksum(goat), true);
  for (let i = 0; i < MARK.length; i++) tail.setUint8(8 + i, MARK.charCodeAt(i));
  return out;
}

/** The Song Maker song saved after a GoatTracker song, if there is one and GoatTracker's part is as it was saved */
export function savedSong(bytes: Uint8Array): SavedSong | null {
  if (bytes.length < 16) return null;
  const tail = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 16, 16);
  for (let i = 0; i < MARK.length; i++) if (tail.getUint8(8 + i) !== MARK.charCodeAt(i)) return null;
  const length = tail.getUint32(0, true);
  if (length > bytes.length - 16 || checksum(bytes.subarray(0, length)) !== tail.getUint32(4, true)) return null;
  try {
    const saved = JSON.parse(new TextDecoder().decode(bytes.subarray(length, bytes.length - 16))) as SavedSong;
    return saved.version === VERSION && Array.isArray(saved.song?.tracks) && Array.isArray(saved.instruments) ? saved : null;
  } catch {
    return null;
  }
}
