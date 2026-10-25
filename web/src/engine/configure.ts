import type { SidKidModule } from '@engine/sidkid.js';
import type { Instrument } from '../song';
import type { Settings } from './protocol';

export function configure(sk: SidKidModule, s: Settings) {
  sk._sk_configure(s.multiplier, s.ntsc ? 1 : 0, s.hardRestart, s.pulseOptimization ? 1 : 0, s.realtimeOptimization ? 1 : 0);
}

export interface TableData {
  left: Uint8Array;
  right: Uint8Array;
}

/** Replaces the engine's wave, pulse, filter and speed tables. */
export function writeTables(sk: SidKidModule, tables: TableData[]) {
  const ptr = sk._malloc(512);
  try {
    tables.forEach((t, i) => {
      const n = Math.min(t.left.length, 255);
      sk.HEAPU8.set(t.left.subarray(0, n), ptr);
      sk.HEAPU8.set(t.right.subarray(0, n), ptr + 256);
      sk._sk_set_table(i, ptr, ptr + 256, n);
    });
  } finally {
    sk._free(ptr);
  }
}

export function writeInstrument(sk: SidKidModule, num: number, ins: Instrument) {
  const [wave, pulse, filter, speed] = ins.tables;
  sk._sk_set_instrument(num, ins.ad, ins.sr, wave, pulse, filter, speed, ins.vibratoDelay, ins.gateTimer, ins.firstWave);
}
