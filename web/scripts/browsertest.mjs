// Browser tests in headless Chrome, against a test-mode build in dist-test/
// (npm test builds it first):
//
// 1. Fidelity: each example song rendered through the real AudioWorklet path
//    (OfflineAudioContext) must match the native engine sample for sample.
// 2. UI: pick an example from the menu, check it loads and plays, and save a
//    screenshots to build/webtest/.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = `${ROOT}build/webtest`;
const SNGRENDER = `${ROOT}build/native/sngrender`;
const EXAMPLES = `${ROOT}web/public/examples`;
const SECONDS = 20;
const RATE = 48000;
const EXAMPLE_INDEX = JSON.parse(readFileSync(`${EXAMPLES}/index.json`, 'utf8'));

// sngrender options matching an example's settings in index.json
function renderFlags(settings = {}) {
  const flags = [];
  if (settings.multiplier !== undefined) flags.push('-S', String(settings.multiplier));
  if (settings.ntsc !== undefined) flags.push('-N', settings.ntsc ? '1' : '0');
  if (settings.hardRestart !== undefined) flags.push('-A', settings.hardRestart.toString(16));
  if (settings.pulseOptimization !== undefined) flags.push('-O', settings.pulseOptimization ? '1' : '0');
  if (settings.realtimeOptimization !== undefined) flags.push('-R', settings.realtimeOptimization ? '1' : '0');
  return flags;
}

function readWav(path) {
  const wav = readFileSync(path).subarray(44);
  return new Int16Array(wav.buffer, wav.byteOffset, wav.length >> 1);
}

function decode(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
}

mkdirSync(OUT, { recursive: true });

const server = await preview({ build: { outDir: 'dist-test' }, preview: { port: 0, open: false }, logLevel: 'warn' });
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

let failed = false;
function report(ok, label, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
}

try {
  // --- 1. fidelity ---------------------------------------------------------
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('  page error:', err.message));
  await page.goto(`${base}test.html`);
  await page.waitForFunction(() => 'renderOffline' in window);

  for (const { file, settings } of EXAMPLE_INDEX) {
    const name = file.replace(/\.sng$/, '');
    execFileSync(SNGRENDER, [`${EXAMPLES}/${file}`, '-t', String(RATE), '-s', String(SECONDS), '-o', `${OUT}/${name}.wav`, ...renderFlags(settings)], { stdio: 'ignore' });
    const native = readWav(`${OUT}/${name}.wav`);

    const result = await page.evaluate((url, seconds, s) => window.renderOffline(url, seconds, s), `examples/${file}`, SECONDS, settings);
    const browserSamples = decode(result.samples);

    let first = -1;
    for (let i = 0; i < native.length; i++) {
      if (browserSamples[i] !== native[i]) {
        first = i;
        break;
      }
    }
    const lengthOk = browserSamples.length === native.length;
    report(
      result.info && lengthOk && first < 0 && !result.channelsDiffer,
      `worklet ${name.padEnd(16)}`,
      !result.info ? 'did not load'
        : !lengthOk ? `length ${browserSamples.length} vs ${native.length}`
        : first >= 0 ? `differs from sample ${first} (${(first / RATE).toFixed(3)} s)`
        : result.channelsDiffer ? 'left and right differ' : '',
    );
  }

  // --- WAV export: one pass, no fade, must equal the native render up to
  // the loop point that sngrender reports ---------------------------------
  for (const file of ['dojo.sng', '2xtest.sng']) {
    const name = file.replace(/\.sng$/, '');
    const { settings } = EXAMPLE_INDEX.find((e) => e.file === file);
    // sngrender reports the loop point on stderr
    const log = spawnSync(SNGRENDER, [`${EXAMPLES}/${file}`, '-s', '600', '-o', `${OUT}/${name}-export.wav`, ...renderFlags(settings)], { encoding: 'utf8' }).stderr;
    const loopFrames = Number(/loops after (\d+) frames/.exec(log)?.[1]);
    const native = readWav(`${OUT}/${name}-export.wav`);
    const samplesPerFrame = Math.floor(((44100 * 5) >> 1) / (125 * (settings?.multiplier ?? 1)));

    const result = await page.evaluate((url, s) => window.exportSong(url, s), `examples/${file}`, settings);
    const exported = decode(result.samples);
    let first = -1;
    for (let i = 0; i < exported.length; i++) {
      if (exported[i] !== native[i]) {
        first = i;
        break;
      }
    }
    const expectedLength = loopFrames * samplesPerFrame;
    report(
      result.looped && exported.length === expectedLength && first < 0,
      `export  ${name.padEnd(16)}`,
      `${(exported.length / 44100).toFixed(1)} s` +
        (exported.length !== expectedLength ? `, expected ${(expectedLength / 44100).toFixed(1)} s` : '') +
        (first >= 0 ? `, differs from sample ${first}` : ''),
    );
  }
  await page.close();

  // --- 2. UI -----------------------------------------------------------------
  const ui = await browser.newPage();
  const errors = [];
  ui.on('pageerror', (err) => errors.push(err.message));
  ui.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  await ui.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
  await ui.goto(base);
  await ui.waitForFunction(() => document.querySelectorAll('#examples option').length > 1);
  await ui.select('#examples', 'dojo.sng');
  await ui.waitForFunction(() => document.getElementById('title').textContent === 'Dojo', { timeout: 5000 });
  report(true, 'ui loads example from menu');

  await ui.waitForFunction(() => document.getElementById('time').textContent === '0:02', { timeout: 6000 })
    .then(() => report(true, 'ui plays (clock advancing)'), () => report(false, 'ui plays (clock advancing)'));
  const notes = await ui.$$eval('.note', (els) => els.map((e) => e.textContent));
  report(notes.some((n) => n !== '—'), 'ui shows notes', notes.join(' '));

  await ui.keyboard.press('Digit2');
  const muted = await ui.$eval('.voice:nth-child(2)', (el) => el.classList.contains('muted'));
  report(muted, 'ui mutes voice 2 with key 2');
  await ui.keyboard.press('Digit2');

  await ui.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await ui.screenshot({ path: `${OUT}/ui-dark.png` });
  await ui.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await ui.screenshot({ path: `${OUT}/ui-light.png` });

  await ui.keyboard.press('Space');
  await ui.waitForFunction(() => !document.getElementById('play').classList.contains('playing'), { timeout: 2000 })
    .then(() => report(true, 'ui stops with space'), () => report(false, 'ui stops with space'));

  await ui.select('#examples', '2xtest.sng');
  await ui.waitForFunction(() => document.getElementById('title').textContent.includes('2x-speed'), { timeout: 5000 });
  const speed = await ui.$eval('#speed .on', (el) => el.dataset.speed);
  report(speed === '2', 'ui applies example speed setting', `speed ${speed}`);
  await ui.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await ui.click('.advanced summary');
  await ui.screenshot({ path: `${OUT}/ui-settings.png`, fullPage: true });

  report(errors.length === 0, 'ui without errors', errors.join(' | '));
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
