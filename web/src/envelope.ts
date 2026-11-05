// The SID's volume envelope, worked out the way the chip counts it, so the
// graph can show attack, decay, sustain and release against the programs.

/** Clock cycles between envelope steps for each rate setting (0-F), from reSID. */
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

/** PAL C64 clock cycles in one 50 Hz frame. */
export const PAL_FRAME_CYCLES = 19656;
/** NTSC C64 clock cycles in one 60 Hz frame. */
export const NTSC_FRAME_CYCLES = 17045;

/** Decay and release slow down as the level falls, to sound roughly exponential. */
function expPeriod(level: number): number {
  if (level > 0x5d) return 1;
  if (level > 0x36) return 2;
  if (level > 0x1a) return 4;
  if (level > 0x0e) return 8;
  if (level > 0x06) return 16;
  return 30;
}

/**
 * The envelope level (0-1) through each frame, `perFrame` samples a frame,
 * for an instrument's AD and SR bytes and whether the gate is on in each
 * frame. Starts from silence, as after GoatTracker's hard restart. AD and
 * SR can be given for each frame, for programs that change them mid-note.
 */
export function envelope(ad: number | ArrayLike<number>, sr: number | ArrayLike<number>, gate: boolean[], perFrame = 4, frameCycles = PAL_FRAME_CYCLES): Float32Array {
  const at = (v: number | ArrayLike<number>, f: number) => (typeof v === 'number' ? v : v[f]);
  let attack = 0;
  let decay = 0;
  let sustain = 0;
  let release = 0;
  const out = new Float32Array(gate.length * perFrame + 1);
  const slice = frameCycles / perFrame;
  let level = 0;
  let state: 'attack' | 'decay' | 'release' = 'release';
  let rate = 0;
  let exp = 0;
  let cycles = 0;
  for (let f = 0; f < gate.length; f++) {
    attack = RATE_PERIOD[at(ad, f) >> 4];
    decay = RATE_PERIOD[at(ad, f) & 15];
    sustain = (at(sr, f) >> 4) * 0x11;
    release = RATE_PERIOD[at(sr, f) & 15];
    if (gate[f] && state === 'release') state = 'attack';
    else if (!gate[f]) state = 'release';
    for (let i = 0; i < perFrame; i++) {
      out[f * perFrame + i] = level / 255;
      cycles += slice;
      for (;;) {
        const period = state === 'attack' ? attack : state === 'decay' ? decay : release;
        if (cycles < period - rate) {
          rate += cycles;
          cycles = 0;
          break;
        }
        cycles -= period - rate;
        rate = 0;
        if (state === 'attack') {
          exp = 0;
          if (++level >= 0xff) {
            level = 0xff;
            state = 'decay';
          }
        } else if (++exp >= expPeriod(level)) {
          exp = 0;
          if (state === 'decay' ? level > sustain : level > 0) level--;
        }
      }
    }
  }
  out[out.length - 1] = level / 255;
  return out;
}
