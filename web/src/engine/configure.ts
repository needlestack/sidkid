import type { SidKidModule } from '@engine/sidkid.js';
import type { Settings } from './protocol';

export function configure(sk: SidKidModule, s: Settings) {
  sk._sk_configure(s.multiplier, s.ntsc ? 1 : 0, s.hardRestart, s.pulseOptimization ? 1 : 0, s.realtimeOptimization ? 1 : 0);
}
