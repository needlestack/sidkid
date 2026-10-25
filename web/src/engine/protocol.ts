// Messages between the main thread (Player) and the audio worklet that owns
// the engine. The worklet is the only place the song exists, so every change
// goes through here.

export interface SongInfo {
  title: string;
  author: string;
  copyright: string;
  subsongs: number;
}

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
  | { type: 'play'; subsong: number }
  | { type: 'stop' }
  | { type: 'mute'; channel: number; muted: boolean }
  | { type: 'model'; model: number }
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
}
