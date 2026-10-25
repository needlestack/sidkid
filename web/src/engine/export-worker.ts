// Web Worker for export.ts: renders one pass of a song plus a fade-out.

import createSidKid from '@engine/sidkid.js';
import { configure } from './configure';
import type { ExportEvent, ExportRequest } from './export';

const SONG_PATH = '/song.sng';
const MAX_FRAME_SAMPLES = 4096;

function send(event: ExportEvent, transfer: Transferable[] = []) {
  postMessage(event, { transfer });
}

async function render(r: ExportRequest) {
  const sk = await createSidKid({ wasmBinary: r.wasm });
  sk._sk_init(r.sampleRate, r.model, r.settings.ntsc ? 1 : 0, 0);
  configure(sk, r.settings);

  sk.FS.writeFile(SONG_PATH, new Uint8Array(r.song));
  const path = sk._malloc(SONG_PATH.length + 1);
  for (let i = 0; i < SONG_PATH.length; i++) sk.HEAPU8[path + i] = SONG_PATH.charCodeAt(i);
  sk.HEAPU8[path + SONG_PATH.length] = 0;
  if (!sk._sk_load_song(path)) throw new Error('Not a GoatTracker song');

  r.muted.forEach((m, c) => m && sk._sk_toggle_mute(c));
  sk._sk_play(r.subsong);

  const buffer = sk._malloc(MAX_FRAME_SAMPLES * 2);
  const maxSamples = Math.round(r.maxSeconds * r.sampleRate);
  const fadeSamples = Math.round(r.fadeSeconds * r.sampleRate);
  const chunks: Int16Array[] = [];
  let total = 0;
  let loopAt = -1;
  let nextProgress = r.sampleRate;

  while (total < maxSamples) {
    const n = sk._sk_render_frame(buffer);
    if (n <= 0) break;
    chunks.push(sk.HEAP16.slice(buffer >> 1, (buffer >> 1) + n));
    total += n;
    if (loopAt < 0 && sk._sk_song_looped()) loopAt = total;
    if (loopAt >= 0 && total >= loopAt + fadeSamples) break;
    if (total >= nextProgress) {
      send({ type: 'progress', seconds: total / r.sampleRate });
      nextProgress += r.sampleRate;
    }
  }

  const end = loopAt >= 0 ? Math.min(total, loopAt + fadeSamples) : total;
  const samples = new Int16Array(end);
  let pos = 0;
  for (const chunk of chunks) {
    const n = Math.min(chunk.length, end - pos);
    samples.set(chunk.subarray(0, n), pos);
    pos += n;
    if (pos >= end) break;
  }
  if (loopAt >= 0 && fadeSamples > 0) {
    for (let i = loopAt; i < end; i++) samples[i] = Math.round(samples[i] * (1 - (i - loopAt) / fadeSamples));
  }
  send({ type: 'done', samples, looped: loopAt >= 0 }, [samples.buffer]);
}

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  render(e.data).catch((err) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
