// Renders a song to PCM in a Web Worker, so playback keeps running, and
// encodes it as WAV.

import { wasmBytes } from './wasm';
import type { Settings } from './protocol';

export interface ExportRequest {
  wasm: ArrayBuffer;
  song: ArrayBuffer;
  settings: Settings;
  model: number;
  subsong: number;
  muted: boolean[];
  sampleRate: number;
  /** Stop here even if the song never loops. */
  maxSeconds: number;
  /** Keep playing this long past the loop point, fading out. 0 = cut at the loop. */
  fadeSeconds: number;
}

export type ExportEvent =
  | { type: 'progress'; seconds: number }
  | { type: 'done'; samples: Int16Array; looped: boolean }
  | { type: 'error'; message: string };

export interface ExportOptions {
  song: ArrayBuffer;
  settings: Settings;
  model: number;
  subsong: number;
  muted: boolean[];
  sampleRate?: number;
  maxSeconds?: number;
  fadeSeconds?: number;
  onProgress?: (seconds: number) => void;
}

export interface Rendered {
  samples: Int16Array;
  sampleRate: number;
  /** False if the song hit maxSeconds without looping. */
  looped: boolean;
}

export async function renderSong(options: ExportOptions): Promise<Rendered> {
  const sampleRate = options.sampleRate ?? 44100;
  const request: ExportRequest = {
    wasm: await wasmBytes(),
    song: options.song,
    settings: options.settings,
    model: options.model,
    subsong: options.subsong,
    muted: options.muted,
    sampleRate,
    maxSeconds: options.maxSeconds ?? 600,
    fadeSeconds: options.fadeSeconds ?? 4,
  };
  const worker = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<Rendered>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message));
      worker.onmessage = (e: MessageEvent<ExportEvent>) => {
        const event = e.data;
        if (event.type === 'progress') options.onProgress?.(event.seconds);
        else if (event.type === 'error') reject(new Error(event.message));
        else resolve({ samples: event.samples, sampleRate, looped: event.looped });
      };
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => header.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  text(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header, samples as Int16Array<ArrayBuffer>], { type: 'audio/wav' });
}
