// Test hook for scripts/browsertest.mjs: renders a song through the real
// worklet path with an OfflineAudioContext. Only built with --mode test.

import { Player, SAMPLE_RATE } from './engine/player';

async function renderOffline(url: string, seconds: number) {
  const context = new OfflineAudioContext(2, SAMPLE_RATE * seconds, SAMPLE_RATE);
  const player = new Player();
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
  let binary = '';
  const bytes = new Uint8Array(samples.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { info, channelsDiffer, samples: btoa(binary) };
}

(window as unknown as { renderOffline: typeof renderOffline }).renderOffline = renderOffline;
