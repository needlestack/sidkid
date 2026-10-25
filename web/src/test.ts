// Test hook for scripts/browsertest.mjs: renders a song through the real
// worklet path with an OfflineAudioContext. Only built with --mode test.

import { renderSong } from './engine/export';
import { MODEL_6581, Player, SAMPLE_RATE } from './engine/player';
import { DEFAULT_SETTINGS, type Settings } from './engine/protocol';

function base64(samples: Int16Array) {
  let binary = '';
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function renderOffline(url: string, seconds: number, settings?: Partial<Settings>) {
  const context = new OfflineAudioContext(2, SAMPLE_RATE * seconds, SAMPLE_RATE);
  const player = new Player();
  player.setSettings({ ...DEFAULT_SETTINGS, ...settings });
  await player.start(context);
  const info = await player.load(await (await fetch(url)).arrayBuffer());
  player.play(0);
  await player.sync();
  const rendered = await context.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const samples = new Int16Array(left.length);
  let channelsDiffer = false;
  for (let i = 0; i < left.length; i++) {
    samples[i] = Math.round(left[i] * 32768);
    if (left[i] !== right[i]) channelsDiffer = true;
  }
  // Base64 keeps the transfer to puppeteer compact
  return { info, channelsDiffer, samples: base64(samples) };
}

async function exportSong(url: string, settings?: Partial<Settings>, fadeSeconds = 0) {
  const rendered = await renderSong({
    song: await (await fetch(url)).arrayBuffer(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    model: MODEL_6581,
    subsong: 0,
    muted: [false, false, false],
    fadeSeconds,
  });
  return { looped: rendered.looped, sampleRate: rendered.sampleRate, samples: base64(rendered.samples) };
}

Object.assign(window, { renderOffline, exportSong });
