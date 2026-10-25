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

// BROWSER=firefox FIREFOX=/path/to/firefox runs the same tests in Firefox
const BROWSER = process.env.BROWSER ?? 'chrome';
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
// Colour scheme emulation needs CDP, which only Chrome has
async function colorScheme(page, value) {
  if (BROWSER === 'chrome') await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value }]);
}

const browser = await puppeteer.launch(
  BROWSER === 'firefox'
    ? {
        browser: 'firefox',
        executablePath: process.env.FIREFOX,
        headless: true,
        extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
      }
    : {
        executablePath: CHROME,
        headless: true,
        // CI containers can't use Chrome's sandbox
        args: ['--autoplay-policy=no-user-gesture-required', ...(process.env.CI ? ['--no-sandbox'] : [])],
      },
);
console.log(`  ${BROWSER} ${await browser.version()}`);

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
    execFileSync(SNGRENDER, [`${EXAMPLES}/${file}`, '-t', String(RATE), '-s', String(SECONDS), '-o', `${OUT}/${name}.wav`, ...renderFlags(settings)], { stdio: ['ignore', 'ignore', 'inherit'] });
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
  // --- timeline: the song layout agrees with the order lists, and its
  // length with the loop point sngrender finds -------------------------------
  for (const { file, settings } of EXAMPLE_INDEX) {
    const name = file.replace(/\.sng$/, '');
    const log = spawnSync(SNGRENDER, [`${EXAMPLES}/${file}`, '-s', '1200', ...renderFlags(settings)], { encoding: 'utf8' }).stderr;
    const loopFrames = Number(/loops after (\d+) frames/.exec(log)?.[1] ?? -1);
    const result = await page.evaluate((url, s) => window.analyzeSong(url, s), `examples/${file}`, settings);
    const lengthOk = result && result.length === loopFrames;
    report(
      result && lengthOk && result.problems.length === 0,
      `layout  ${name.padEnd(16)}`,
      !result ? 'did not load'
        : `${result.length} frames, loop from ${result.loopStart}, sections ${result.sections.length > 24 ? result.sections.slice(0, 24) + '…' : result.sections}` +
          (lengthOk ? '' : `; sngrender loops at ${loopFrames}`) +
          (result.problems.length ? `; ${result.problems.join('; ')}` : ''),
    );
  }
  // --- tables: splitting into programs and laying out again is lossless ----
  for (const { file } of EXAMPLE_INDEX) {
    const name = file.replace(/\.sng$/, '');
    const result = await page.evaluate((url) => window.tableRoundTrip(url), `examples/${file}`);
    report(
      result && result.problems.length === 0,
      `tables  ${name.padEnd(16)}`,
      !result ? 'did not load' : `${result.counts.join('/')} programs` + (result.problems.length ? `; ${result.problems.join('; ')}` : ''),
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

  // Clicking a section plays from its start
  const target = await ui.$eval('.section-block:nth-child(3)', (el) => {
    el.click();
    return Number(el.dataset.start);
  });
  const expected = Math.floor(target / 50);
  await ui.waitForFunction((s) => {
    const [m, sec] = document.getElementById('time').textContent.split(':').map(Number);
    return m * 60 + sec >= s && m * 60 + sec <= s + 2;
  }, { timeout: 3000 }, expected)
    .then(() => report(true, 'ui plays from a clicked section', `${expected} s`), async () =>
      report(false, 'ui plays from a clicked section', `expected ${expected} s, clock shows ${await ui.$eval('#time', (e) => e.textContent)}`));
  const shown = await ui.$eval('.section-letter', (el) => el.textContent);
  const clicked = await ui.$eval('.section-block:nth-child(3)', (el) => el.textContent);
  report(shown === clicked, 'ui shows the playing section', `${shown}`);
  await ui.keyboard.press('Home');

  await ui.keyboard.press('Digit2');
  const muted = await ui.$eval('.voice:nth-child(2)', (el) => el.classList.contains('muted'));
  report(muted, 'ui mutes voice 2 with key 2');
  await ui.keyboard.press('Digit2');

  await colorScheme(ui, 'dark');
  await ui.screenshot({ path: `${OUT}/${BROWSER}-dark.png` });
  await colorScheme(ui, 'light');
  await ui.screenshot({ path: `${OUT}/${BROWSER}-light.png` });

  await ui.keyboard.press(' ');
  await ui.waitForFunction(() => !document.getElementById('play').classList.contains('playing'), { timeout: 2000 })
    .then(() => report(true, 'ui stops with space'), () => report(false, 'ui stops with space'));

  await ui.select('#examples', '2xtest.sng');
  await ui.waitForFunction(() => document.getElementById('title').textContent.includes('2x-speed'), { timeout: 5000 });
  const speed = await ui.$eval('#speed .on', (el) => el.dataset.speed);
  report(speed === '2', 'ui applies example speed setting', `speed ${speed}`);
  await colorScheme(ui, 'dark');
  await ui.click('.advanced summary');
  await ui.screenshot({ path: `${OUT}/${BROWSER}-settings.png`, fullPage: true });

  report(errors.length === 0, 'ui without errors', errors.join(' | '));

  // --- 3. Table maker -------------------------------------------------------
  const tm = await browser.newPage();
  const tmErrors = [];
  tm.on('pageerror', (err) => tmErrors.push(err.message));
  tm.on('console', (msg) => msg.type() === 'error' && tmErrors.push(msg.text()));
  await tm.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await tm.goto(`${base}tables.html`);
  await tm.evaluate(() => localStorage.clear());
  await tm.reload();
  await tm.waitForFunction(() => window.tableMaker?.ready(), { timeout: 5000 });
  report(true, 'tables page loads and traces a note');

  // The Major arpeggio preset: steps 1-5, then loops back to step 2
  await tm.click('#program-list li:nth-child(3) button');
  await tm.waitForFunction(() => window.tableMaker.idle());
  const order = await tm.evaluate(() => window.tableMaker.frameSteps().slice(0, 10).join(','));
  report(order === '0,1,2,3,4,1,2,3,4,1', 'tables graph follows the program loop', order);

  // Editing step 2 from +4 to +3 semitones changes the traced pitch
  const pitch = () => tm.evaluate(() => {
    const t = window.tableMaker.trace();
    return Math.round(12 * Math.log2(t.freq[1] / t.freq[0]));
  });
  const before = await pitch();
  await tm.$eval('.step[data-step="1"] input[type=number]', (input) => {
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tm.waitForFunction(() => {
    const t = window.tableMaker.trace();
    return Math.round(12 * Math.log2(t.freq[1] / t.freq[0])) === 3;
  }, { timeout: 2000 }).catch(() => {});
  const after = await pitch();
  report(before === 4 && after === 3, 'tables edit changes the trace', `+${before} → +${after} semitones`);

  // Playing a key runs the program in the worklet: its steps light up
  await tm.keyboard.down('q');
  await tm.waitForSelector('.step.live', { timeout: 3000 })
    .then(() => report(true, 'tables test note runs the program'), () => report(false, 'tables test note runs the program'));
  await tm.keyboard.up('q');

  await tm.select('#examples', 'cabrinigreen.sng');
  await tm.waitForFunction(() => window.tableMaker.state().instruments.length > 0, { timeout: 5000 });
  const loaded = await tm.evaluate(() => window.tableMaker.state().programs.map((l) => l.length).join('/'));
  report(true, 'tables loads a song', `${loaded} programs`);
  await colorScheme(tm, 'dark');
  await tm.screenshot({ path: `${OUT}/${BROWSER}-tables-dark.png` });
  await colorScheme(tm, 'light');
  await tm.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow = await tm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow <= 0, 'tables fits a phone screen', overflow > 0 ? `${overflow}px too wide` : '');
  report(tmErrors.length === 0, 'tables without errors', tmErrors.join(' | '));
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
