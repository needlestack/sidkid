// Songs for a C64 (or VICE): a GoatTracker song packed by GoatTracker's own
// packer/relocator (in the engine, sk_pack) as a SID file, or as a program
// that plays itself on a disk image. The disk's program is a BASIC line
// (10 SYS2061) and a few bytes that print the song's title and play it from
// a timer interrupt at the song's own rate, on a PAL or an NTSC machine
// alike, the player and music following at $1000. Dropped on VICE, the disk
// loads and runs by itself.

import createSidKid from '@engine/sidkid.js';
import { configure } from './engine/configure';
import type { Settings } from './engine/protocol';
import { wasmBytes } from './engine/wasm';
import './d64lib.js';

const SONG_PATH = '/song.sng';
const OUT_PATH = '/packed';
const FORMAT_SID = 0;
const FORMAT_PRG = 1;
/** Where the packer puts the player (its init, then its play call 3 bytes on) */
const PLAYER = 0x1000;
const BASIC = 0x0801;
const PAL_CLOCK = 985248;
const NTSC_CLOCK = 1022727;

/** A song packed with the player: a SID file, or the player and music as a PRG (at $1000). Null if it can't be. */
export async function packSong(song: Uint8Array, settings: Settings, model: number, format: typeof FORMAT_SID | typeof FORMAT_PRG): Promise<Uint8Array | null> {
  // (an engine of its own: the packer leaves its state behind, and stops the module on a song it can't assemble)
  const sk = await createSidKid({ wasmBinary: await wasmBytes() });
  sk._sk_init(44100, model, settings.ntsc ? 1 : 0, 0);
  configure(sk, settings);
  sk.FS.writeFile(SONG_PATH, song);
  const str = (s: string) => {
    const p = sk._malloc(s.length + 1);
    for (let i = 0; i < s.length; i++) sk.HEAPU8[p + i] = s.charCodeAt(i);
    sk.HEAPU8[p + s.length] = 0;
    return p;
  };
  if (!sk._sk_load_song(str(SONG_PATH))) return null;
  if (!sk._sk_pack(str(OUT_PATH), format, model)) return null;
  return sk.FS.readFile(OUT_PATH);
}

/** Text as the C64 prints it (its upper case set): what it hasn't, a space */
function petscii(text: string): number[] {
  return [...text.toUpperCase()].map((c) => (/[ -\]]/.test(c) ? c.charCodeAt(0) : 0x20));
}

/**
 * The player and music (a PRG at $1000) as a program that plays itself:
 * RUN prints the title and starts the song, played calls per second (the
 * song's frame rate, times its speed) from CIA 1's timer, set for whichever
 * machine it's on.
 */
export function playingProgram(player: Uint8Array, title: string, settings: Settings): Uint8Array {
  const calls = (settings.ntsc ? 60 : 50) * (settings.multiplier || 0.5);
  // Timer counts, indexed by the KERNAL's PAL flag ($02A6: 0 NTSC, 1 PAL)
  const counts = [NTSC_CLOCK, PAL_CLOCK].map((clock) => Math.round(clock / calls) - 1);
  const text = [...petscii(title.slice(0, 40)), 0x0d, 0x0d, ...petscii('MADE WITH SIDKID'), 0];
  const start = 0x080d;
  const code = (irq: number, lo: number, hi: number, msg: number): number[] => [
    0xa9, 0x93, 0x20, 0xd2, 0xff, // lda #$93, jsr CHROUT: clear the screen
    0xa2, 0x00, // ldx #0
    0xbd, msg & 0xff, msg >> 8, // print: lda msg,x
    0xf0, 0x06, // beq done
    0x20, 0xd2, 0xff, // jsr CHROUT
    0xe8, // inx
    0xd0, 0xf5, // bne print
    0x78, // done: sei
    0xa9, irq & 0xff, 0x8d, 0x14, 0x03, // the interrupt: ours
    0xa9, irq >> 8, 0x8d, 0x15, 0x03,
    0xae, 0xa6, 0x02, // ldx $02a6: PAL or NTSC
    0xbd, lo & 0xff, lo >> 8, 0x8d, 0x04, 0xdc, // CIA 1 timer A: the song's rate on this machine
    0xbd, hi & 0xff, hi >> 8, 0x8d, 0x05, 0xdc,
    0xa9, 0x11, 0x8d, 0x0e, 0xdc, // load it and run on
    0xa9, 0x00, 0x20, PLAYER & 0xff, PLAYER >> 8, // lda #0 (the first song), jsr init
    0x58, // cli
    0x4c, 0, 0, // jmp * (filled in below)
    // irq: jsr play, then the KERNAL's own (keyboard, and acknowledging the timer)
    0x20, (PLAYER + 3) & 0xff, (PLAYER + 3) >> 8,
    0x4c, 0x31, 0xea,
  ];
  const size = code(0, 0, 0, 0).length;
  const irq = start + size - 6;
  const lo = start + size;
  const hi = lo + 2;
  const msg = hi + 2;
  const body = code(irq, lo, hi, msg);
  const loop = start + size - 9;
  body.splice(size - 8, 2, loop & 0xff, loop >> 8);
  body.push(counts[0] & 0xff, counts[1] & 0xff, counts[0] >> 8, counts[1] >> 8, ...text);
  // 10 SYS2061
  const basic = [0x0b, 0x08, 0x0a, 0x00, 0x9e, ...petscii(String(start)), 0x00, 0x00, 0x00];
  const out = new Uint8Array(2 + (PLAYER - BASIC) + player.length - 2);
  out.set([BASIC & 0xff, BASIC >> 8]);
  out.set([...basic, ...body], 2);
  if (2 + basic.length + body.length > 2 + PLAYER - BASIC) throw new Error('The title runs into the player');
  out.set(player.subarray(2), 2 + PLAYER - BASIC);
  return out;
}

/** A disk name or file name as the 1541 keeps it (16 characters) */
const diskName = (name: string) => String.fromCharCode(...petscii(name.trim() || 'SONG')).slice(0, 16).trim() || 'SONG';

/** A disk image with the program on it, first (what LOAD"*",8,1 and VICE's autostart load) */
export function diskOf(name: string, program: Uint8Array): Uint8Array {
  const disk = D64.createEmpty(diskName(name), 'SK');
  disk.writeFile(diskName(name), program, D64.FILE_TYPE_PRG);
  return disk.getData();
}
