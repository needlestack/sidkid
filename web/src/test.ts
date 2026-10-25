// Test hook for scripts/browsertest.mjs: renders a song through the real
// worklet path with an OfflineAudioContext. Only built with --mode test.

import { renderSong } from './engine/export';
import { MODEL_6581, Player, SAMPLE_RATE } from './engine/player';
import { Analyzer } from './engine/analyzer';
import { DEFAULT_SETTINGS, type Settings } from './engine/protocol';
import { orderSteps, parseSong } from './song';
import { buildTimeline } from './timeline';

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

/** Lays out a song and checks the layout against the song data. */
async function analyzeSong(url: string, settings?: Partial<Settings>) {
  const analyzer = await Analyzer.create();
  const canonical = analyzer.load(await (await fetch(url)).arrayBuffer());
  if (!canonical) return null;
  const song = parseSong(canonical);
  const t = buildTimeline(song, 0, analyzer.scan(0, { ...DEFAULT_SETTINGS, ...settings }));
  const problems: string[] = [];
  t.clips.forEach((lane, v) => {
    // The order list, walked by the sequencer's rules, must name the
    // patterns the engine actually played
    const steps = orderSteps(song.subsongs[0][v]);
    lane.forEach((clip, i) => {
      const step = steps.next().value;
      if (!step || step.pattern !== clip.pattern) problems.push(`voice ${v + 1} clip ${i}: pattern ${clip.pattern}, order list says ${step?.pattern}`);
      // Every clip but the last plays all its rows
      const rows = song.patterns[clip.pattern].length;
      if (i < lane.length - 1 && clip.rowFrames.length !== rows) problems.push(`voice ${v + 1} clip ${i}: ${clip.rowFrames.length} of ${rows} rows`);
    });
  });
  return { length: t.length, loopStart: t.loopStart, sections: t.sections.map((s) => s.letter).join(''), problems: problems.slice(0, 5) };
}

Object.assign(window, { renderOffline, exportSong, analyzeSong });
