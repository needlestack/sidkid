// Messages between the main thread (Player) and the audio worklet that owns
// the engine. The worklet is the only place the song exists, so every change
// goes through here.

export interface SongInfo {
  title: string;
  author: string;
  copyright: string;
  subsongs: number;
}

/**
 * Player options GoatTracker keeps in its configuration rather than in the
 * song file, so a song may need them set to play correctly.
 */
export interface Settings {
  /** Player calls per frame; 0 = half speed (25 Hz on PAL). */
  multiplier: number;
  ntsc: boolean;
  /** AD/SR written before each note for a reliable attack. */
  hardRestart: number;
  pulseOptimization: boolean;
  realtimeOptimization: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  multiplier: 1,
  ntsc: false,
  hardRestart: 0x0f00,
  pulseOptimization: true,
  realtimeOptimization: true,
};

export interface Status {
  playing: boolean;
  /** Frames since the song started (50 per second on PAL). */
  frames: number;
  muted: boolean[];
  /** The 25 SID registers written by the latest frame. */
  regs: Uint8Array;
  /** Envelope level 0-255 of each voice. */
  envelopes: Uint8Array;
}

export type Command =
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | { type: 'play'; subsong: number; frame: number }
  | { type: 'stop' }
  | { type: 'mute'; channel: number; muted: boolean }
  | { type: 'model'; model: number }
  | { type: 'settings'; settings: Settings }
  | { type: 'ping'; id: number };

export type Event =
  | { type: 'ready' }
  | { type: 'loaded'; id: number; info: SongInfo | null }
  | { type: 'pong'; id: number }
  | { type: 'status'; status: Status }
  | { type: 'error'; message: string };

export interface ProcessorOptions {
  wasm: ArrayBuffer;
  model: number;
  settings: Settings;
}
