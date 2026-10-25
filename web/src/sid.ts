// Decodes raw SID register values into something people can read.

const PAL_CLOCK = 985248;
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export interface VoiceState {
  /** Tracker-style note name, e.g. "C#4", or "" when silent. */
  note: string;
  frequency: number;
  gate: boolean;
  triangle: boolean;
  sawtooth: boolean;
  pulse: boolean;
  noise: boolean;
  ring: boolean;
  sync: boolean;
  /** Pulse width as a fraction of the cycle, 0-1. */
  pulseWidth: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  filtered: boolean;
}

export interface FilterState {
  lowpass: boolean;
  bandpass: boolean;
  highpass: boolean;
  /** 0-2047 */
  cutoff: number;
  /** 0-15 */
  resonance: number;
  /** 0-15 */
  volume: number;
}

export function noteName(hz: number): string {
  if (hz < 15) return '';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + octave;
}

export function voice(regs: Uint8Array, v: number): VoiceState {
  const base = v * 7;
  const freqReg = regs[base] | (regs[base + 1] << 8);
  const ctrl = regs[base + 4];
  const frequency = (freqReg * PAL_CLOCK) / 16777216;
  const anyWave = (ctrl & 0xf0) !== 0;
  return {
    note: anyWave ? noteName(frequency) : '',
    frequency,
    gate: (ctrl & 0x01) !== 0,
    sync: (ctrl & 0x02) !== 0,
    ring: (ctrl & 0x04) !== 0,
    triangle: (ctrl & 0x10) !== 0,
    sawtooth: (ctrl & 0x20) !== 0,
    pulse: (ctrl & 0x40) !== 0,
    noise: (ctrl & 0x80) !== 0,
    pulseWidth: (regs[base + 2] | ((regs[base + 3] & 0x0f) << 8)) / 4096,
    attack: regs[base + 5] >> 4,
    decay: regs[base + 5] & 0x0f,
    sustain: regs[base + 6] >> 4,
    release: regs[base + 6] & 0x0f,
    filtered: (regs[0x17] & (1 << v)) !== 0,
  };
}

export function filter(regs: Uint8Array): FilterState {
  return {
    cutoff: (regs[0x15] & 0x07) | (regs[0x16] << 3),
    resonance: regs[0x17] >> 4,
    lowpass: (regs[0x18] & 0x10) !== 0,
    bandpass: (regs[0x18] & 0x20) !== 0,
    highpass: (regs[0x18] & 0x40) !== 0,
    volume: regs[0x18] & 0x0f,
  };
}
