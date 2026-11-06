// The volume envelope's settings: how long each attack, decay and release
// setting takes (from the SID datasheet), and each setting in words.

export interface Env {
  a: number;
  d: number;
  s: number;
  r: number;
}

type Key = keyof Env;

/** How long each attack setting takes to reach full volume, in ms (from the SID datasheet). */
export const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
/** How long each decay or release setting takes to fall all the way, in ms. */
export const DECAY_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];

function time(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

export function describe(key: Key, v: number): string {
  if (key === 's') return `${Math.round((v / 15) * 100)}%`;
  return time((key === 'a' ? ATTACK_MS : DECAY_MS)[v]);
}
