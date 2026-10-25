// Browser tests in headless Chrome, against a test-mode build in dist-test/
// (npm test builds it first):
//
// 1. Fidelity: each example song rendered through the real AudioWorklet path
//    (OfflineAudioContext) must match the native engine sample for sample.
// 2. UI: pick an example from the menu, check it loads and plays, and save a
//    screenshots to build/webtest/.

import { execFileSync } from 'node:child_process';
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

  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith('.sng')).sort()) {
    const name = file.replace(/\.sng$/, '');
    execFileSync(SNGRENDER, [`${EXAMPLES}/${file}`, '-t', String(RATE), '-s', String(SECONDS), '-o', `${OUT}/${name}.wav`], { stdio: 'ignore' });
    const wav = readFileSync(`${OUT}/${name}.wav`).subarray(44);
    const native = new Int16Array(wav.buffer, wav.byteOffset, wav.length >> 1);

    const result = await page.evaluate((url, seconds) => window.renderOffline(url, seconds), `examples/${file}`, SECONDS);
    const bytes = Buffer.from(result.samples, 'base64');
    const browserSamples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);

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

  report(errors.length === 0, 'ui without errors', errors.join(' | '));
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
