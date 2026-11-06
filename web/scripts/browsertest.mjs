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

  // --- 3. Instrument maker --------------------------------------------------
  const tm = await browser.newPage();
  const tmErrors = [];
  tm.on('pageerror', (err) => tmErrors.push(err.message));
  tm.on('console', (msg) => msg.type() === 'error' && tmErrors.push(msg.text()));
  await tm.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await tm.goto(`${base}instruments.html`);
  await tm.evaluate(() => localStorage.clear());
  await tm.reload();
  await tm.waitForFunction(() => window.instrumentMaker?.ready(), { timeout: 5000 });
  report(true, 'instruments page loads and traces a note');

  // Picking the Major arpeggio uses it in the instrument: steps 1-5, then loops back to step 2
  await tm.click('#program-list li:nth-child(3) button');
  await tm.waitForFunction(() => window.instrumentMaker.idle());
  const order = await tm.evaluate(() => window.instrumentMaker.frameSteps().slice(0, 10).join(','));
  report(order === '0,1,2,3,4,1,2,3,4,1', 'instruments graph follows the program loop', order);

  // Editing step 2 from +4 to +3 semitones changes the traced pitch
  const pitch = () => tm.evaluate(() => {
    const t = window.instrumentMaker.trace();
    return Math.round(12 * Math.log2(t.freq[1] / t.freq[0]));
  });
  const before = await pitch();
  await tm.$eval('.step[data-step="1"] input[type=number]', (input) => {
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tm.waitForFunction(() => {
    const t = window.instrumentMaker.trace();
    return Math.round(12 * Math.log2(t.freq[1] / t.freq[0])) === 3;
  }, { timeout: 2000 }).catch(() => {});
  const after = await pitch();
  report(before === 4 && after === 3, 'instruments edit changes the trace', `+${before} → +${after} semitones`);

  // Playing a key runs the program in the worklet: its steps light up
  await tm.keyboard.down('k');
  await tm.waitForSelector('.step.live', { timeout: 3000 })
    .then(() => report(true, 'instruments test note runs the program'), () => report(false, 'instruments test note runs the program'));
  await tm.keyboard.up('k');

  // Note keys still play after using a dropdown, which keeps focus
  await tm.focus('#next');
  await tm.keyboard.down('d');
  const playedFromSelect = await tm.$('.key.down');
  await tm.keyboard.up('d');
  report(!!playedFromSelect && (await tm.$eval('#next', (el) => el.value)) !== '', 'instruments note keys work with a dropdown focused');

  // A quick tap, released before the note starts sounding, still fades out
  await tm.keyboard.down('s');
  await tm.keyboard.up('s');
  await tm.waitForFunction(() => {
    const s = window.instrumentMaker.status();
    return s && !(s.regs[4] & 1) && s.envelopes[0] === 0;
  }, { timeout: 3000 })
    .then(() => report(true, 'instruments quick tap is released'), () => report(false, 'instruments quick tap is released'));

  // Dragging across the keyboard plays each key passed over
  const first = await (await tm.$('.key[data-offset="0"]')).boundingBox();
  const last = await (await tm.$('.key[data-offset="11"]')).boundingBox();
  await tm.mouse.move(first.x + first.width / 2, first.y + first.height - 10);
  await tm.mouse.down();
  const played = new Set();
  for (let i = 0; i <= 10; i++) {
    await tm.mouse.move(first.x + first.width / 2 + ((last.x - first.x) * i) / 10, first.y + first.height - 10);
    played.add(await tm.$eval('.key.down', (k) => k.dataset.offset).catch(() => null));
  }
  await tm.mouse.up();
  const released = await tm.$('.key.down');
  report(played.size >= 5 && !released, 'instruments drag across the keys', `${played.size} notes`);

  // A duplicated instrument shares its programs, until it makes its own copy
  await tm.click('#duplicate-instrument');
  await tm.click('#kinds button[data-kind="1"]');
  const sharedBefore = await tm.evaluate(() => {
    const s = window.instrumentMaker.state();
    return s.instruments[0].targets[1].program === s.instruments[s.current].targets[1].program;
  });
  await tm.click('#duplicate');
  const sharedAfter = await tm.evaluate(() => {
    const s = window.instrumentMaker.state();
    return s.instruments[0].targets[1].program === s.instruments[s.current].targets[1].program;
  });
  report(sharedBefore && !sharedAfter, 'instruments share programs until copied');

  // Turning vibrato on wobbles the traced pitch, once its delay is over (on
  // Bass, whose saw leaves the pitch free: an arpeggio would set it each frame)
  await tm.click('#kinds button[data-kind="0"]');
  await tm.select('#instrument', '2');
  await tm.click('#vibrato');
  await tm.click('#vibrato-panel .toggles button:nth-child(2)');
  const wobbles = await tm.waitForFunction(() => {
    const t = window.instrumentMaker.trace();
    const early = new Set(t.freq.slice(0, 10)).size;
    const late = new Set(t.freq.slice(30, 60)).size;
    return early === 1 && late > 2;
  }, { timeout: 2000 }).then(() => true, () => false);
  report(wobbles, 'instruments vibrato wobbles the pitch after a delay');
  await tm.click('.intro');

  // A slide step lowers the pitch every frame, looping on itself to keep going
  await tm.click('#add-step');
  const lastStep = await tm.evaluate(() => {
    const s = window.instrumentMaker.state();
    return s.instruments[s.current].targets[0].program.steps.length - 1;
  });
  await tm.select(`.step[data-step="${lastStep}"] .step-type`, 'slide');
  const slides = await tm.waitForFunction(() => {
    const t = window.instrumentMaker.trace();
    return t.freq[3] < t.freq[2] && t.freq[20] < t.freq[10];
  }, { timeout: 2000 }).then(() => true, () => false);
  report(slides, 'instruments slide step moves the pitch');

  // A pulse sweep goes to a goal: moving one goal keeps the next step's, and the width never wraps round
  await tm.select('#instrument', '0');
  await tm.click('#kinds button[data-kind="1"]');
  await tm.$eval('.step[data-step="1"] input[type=range]', (el) => {
    el.value = '4095';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const swept = await tm.waitForFunction(() => {
    const t = window.instrumentMaker.trace();
    const texts = [...document.querySelectorAll('.step-text')].map((e) => e.textContent);
    const jumps = t.pulse.slice(1).some((v, f) => Math.abs(v - t.pulse[f]) > 200);
    return Math.max(...t.pulse) > 4000 && !jumps && /to 0%/.test(texts[2] ?? '') ? texts[1] : false;
  }, { timeout: 2000 }).then((h) => h.jsonValue(), () => false);
  report(!!swept, 'instruments pulse sweep to a goal', swept || '');

  await tm.select('#examples', 'cabrinigreen.sng');
  await tm.waitForFunction(() => window.instrumentMaker.state().source !== '', { timeout: 5000 });
  const loaded = await tm.evaluate(() => {
    const s = window.instrumentMaker.state();
    return `${s.instruments.length} instruments, ${s.programs.map((l) => l.length).join('/')} programs`;
  });
  report(true, 'instruments loads a song', loaded);
  await colorScheme(tm, 'dark');
  await tm.screenshot({ path: `${OUT}/${BROWSER}-instruments-dark.png` });
  await colorScheme(tm, 'light');
  await tm.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow = await tm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow <= 0, 'instruments fits a phone screen', overflow > 0 ? `${overflow}px too wide` : '');
  report(tmErrors.length === 0, 'instruments without errors', tmErrors.join(' | '));

  // --- 4. Instrument maker 2 ------------------------------------------------
  const m2 = await browser.newPage();
  const m2Errors = [];
  m2.on('pageerror', (err) => m2Errors.push(err.message));
  m2.on('console', (msg) => msg.type() === 'error' && m2Errors.push(msg.text()));
  await m2.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await m2.goto(`${base}instruments2.html`);
  await m2.evaluate(() => localStorage.clear());
  await m2.reload();
  await m2.waitForFunction(() => window.maker2?.ready(), { timeout: 5000 });
  report(true, 'maker2 page loads');

  // Bars of 1, 2, 15, 16 and 31 frames, a gap, and an overlap play for exactly their frames
  const exact = await m2.evaluate(() => {
    const s = window.maker2.state();
    const bars = [
      { wave: 0x80, start: 0, end: 1 },
      { wave: 0x40, start: 1, end: 3 },
      { wave: 0x20, start: 3, end: 18 },
      { wave: 0x10, start: 18, end: 34 },
      { wave: 0x40, start: 40, end: 71 },
      { wave: 0x10, start: 60, end: 80 },
    ];
    s.instruments[s.current].bars = bars;
    s.instruments[s.current].notes = [];
    const frames = 80;
    const got = window.maker2.trace(frames).control;
    for (let f = 0; f < frames; f++) {
      let wave = 0;
      for (const b of bars) if (b.start <= f && f < (b.end ?? Infinity)) wave |= b.wave;
      if (got[f] !== (wave | 1)) return `frame ${f}: ${got[f].toString(16)}, not ${(wave | 1).toString(16)}`;
    }
    // And at the note's pitch
    const freq = window.maker2.trace(frames).freq;
    if (!freq.every((v) => v === freq[0] && v > 0)) return `pitch ${freq[0]} … ${freq[frames - 1]}`;
    return '';
  });
  report(exact === '', 'maker2 bars play for their frames', exact);

  // Pulse width reaches each point on its frame, and repeats from the loop point
  const widths = await m2.evaluate(() => {
    const s = window.maker2.state();
    s.instruments[s.current].bars = [{ wave: 0x40, start: 0, end: null }];
    // Sweeps of 3072 over 30 frames: within the player's 127 a frame
    s.instruments[s.current].pulse = { points: [{ t: 0, w: 0x200 }, { t: 10, w: 0x200 }, { t: 40, w: 0xe00 }, { t: 70, w: 0x200 }], loop: 1 };
    const p = window.maker2.trace(140).pulse;
    return [0, 10, 40, 70, 100, 130].map((f) => p[f].toString(16)).join(' ');
  });
  report(widths === '200 200 e00 200 e00 200', 'maker2 pulse width follows its points and repeats', widths);

  // Steeper than a sweep can go: set along the line, a frame at a time
  const steep = await m2.evaluate(() => {
    const s = window.maker2.state();
    s.instruments[s.current].pulse = { points: [{ t: 0, w: 0x100 }, { t: 4, w: 0xf00 }], loop: null };
    const p = window.maker2.trace(8).pulse;
    return [0, 2, 4, 7].map((f) => p[f].toString(16)).join(' ');
  });
  report(steep === '100 800 f00 f00', 'maker2 steep pulse width follows the line', steep);

  // A repeat that doesn't end where it began jumps back each time round, keeping its length
  const saw = await m2.evaluate(() => {
    const s = window.maker2.state();
    s.instruments[s.current].pulse = { points: [{ t: 0, w: 0x200 }, { t: 30, w: 0xe00 }], loop: 0 };
    const p = window.maker2.trace(100).pulse;
    return [0, 30, 31, 60, 61, 90].map((f) => p[f].toString(16)).join(' ');
  });
  report(saw === '200 e00 266 e00 266 e00', 'maker2 pulse repeat jumps back', saw);

  // The waveform repeats from its loop point to the end of its last bar, at exactly that length
  const waveRepeat = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    ins.bars = [{ wave: 0x80, start: 0, end: 2 }, { wave: 0x40, start: 2, end: 5 }, { wave: 0x20, start: 5, end: 9 }];
    ins.waveLoop = 2;
    const letters = Array.from(window.maker2.trace(23).control).map((v) => ({ 0x81: 'N', 0x41: 'P', 0x21: 'S' })[v] ?? '?').join('');
    ins.waveLoop = null;
    return letters;
  });
  report(waveRepeat === 'NNPPPSSSSPPPSSSSPPPSSSS', 'maker2 waveform repeats', waveRepeat);

  // Notes: a chord arpeggio of 0, +4, +7 a frame each, repeating with the waveform
  const arp = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    ins.bars = [{ wave: 0x40, start: 0, end: 3 }];
    ins.notes = [{ start: 0, semis: 0 }, { start: 1, semis: 4 }, { start: 2, semis: 7 }];
    ins.waveLoop = 0;
    const t = window.maker2.trace(9);
    const out = Array.from(t.freq).map((f) => Math.round(12 * Math.log2(f / t.freq[0]))).join(' ');
    ins.waveLoop = null;
    ins.notes = [];
    return out;
  });
  report(arp === '0 4 7 0 4 7 0 4 7', 'maker2 notes arpeggio', arp);

  // After the last bar: holding keeps the waveform, otherwise it falls silent (gate still on)
  const ending = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    ins.bars = [{ wave: 0x20, start: 0, end: 4 }];
    ins.hold = true;
    const held = Array.from(window.maker2.trace(6).control).map((v) => v.toString(16)).join(' ');
    ins.hold = false;
    const silent = Array.from(window.maker2.trace(6).control).map((v) => v.toString(16)).join(' ');
    ins.hold = true;
    return `${held} / ${silent}`;
  });
  report(ending === '21 21 21 21 21 21 / 21 21 21 21 1 1', 'maker2 hold or fall silent', ending);

  // Vibrato: a steady pitch until its delay runs out, then a wobble around it
  const vib = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    ins.bars = [{ wave: 0x40, start: 0, end: 4 }];
    ins.hold = true;
    ins.vibrato = { delay: 10, turn: 3, even: true, depth: 3 };
    const f = Array.from(window.maker2.trace(60).freq);
    ins.vibrato = null;
    const first = f.findIndex((v) => v !== f[0]);
    const after = f.slice(first);
    return `${first > 5 && first < 20 ? 'waits' : `starts at ${first}`}, ${Math.max(...after) > f[0] && Math.min(...after) < f[0] ? 'wobbles' : 'no wobble'}`;
  });
  report(vib === 'waits, wobbles', 'maker2 vibrato', vib);

  // A glide: the same slide on any key, arriving on its pitch where it ends
  const glide = await m2.evaluate(() => {
    const m = window.maker2;
    const s = m.state();
    const ins = s.instruments[s.current];
    ins.bars = [{ wave: 0x20, start: 0, end: 40 }];
    ins.notes = [{ start: 0, semis: 0 }, { start: 10, semis: 12, glide: 20 }];
    const curves = [24, 48, 72].map((key) => {
      m.setKey(key);
      const f = Array.from(m.trace(35).freq);
      return [12, 20, 26, 30].map((t) => (12 * Math.log2(f[t] / f[0])).toFixed(1)).join(' ');
    });
    m.setKey(48);
    ins.notes = [];
    return curves.every((c) => c === curves[0]) ? curves[0] : `differs by key: ${curves.join(' / ')}`;
  });
  report(/^1\.\d [56]\.\d [89]\.\d 12\.0$/.test(glide), 'maker2 glide', glide);

  // Fixed pitch: the same note whatever key is played
  const fixed = await m2.evaluate(() => {
    const m = window.maker2;
    const s = m.state();
    const ins = s.instruments[s.current];
    ins.fixedNote = 36;
    const f = [24, 60].map((key) => (m.setKey(key), m.trace(5).freq[3]));
    ins.fixedNote = null;
    m.setKey(48);
    return f[0] === f[1] && f[0] > 0 ? 'same' : `${f[0]} vs ${f[1]}`;
  });
  report(fixed === 'same', 'maker2 fixed pitch', fixed);

  // A fixed key up: the instrument lets go itself, there, also partway through a repeat
  const letGo = await m2.evaluate(() => {
    const m = window.maker2;
    const s = m.state();
    const ins = s.instruments[s.current];
    ins.release = 6;
    const plain = Array.from(m.trace(10).control, (v) => v & 1).join('');
    ins.bars = [{ wave: 0x20, start: 0, end: 3 }];
    ins.notes = [{ start: 0, semis: 0 }, { start: 1, semis: 4 }, { start: 2, semis: 7 }];
    ins.waveLoop = 0;
    ins.release = 7;
    const t = m.trace(14);
    const base = t.freq[0];
    const arp = `${Array.from(t.control, (v) => v & 1).join('')} ${Array.from(t.freq, (f) => Math.round(12 * Math.log2(f / base))).join(',')}`;
    ins.release = null;
    ins.waveLoop = null;
    ins.notes = [];
    ins.bars = [{ wave: 0x20, start: 0, end: 4 }];
    return `${plain} / ${arp}`;
  });
  report(letGo === '1111110000 / 11111110000000 0,4,7,0,4,7,0,4,7,0,4,7,0,4', 'maker2 fixed key up', letGo);

  // Hard restart: on by default, off in the gate timer's top bit
  const restart = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    const on = window.maker2.audition().instrument.gateTimer;
    ins.hardRestart = false;
    const off = window.maker2.audition().instrument.gateTimer;
    ins.hardRestart = true;
    return `${on.toString(16)} ${off.toString(16)}`;
  });
  report(restart === '2 82', 'maker2 hard restart', restart);

  // A step fixed on its own (a drum hit before a bass): the same on any key, the rest from the key
  const steps = await m2.evaluate(() => {
    const m = window.maker2;
    const s = m.state();
    const ins = s.instruments[s.current];
    ins.notes = [{ start: 0, semis: 12, fixed: true }, { start: 3, semis: 0 }];
    const f = [24, 60].map((key) => (m.setKey(key), m.trace(6).freq));
    ins.notes = [];
    m.setKey(48);
    return `${f[0][1] === f[1][1] ? 'fixed' : 'moves'} then ${f[0][4] !== f[1][4] ? 'played' : 'stuck'}`;
  });
  report(steps === 'fixed then played', 'maker2 fixed steps', steps);

  // Ring modulation and sync: the register's bits, for the whole note or a stretch
  const bitsSet = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    ins.bits = [{ wave: 0x04, start: 0, end: null }, { wave: 0x02, start: 1, end: 3 }];
    const c = Array.from(window.maker2.trace(6).control, (v) => (v & 6).toString(16)).join('');
    ins.bits = [];
    return c;
  });
  report(bitsSet === '466444', 'maker2 ring and sync', bitsSet);

  // Song instruments imported: those with nothing the shapes can't hold play just as they did
  const imported = await m2.evaluate(async () => {
    const out = [];
    for (const name of ['sanction.sng', 'dojo.sng']) {
      const bytes = new Uint8Array(await (await fetch(`examples/${name}`)).arrayBuffer());
      for (const r of window.maker2.importSong(bytes)) if (!r.gaps.length && r.differs.length) out.push(`${name} ${r.name}: ${r.differs.join(', ')}`);
    }
    return out.join('; ') || 'all the same';
  });
  report(imported === 'all the same', 'maker2 imports song instruments', imported);

  // The filter: set up on the first frame (band pass, resonance, voice 1), its cutoff following the line
  const filt = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    const was = ins.filter;
    ins.filter = {
      cutoff: { points: [{ t: 0, w: 0x10 }, { t: 20, w: 0xf0 }], loop: 0 },
      resonance: { points: [{ t: 0, w: 12 }], loop: null },
      types: [{ start: 0, end: 10, passband: 0x20 }, { start: 10, end: 20, passband: 0x50 }],
    };
    const t = window.maker2.trace(50);
    // A gap between chunks isn't filtered; after the last, the filter stays on (unless it stops, as an imported one may)
    ins.filter = { ...ins.filter, cutoff: { points: [{ t: 0, w: 0x80 }], loop: null }, types: [{ start: 0, end: 5, passband: 0x10 }, { start: 8, end: 10, passband: 0x10 }] };
    const after = window.maker2.trace(20).routing;
    const gap = after[6] & 1;
    const stayed = after[15] & 1;
    ins.filter = { ...ins.filter, stops: true };
    const stopped = window.maker2.trace(20).routing[15] & 1;
    // A chunk ending on the repeat's end stays on all the way round (its last frame too)
    ins.filter = { ...ins.filter, cutoff: { points: [{ t: 0, w: 0x80 }, { t: 5, w: 0x40 }, { t: 15, w: 0xc0 }], loop: 1 }, types: [{ start: 0, end: 15, passband: 0x10 }] };
    const round = window.maker2.trace(60).routing.slice(0, 60).every((r) => r & 1);
    ins.filter = was;
    if (gap) return 'still filtered after its chunk';
    if (!stayed) return 'not filtered after the last chunk';
    if (stopped) return 'still filtered after a stopping last chunk';
    if (!round) return 'a gap in the filter as it repeats';
    // The type changes on its frame (and again each time round), the cutoff undisturbed
    const types = [0, 9, 10, 20, 21, 30].map((f) => (t.mode[f] >> 4).toString(16)).join('');
    return `${t.routing[0].toString(16)} ${types} ${[0, 10, 20, 21, 40].map((f) => t.cutoff[f].toString(16)).join(' ')}`;
  });
  report(filt === 'c1 225525 10 80 f0 1b f0', 'maker2 filter', filt);

  // A key held plays: the worklet runs the note at a pitch, gate on
  await m2.keyboard.down('k');
  const sounding = await m2
    .waitForFunction(() => {
      const st = window.maker2.status();
      return st && (st.regs[0] | st.regs[1]) && st.regs[4] & 1 && st.envelopes[0] > 0;
    }, { timeout: 3000 })
    .then(() => true, () => false);
  await m2.keyboard.up('k');
  report(sounding, 'maker2 a key plays the note');

  // The filter a note leaves on stays on; a note without a filter starts with it off
  const unfilter = async (types) => {
    await m2.evaluate((types) => {
      const s = window.maker2.state();
      s.instruments[s.current].filter = { types, cutoff: { points: [{ t: 0, w: 0x40 }], loop: null }, resonance: { points: [{ t: 0, w: 8 }], loop: null } };
      window.maker2.changed();
    }, types);
    await m2.keyboard.down('k');
    await new Promise((r) => setTimeout(r, 400));
    const routed = await m2.evaluate(() => window.maker2.status().regs[0x17] & 1);
    await m2.keyboard.up('k');
    return routed;
  };
  const leftOn = await unfilter([{ start: 0, end: 3, passband: 0x10 }]);
  const unfiltered = await unfilter([]);
  report(leftOn === 1 && unfiltered === 0, 'maker2 a note without a filter plays unfiltered', `${leftOn} ${unfiltered}`);

  // Dragging the attack dot to the right makes the attack slower
  const plotPoint = (frame, y) =>
    m2.evaluate(
      (frame, y) => {
        const r = document.getElementById('plot').getBoundingClientRect();
        return [r.left + 16 + frame * window.maker2.state().zoom, r.top + y];
      },
      frame,
      y,
    );
  const dragTo = async (from, to) => {
    await m2.mouse.move(...from);
    await m2.mouse.down();
    for (let i = 1; i <= 6; i++) await m2.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6);
    await m2.mouse.up();
  };
  await m2.reload();
  await m2.waitForFunction(() => window.maker2?.ready(), { timeout: 5000 });
  const dot = await m2.$eval('[data-drag=a] circle:not(.hit)', (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await dragTo(dot, [(await plotPoint(25, 0))[0], dot[1]]);
  const attack = await m2.evaluate(() => window.maker2.state().instruments[0].ad >> 4);
  report(attack === 10, 'maker2 drag the attack', `attack ${attack}`);

  // Dragging the sustain capsule down lowers the level held, and leaves decay alone
  const capsule = await m2.$eval('[data-drag=s] .dot', (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await dragTo(capsule, [capsule[0], capsule[1] + 60]);
  const env = await m2.evaluate(() => window.maker2.state().instruments[0]);
  report(env.sr >> 4 < 10 && (env.ad & 15) === 9, 'maker2 drag the sustain', `sustain ${env.sr >> 4}, decay ${env.ad & 15}`);

  // Silent by the key going up (no sustain), release's dot is still there to set, a whole release on from it
  const releaseDot = await m2.evaluate(() => {
    const s = window.maker2.state();
    const ins = s.instruments[s.current];
    const was = [ins.ad, ins.sr];
    [ins.ad, ins.sr] = [0x05, 0x09];
    window.maker2.changed();
    const at = (key) => document.querySelector(`[data-drag=${key}] circle.dot`).getAttribute('cx');
    const gap = Number(at('r')) - Number(at('s'));
    [ins.ad, ins.sr] = was;
    window.maker2.changed();
    return gap;
  });
  report(releaseDot > 20, 'maker2 release without sustain', `${releaseDot}px past the key up`);

  // The key played's step, before the first change, has its end to drag too (moving that change)
  await m2.evaluate(() => {
    const s = window.maker2.state();
    s.instruments[s.current].notes = [{ start: 20, semis: 5 }];
    s.notesOpen = true;
    window.maker2.changed();
  });
  // (once the opened roll has settled)
  await new Promise((r) => setTimeout(r, 500));
  const firstEnd = await m2.$eval('[data-note="-1"] [data-note-edge=end]', (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + 2, r.y + r.height / 2];
  });
  await dragTo(firstEnd, [(await plotPoint(30, 0))[0], firstEnd[1]]);
  const moved = await m2.evaluate(() => JSON.stringify(window.maker2.state().instruments[window.maker2.state().current].notes));
  report(moved === '[{"start":30,"semis":5}]', 'maker2 drag the first pitch step\'s end', moved);

  // Clicking the waveform strip under the volume opens the rows there, to draw in
  const strip = await m2.$eval('[data-span="0"] rect', (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + 30, r.y + r.height / 2];
  });
  await m2.mouse.click(...strip);
  const openRowY = await m2.evaluate(() => document.querySelector('.lane-line').getBoundingClientRect().top - document.getElementById('plot').getBoundingClientRect().top + 20);
  await dragTo(await plotPoint(40, openRowY), await plotPoint(50, openRowY));
  const folded = await m2.evaluate(() => {
    const s = window.maker2.state();
    return `${s.waveOpen ? 'open' : 'closed'} ${JSON.stringify(s.instruments[0].bars.find((b) => b.wave === 0x10))}`;
  });
  report(folded === 'open {"wave":16,"start":40,"end":50}', 'maker2 draw under the volume', folded);

  // Double-clicking an empty spot in a row adds a bar there, one grid step long
  const spot = await plotPoint(75, openRowY);
  await m2.mouse.click(...spot);
  await m2.mouse.click(...spot, { clickCount: 2 });
  const added = await m2.evaluate(() => JSON.stringify(window.maker2.state().instruments[0].bars.find((b) => b.wave === 0x10 && b.start <= 75 && 75 < b.end)));
  report(!!added, 'maker2 double-click adds a bar', added ?? 'none');
  // Close the waveform rows again by their name in the left column
  await m2.evaluate(() => [...document.querySelectorAll('.tl-gutter-row.fold')].find((e) => e.textContent.includes('Waveform')).click());


  // The clock: NTSC's faster chip makes the same release setting shorter
  const releaseText = () => m2.$eval('[data-drag=r] text', (e) => e.textContent);
  const palRelease = await releaseText();
  await m2.click('#clock [data-ntsc="1"]');
  const ntscRelease = await releaseText();
  await m2.click('#clock [data-ntsc="0"]');
  report(palRelease === 'Release 761 ms' && ntscRelease === 'Release 733 ms', 'maker2 clock changes envelope times', `${palRelease} → ${ntscRelease}`);

  // Saved and loaded again, glides and fixed steps stay
  const kept = await m2.evaluate(() => {
    const s = window.maker2.state();
    s.instruments[0].notes = [{ start: 0, semis: 5, fixed: true }, { start: 4, semis: 0, glide: 6 }];
    localStorage.setItem('sidkid.maker2.v1', JSON.stringify(s));
  });
  await m2.reload();
  await m2.waitForFunction(() => window.maker2?.ready());
  const reloaded = await m2.evaluate(() => JSON.stringify(window.maker2.state().instruments[0].notes));
  report(reloaded === '[{"start":0,"semis":5,"fixed":true},{"start":4,"semis":0,"glide":6}]', 'maker2 keeps glides and fixed steps', reloaded);

  // The note start, sync and ring checkboxes wait in the Advanced box, closed at first
  const advanced = await m2.evaluate(async () => {
    const shut = document.getElementById('instrument-options').hidden;
    document.getElementById('advanced-toggle').click();
    const open = !document.getElementById('instrument-options').hidden;
    const boxes = document.querySelectorAll('#instrument-options input[type=checkbox]').length;
    document.getElementById('advanced-toggle').click();
    return `${shut ? 'closed' : 'open'}, then ${open ? 'open' : 'closed'} with ${boxes} checkboxes`;
  });
  report(advanced === 'closed, then open with 4 checkboxes', 'maker2 advanced box', advanced);

  await colorScheme(m2, 'dark');
  await m2.screenshot({ path: `${OUT}/${BROWSER}-maker2-dark.png` });
  await colorScheme(m2, 'light');
  await m2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow2 = await m2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow2 <= 0, 'maker2 fits a phone screen', overflow2 > 0 ? `${overflow2}px too wide` : '');
  report(m2Errors.length === 0, 'maker2 without errors', m2Errors.join(' | '));

  // --- 5. Song maker --------------------------------------------------------
  const sm = await browser.newPage();
  const smErrors = [];
  sm.on('pageerror', (err) => smErrors.push(err.message));
  sm.on('console', (msg) => msg.type() === 'error' && smErrors.push(msg.text()));
  await sm.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 });
  await sm.goto(`${base}songs.html`);
  await sm.evaluate(() => localStorage.clear());
  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready(), { timeout: 5000 });
  report(true, 'song maker page loads');

  // The tracks start under the ruler (32) and the tempo lane (34)
  const TRACKS_TOP = 66;

  // Frequency (hex) and gate of a voice, frame by frame: "freq:gate", runs collapsed to "xN"
  const voiceRuns = (regs, v) => {
    const out = [];
    for (const r of regs) {
      const k = `${(r[v * 7] | (r[v * 7 + 1] << 8)).toString(16)}:${r[v * 7 + 4] & 1}`;
      if (out.length && out[out.length - 1][0] === k) out[out.length - 1][1]++;
      else out.push([k, 1]);
    }
    return out.map(([k, n]) => `${k}x${n}`).join(' ');
  };

  // A note starts on its frame: step 4 at 6 frames a step is frame 24 (the gate goes off two frames before, for the hard
  // restart); it lets go its lead (3 frames) before its end, as GoatTracker's player does before a key-off row
  const onTime = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks.forEach((t) => (t.clips = []));
    s.tracks[0].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 4, length: 4, note: 48 }] }];
    window.songMaker.render();
    return window.songMaker.trace(60);
  });
  const onRuns = voiceRuns(onTime, 0);
  report(onRuns === '0:0x23 0:1x1 1168:1x21 1168:0x15', 'song notes play on their frames', onRuns);

  // Two tracks on one voice take turns: the newer note takes it, and the held one comes back after
  const turns = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks[1].voice = 0;
    s.tracks[1].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 0, length: 16, note: 31 }] }];
    window.songMaker.render();
    return window.songMaker.trace(100);
  });
  const turnRuns = voiceRuns(turns, 0);
  report(turnRuns === '685:1x21 685:0x2 685:1x1 1168:1x21 1168:0x2 1168:1x1 685:1x45 685:0x7', 'song tracks on one voice take turns', turnRuns);

  // A note getting its voice back picks up where it left off: after the other track's note, the
  // Lead's pulse sweep and waveform carry on as if it had played alone
  const resumed = await sm.evaluate(() => {
    const s = window.songMaker.song();
    const was = JSON.stringify(s.tracks);
    s.tracks[0].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 0, length: 16, note: 48 }] }];
    s.tracks[1].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 4, length: 2, note: 60 }] }];
    s.tracks[1].voice = 0;
    window.songMaker.render();
    const both = window.songMaker.trace(96);
    s.tracks[1].muted = true;
    window.songMaker.render();
    const alone = window.songMaker.trace(96);
    s.tracks = JSON.parse(was);
    window.songMaker.render();
    const differ = [];
    // From the frame it's back (step 6 = frame 36) to the note's end, but for the frames its gate goes off
    for (let f = 36; f < 94; f++) {
      const pw = (r) => r[2] | ((r[3] & 15) << 8);
      if (Math.abs(pw(both[f]) - pw(alone[f])) > 2 || (both[f][4] & 0xf0) !== (alone[f][4] & 0xf0) || both[f][0] !== alone[f][0]) differ.push(f);
    }
    return differ.length ? `differs at ${differ.slice(0, 6).join(',')}` : 'carries on';
  });
  report(resumed === 'carries on', 'song note picks up where it left off', resumed);

  // A note of each starting instrument, its voice taken for a step at points through it, plays on as it would have
  const resumeChecks = await sm.evaluate(() => {
    const out = [];
    window.songMaker.instruments().forEach((ins, i) => {
      for (const at of [1, 2, 3, 5, 8, 13]) {
        const d = window.songMaker.resumeCheck(i, at, 120);
        if (d && d !== 'silent' && d.length) out.push(`${ins.name} @${at}: ${d[0]}`);
      }
    });
    return out;
  });
  report(resumeChecks.length === 0, 'song resumes match the note', resumeChecks.slice(0, 4).join(' | '));

  // Other voices play at the same time
  const together = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks[1].voice = 1;
    window.songMaker.render();
    return window.songMaker.trace(30);
  });
  report(voiceRuns(together, 1) === '685:1x30', 'song voices play together', voiceRuns(together, 1));

  // Cycling repeats exactly: each pass of a bar is the same, frame for frame
  const cycled = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks[1].clips = [];
    s.tracks[0].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 0, length: 4, note: 48 }, { start: 8, length: 8, note: 55 }] }];
    s.cycle = { start: 0, end: 16 };
    s.cycling = true;
    window.songMaker.render();
    const regs = window.songMaker.trace(96 * 3);
    s.cycling = false;
    window.songMaker.render();
    return regs.map((r) => `${r[0]},${r[1]},${r[4]}`);
  });
  const passes = [0, 1, 2].map((n) => cycled.slice(n * 96 + 8, (n + 1) * 96).join(' '));
  report(passes[0] === passes[1] && passes[1] === passes[2] && cycled[96] === cycled[192], 'song cycle repeats exactly', `${cycled[0]} / ${cycled[96]} / ${cycled[192]}`);

  // The metronome clicks on the song's beats, high on bars; counting in, a bar of them first
  const clicks = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks[0].clips = [{ start: 0, length: 32, span: 32, notes: [] }];
    const c = window.songMaker.clicks(6, true);
    return `${c.bars.join(',')} / ${c.beats.join(',')} / ${c.preroll}`;
  });
  report(clicks === '-36,60 / -84,-60,-12,12,36,84,108,132 / 97', 'song metronome and count-in', clicks);

  // Any tempo: at 128 BPM a beat is 23.4375 frames, so beats land on the nearest frames
  await sm.evaluate(() => (document.getElementById('tempo').value = ''));
  await sm.type('#tempo', '128');
  await sm.keyboard.press('Enter');
  const odd = await sm.evaluate(() => {
    const c = window.songMaker.clicks(0, false);
    return `${window.songMaker.song().bpm}: ${c.bars.join(',')} / ${c.beats.join(',')}`;
  });
  report(odd === '128: 0,94 / 23,47,70,117,141,164', 'song any tempo', odd);
  await sm.evaluate(() => {
    window.songMaker.song().bpm = 125;
    window.songMaker.render();
  });

  // Tempo changes: a note after one lands on the frame the steps before it add up to, held or ramped
  const tempoOnsets = await sm.evaluate(() => {
    const s = window.songMaker.song();
    const keep = JSON.stringify(s);
    s.tracks.forEach((t) => (t.clips = []));
    s.tracks[0].clips = [{ start: 0, length: 32, span: 32, notes: [{ start: 20, length: 4, note: 48 }] }];
    const onset = () => {
      const regs = window.songMaker.trace(400);
      return regs.findIndex((r) => (r[0] | (r[1] << 8)) === 0x1168);
    };
    s.bpm = 125;
    s.tempo = [{ step: 16, bpm: (60 * 50) / (7 * 4) }];
    window.songMaker.render();
    const held = onset();
    // Ramping from 120 at the start to 60 at step 8, then held: each step's frames at its tempo
    s.bpm = 120;
    s.tempo = [{ step: 8, bpm: 60, ramp: true }];
    window.songMaker.render();
    const ramped = onset();
    let want = 0;
    for (let k = 0; k < 20; k++) want += 750 / (k < 8 ? 120 - 7.5 * k : 60);
    Object.assign(s, JSON.parse(keep));
    delete s.tempo;
    window.songMaker.render();
    return `${held} ${ramped}/${Math.round(want)}`;
  });
  const [heldOnset, rampOnset] = tempoOnsets.split(' ');
  report(heldOnset === '124' && rampOnset.split('/')[0] === rampOnset.split('/')[1], 'song tempo changes', tempoOnsets);

  // Double-click in a lane makes a clip; double-click in the editor adds a note
  await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks.forEach((t) => (t.clips = []));
    window.songMaker.render();
  });
  const arrBox = await sm.$eval('#arr', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.click(arrBox.x + 6 * 16 + 30, arrBox.y + TRACKS_TOP + 56 + 28, { count: 2 });
  const made = await sm.evaluate(() => JSON.stringify(window.songMaker.song().tracks.map((t) => t.clips.map((c) => [c.start, c.length, c.span]))));
  report(made === '[[],[[16,16,16]],[]]', 'song double-click makes a clip', made);
  const rollBox = await sm.$eval('#roll-scroll', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.click(rollBox.x + 8 + 22 * 2 + 5, rollBox.y + rollBox.height / 2, { count: 2 });
  const noted = await sm.evaluate(() => JSON.stringify(window.songMaker.openClip().notes.map((n) => [n.start, n.length])));
  report(noted === '[[2,2]]', 'song double-click adds a note', noted);

  // Dragging a note's middle moves it a step at a time
  const noteBox = await sm.$eval('.roll-note', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(noteBox.x + 8, noteBox.y + 4);
  await sm.mouse.down();
  await sm.mouse.move(noteBox.x + 8 + 44, noteBox.y + 4 - 11, { steps: 4 });
  await sm.mouse.up();
  const dragged = await sm.evaluate(() => JSON.stringify(window.songMaker.openClip().notes.map((n) => [n.start, n.length])));
  report(dragged === '[[4,2]]', 'song drag moves a note', dragged);

  // Its left end moves its start and keeps its end; the ends show arrows, the middle a hand
  const nb = await sm.$eval('.roll-note', (e) => e.getBoundingClientRect().toJSON());
  // (what is actually under the pointer: a handle's own cursor is no use if something covers it)
  const cursors = await sm.evaluate(() =>
    [['.roll-note', 'left'], ['.roll-note', 'middle'], ['.roll-note', 'right'], ['.arr-cycle', 'left'], ['.arr-cycle', 'middle'], ['.arr-cycle', 'right'], ['.clip2-body', 'right']]
      .map(([q, where]) => {
        const r = document.querySelector(q).getBoundingClientRect();
        const x = where === 'left' ? r.left + 1 : where === 'right' ? r.right - 1 : (r.left + r.right) / 2;
        return getComputedStyle(document.elementFromPoint(x, r.top + r.height / 2)).cursor;
      })
      .join(' '),
  );
  await sm.mouse.move(nb.x + 2, nb.y + 4);
  await sm.mouse.down();
  await sm.mouse.move(nb.x + 2 - 22, nb.y + 4, { steps: 3 });
  const during = await sm.evaluate(() => getComputedStyle(document.body).cursor);
  await sm.mouse.up();
  const stretched = await sm.evaluate(() => JSON.stringify(window.songMaker.openClip().notes.map((n) => [n.start, n.length])));
  report(stretched === '[[3,3]]' && cursors === 'ew-resize grab ew-resize ew-resize grab ew-resize ew-resize' && during === 'ew-resize', 'song note ends and cursors', `${stretched} ${cursors} / ${during}`);

  // ⌘C copies the notes selected, ⌘V pastes them at the playhead (selected); past the clip's end it grows by bars
  const pressMeta = async (key) => {
    await sm.keyboard.down('Meta');
    await sm.keyboard.press(key);
    await sm.keyboard.up('Meta');
  };
  await pressMeta('c');
  await sm.evaluate(() => window.songMaker.setPlayhead(16 + 8));
  await pressMeta('v');
  await sm.evaluate(() => window.songMaker.setPlayhead(16 + 15));
  await pressMeta('v');
  const pasted = await sm.evaluate(() => {
    const c = window.songMaker.openClip();
    const out = `${JSON.stringify(c.notes.map((n) => [n.start, n.length]))} ${c.length}/${c.span} ${window.songMaker.selectedNotes().map((n) => n.start).join(',')}`;
    c.notes = c.notes.slice(0, 1);
    c.length = c.span = 16;
    window.songMaker.render();
    return out;
  });
  report(pasted === '[[3,3],[8,3],[15,3]] 32/32 15', 'song copies and pastes notes', pasted);

  // Z goes back to the start (of the cycle, when it's on)
  await sm.evaluate(() => window.songMaker.setPlayhead(24));
  await sm.keyboard.press('z');
  const rtz = await sm.evaluate(() => {
    const s = window.songMaker.song();
    return `${window.songMaker.playhead()} ${s.cycling ? s.cycle.start : 0}`;
  });
  report(rtz.split(' ')[0] === rtz.split(' ')[1], 'song Z goes back to the start', rtz);

  // The editor's ruler numbers the song's bars (this clip starts on bar 2)
  const rollBars = await sm.evaluate(() => [...document.querySelectorAll('#roll-ruler text')].map((t) => t.textContent).join(' '));
  report(rollBars.startsWith('2 2.2 2.3 2.4 3'), 'song editor shows bars', rollBars.slice(0, 40));

  // Effects on notes: the buttons over a note slide it in from the one before, and add vibrato; it plays as drawn
  const fxBefore = await sm.evaluate(() => {
    const c = window.songMaker.openClip();
    const keep = JSON.stringify(c.notes);
    c.notes = [{ start: 0, length: 3, note: 36 }, { start: 4, length: 8, note: 43 }];
    window.songMaker.render();
    return keep;
  });
  const fxNotes = await sm.$$eval('.roll-note', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  await sm.mouse.click(fxNotes[1].x + fxNotes[1].width / 2, fxNotes[1].y + 3);
  await sm.click('.fx-bar [data-kind="slide"]');
  await sm.click('.fx-bar [data-kind="vibrato"]');
  const fxMade = await sm.evaluate(() => JSON.stringify(window.songMaker.openClip().notes.map((n) => [n.start, n.length, n.slide ? 'slide' : '-', (n.effects ?? []).map((e) => `${e.kind}${e.from}-${e.to}`).join(' ')])));
  // A band dragged up two notches: a deeper vibrato (its depth halved twice less)
  const vibBand = await sm.$eval('.fx-vibrato .roll-fx-band', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(vibBand.x + vibBand.width / 2, vibBand.y + 2);
  await sm.mouse.down();
  await sm.mouse.move(vibBand.x + vibBand.width / 2, vibBand.y + 2 - 24, { steps: 4 });
  await sm.mouse.up();
  const fxPlayed = await sm.evaluate(() => {
    const n = window.songMaker.openClip().notes[1];
    const depth = n.effects.find((e) => e.kind === 'vibrato').speed.right;
    // Played: the slide goes through pitches between the two notes, and the vibrato wobbles after it
    const regs = window.songMaker.trace(240, 16);
    const v = window.songMaker.song().tracks.find((t) => t.clips.includes(window.songMaker.openClip())).voice * 7;
    const freqs = regs.map((r) => r[v] | (r[v + 1] << 8));
    const between = new Set(freqs.filter((f) => f > 0x8b4 && f < 0xd0e)).size;
    return `depth ${depth}, ${between > 2 ? 'glides' : 'jumps'}`;
  });
  await sm.evaluate((keep) => {
    window.songMaker.openClip().notes = JSON.parse(keep);
    window.songMaker.render();
  }, fxBefore);
  report(fxMade === '[[0,4,"-",""],[4,8,"slide","slide0-3 vibrato3-8"]]' && fxPlayed === 'depth 1, glides', 'song note effects', `${fxMade} ${fxPlayed}`);

  // The clip's upper right edge repeats it
  const clipBox = await sm.$eval('.clip2-body', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(clipBox.right - 5, clipBox.y + 8);
  await sm.mouse.down();
  await sm.mouse.move(clipBox.right - 5 + 96, clipBox.y + 8, { steps: 6 });
  await sm.mouse.up();
  const repeated = await sm.evaluate(() => JSON.stringify(window.songMaker.song().tracks[1].clips.map((c) => [c.start, c.length, c.span])));
  report(repeated === '[[16,16,32]]', 'song clip repeats', repeated);

  // One outline, notched top and bottom where the repeat starts; the length handle at the end of the piece itself
  const drawn = await sm.evaluate(() => {
    const piece = document.querySelector('.clip2-body').getBoundingClientRect();
    const handle = document.querySelector('.clip2-extend .clip2-edge').getBoundingClientRect();
    const arcs = (document.querySelector('.clip2-outline').getAttribute('d').match(/A/g) ?? []).length;
    return `${document.querySelector('[data-repeats]').dataset.repeats} repeat, ${arcs} arcs, ${Math.abs(handle.right - piece.right) <= 1 ? 'handle at its end' : handle.right - piece.right}`;
  });
  report(drawn === '1 repeat, 8 arcs, handle at its end', 'song repeats drawn in one outline', drawn);

  // The editor's piano lights the key that's down
  await sm.keyboard.down('d');
  const lit = await sm.evaluate(() => [...document.querySelectorAll('#roll-keys .down')].map((k) => k.dataset.key).join(','));
  await sm.keyboard.up('d');
  const unlit = await sm.evaluate(() => document.querySelectorAll('#roll-keys .down').length);
  report(lit === '40' && unlit === 0, 'song piano lights up', `${lit} then ${unlit}`);

  // Dragging along the editor's ruler scrubs the playhead (the clip starts on bar 2)
  const rr = await sm.$eval('#roll-ruler', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(rr.x + 8 + 2, rr.y + 10);
  await sm.mouse.down();
  await sm.mouse.move(rr.x + 8 + 22 * 4 + 2, rr.y + 10, { steps: 4 });
  const scrubbed = await sm.evaluate(() => document.getElementById('position').textContent);
  await sm.mouse.up();
  report(scrubbed === '2.2.1', 'song scrubs the playhead', scrubbed);

  // The tempo lane: double-click adds a change, dragging it up speeds it up from there; the BPM box shows the tempo at the playhead
  const laneBox = await sm.$eval('#arr', (e) => e.getBoundingClientRect().toJSON());
  const zoomNow = await sm.evaluate(() => JSON.parse(localStorage.getItem('sidkid.song2.v1')).zoom);
  const tempoX = laneBox.x + 32 * zoomNow + 2;
  await sm.mouse.click(tempoX, laneBox.y + 32 + 17, { count: 2 });
  const added3 = await sm.evaluate(() => JSON.stringify(window.songMaker.song().tempo));
  const tempoDot = await sm.$eval('[data-tempo="1"] .dot', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(tempoDot.x + tempoDot.width / 2, tempoDot.y + tempoDot.height / 2);
  await sm.mouse.down();
  await sm.mouse.move(tempoDot.x + tempoDot.width / 2, tempoDot.y + tempoDot.height / 2 - 12, { steps: 4 });
  await sm.mouse.up();
  const dragged3 = await sm.evaluate(() => window.songMaker.song().tempo[0].bpm);
  await sm.evaluate(() => {
    delete window.songMaker.song().tempo;
    window.songMaker.render();
  });
  report(added3 === '[{"step":32,"bpm":125}]' && dragged3 > 125, 'song tempo lane', `${added3} → ${dragged3}`);

  // Zooming out and back in keeps the song in view
  for (let i = 0; i < 8; i++) await sm.click('#zoom-out');
  for (let i = 0; i < 10; i++) await sm.click('#zoom-in');
  const inView = await sm.evaluate(() => {
    const view = document.getElementById('arr-scroll').getBoundingClientRect();
    const clip = document.querySelector('.clip2-body').getBoundingClientRect();
    return clip.right > view.left && clip.left < view.right;
  });
  report(inView, 'song zoom keeps the song in view');
  await sm.click('#zoom-fit');

  // Recording: R plays, a held key becomes a note on the selected track (no count-in here)
  await sm.click('#count-in');
  await sm.mouse.click(arrBox.x - 100, arrBox.y + TRACKS_TOP + 20);
  await sm.keyboard.press('r');
  await sm.waitForFunction(() => window.songMaker.playing());
  await new Promise((r) => setTimeout(r, 500));
  await sm.keyboard.down('a');
  await new Promise((r) => setTimeout(r, 500));
  await sm.keyboard.up('a');
  await sm.keyboard.press(' ');
  const recorded = await sm.evaluate(() => window.songMaker.song().tracks[0].clips.flatMap((c) => c.notes));
  const rec = recorded[0];
  report(recorded.length === 1 && rec.note === 36 && rec.length >= 2 && rec.length <= 6, 'song records played notes', JSON.stringify(recorded));

  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready());
  const kept2 = await sm.evaluate(() => [...document.querySelectorAll('.track-instrument')].map((s, i) => `${s.selectedOptions[0].text} ${window.songMaker.song().tracks[i].clips.length}`).join(', '));
  report(kept2 === 'Lead 1, Bass 1, Snare 0', 'song keeps across a reload', kept2);
  const stillOpen = await sm.evaluate(() => `${window.songMaker.openClip()?.start} ${document.querySelectorAll('.roll-note').length} notes`);
  report(stillOpen === '16 1 notes', 'song keeps the open clip across a reload', stillOpen);

  // A song saved as they were first (one song, with frames a step) comes back, at its tempo
  await sm.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sidkid.song2.v1'));
    const { bpm: _bpm, ...song } = saved.songs[saved.current];
    localStorage.setItem('sidkid.song2.v1', JSON.stringify({ song: { ...song, stepFrames: 8 }, zoom: saved.zoom, rollZoom: saved.rollZoom, open: saved.open }));
  });
  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready());
  const was = await sm.evaluate(() => `${window.songMaker.song().bpm} ${document.getElementById('tempo').value}`);
  report(was === '93.8 93.8', 'song keeps an old tempo', was);

  // Dragging a track's head moves the track, its clips with it; ⌘Z puts it back
  const trackOrder = () => sm.evaluate(() => window.songMaker.song().tracks.map((t) => `${t.voice + 1}:${t.clips.length}`).join(' '));
  const before3 = await trackOrder();
  const hb = await sm.$eval('.track-head .voice-label', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(hb.x + 4, hb.y + 4);
  await sm.mouse.down();
  await sm.mouse.move(hb.x + 4, hb.y + 4 + 56 * 2, { steps: 8 });
  await sm.mouse.up();
  const after3 = await trackOrder();
  await sm.keyboard.down('Meta');
  await sm.keyboard.press('z');
  await sm.keyboard.up('Meta');
  const undone3 = await trackOrder();
  report(after3 === before3.split(' ').slice(1).concat(before3.split(' ')[0]).join(' ') && undone3 === before3, 'song drags a track to move it', `${before3} → ${after3} → ${undone3}`);

  // A song made here, exported: three voices, a note picked up after another track's, a slide, vibrato, a bend, a tempo change;
  // GoatTracker's own player plays the file as it plays here
  const madeHere = await sm.evaluate(() => {
    const s = window.songMaker.song();
    const keep = JSON.stringify(s);
    s.tracks[0].clips = [{ start: 0, length: 32, span: 64, notes: [
      { start: 0, length: 8, note: 48 },
      { start: 8, length: 8, note: 55, slide: { left: 0x80, right: 1 }, effects: [{ from: 0, to: 3, kind: 'slide', speed: { left: 0x80, right: 1 } }, { from: 3, to: 8, kind: 'vibrato', speed: { left: 0x83, right: 3 } }] },
      { start: 20, length: 4, note: 52, effects: [{ from: 1, to: 4, kind: 'up', speed: { left: 0x80, right: 3 } }] },
    ] }];
    s.tracks[1].clips = [{ start: 0, length: 64, span: 64, notes: [{ start: 0, length: 30, note: 36 }, { start: 34, length: 12, note: 31 }] }];
    s.tracks[2].clips = [{ start: 0, length: 16, span: 64, notes: [{ start: 4, length: 2, note: 60 }, { start: 12, length: 2, note: 60 }] }];
    const voices = s.tracks.map((t) => t.voice);
    s.tracks[2].voice = 1;
    s.tempo = [{ step: 32, bpm: (60 * 50) / (7 * 4) }];
    window.songMaker.render();
    const r = window.songMaker.exportCheck();
    Object.assign(s, JSON.parse(keep));
    delete s.tempo;
    s.tracks.forEach((t, i) => (t.voice = voices[i]));
    window.songMaker.render();
    return r;
  });
  report(!madeHere.gaps.length && !Object.keys(madeHere.differ).length, 'song exports as it plays', JSON.stringify(madeHere.gaps.length ? madeHere.gaps : madeHere.first));

  // Clicking a track's head puts its clip down; Delete then asks: clear the track, or delete it (⌘Z brings either back)
  const headLabel = await sm.$eval('.track-head .voice-label', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.click(headLabel.x + 4, headLabel.y + 4);
  await sm.keyboard.press('Delete');
  const asked = await sm.evaluate(() => [...document.querySelectorAll('.ask button')].map((b) => b.textContent).join(', '));
  await sm.evaluate(() => [...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Delete track').click());
  const removed = await sm.evaluate(() => window.songMaker.song().tracks.length);
  await sm.keyboard.down('Meta');
  await sm.keyboard.press('z');
  await sm.keyboard.up('Meta');
  const back = await sm.evaluate(() => window.songMaker.song().tracks.length);
  await sm.mouse.click(headLabel.x + 4, headLabel.y + 4);
  await sm.keyboard.press('Delete');
  await sm.evaluate(() => [...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Clear track').click());
  const cleared = await sm.evaluate(() => window.songMaker.song().tracks[0].clips.length);
  await sm.keyboard.down('Meta');
  await sm.keyboard.press('z');
  await sm.keyboard.up('Meta');
  const unCleared = await sm.evaluate(() => window.songMaker.song().tracks[0].clips.length);
  report(asked === 'Clear track, Delete track, Cancel' && removed === 2 && back === 3 && cleared === 0 && unCleared > 0, 'song clears or deletes a track', `${asked}; ${removed}, ${back}; ${cleared}, ${unCleared}`);

  // Solo: only soloed tracks play (the rest drawn faint); Space on a focused button plays rather than pressing it
  await sm.click('.track-head:nth-of-type(4) .track-solo');
  const soloed = await sm.evaluate(() => `${window.songMaker.song().tracks.map((t) => (t.solo ? 'S' : '-')).join('')} ${document.querySelector('[data-track="0"]').classList.contains('muted') ? 'others faint' : 'others heard'}`);
  await sm.focus('.track-head:nth-of-type(4) .track-solo');
  await sm.keyboard.press(' ');
  await sm.waitForFunction(() => window.songMaker.playing(), { timeout: 2000 }).catch(() => {});
  const spaced = await sm.evaluate(() => `${window.songMaker.song().tracks[1].solo ? 'still soloed' : 'unsoloed'} ${window.songMaker.playing()}`);
  await sm.keyboard.press(' ');
  await sm.click('.track-head:nth-of-type(4) .track-solo');
  report(soloed === '-S- others faint' && spaced === 'still soloed true', 'song solo, Space plays', `${soloed}; ${spaced}`);

  // Instruments saved before they had ids get them for good: a track's pick survives reloads
  const picked = await sm.evaluate(() => {
    const saved = { instruments: window.songMaker.instruments().map(({ id: _id, ...rest }) => ({ ...rest, name: `${rest.name} old` })), current: 0 };
    localStorage.setItem('sidkid.maker2.v1', JSON.stringify(saved));
  });
  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready());
  await sm.select('.track-head:nth-of-type(4) .track-instrument', await sm.evaluate(() => window.songMaker.instruments()[2].id));
  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready());
  await sm.reload();
  await sm.waitForFunction(() => window.songMaker?.ready());
  const stuck = await sm.evaluate(() => document.querySelectorAll('.track-instrument')[1].selectedOptions[0].text);
  report(stuck === 'Snare old', 'song keeps instrument picks across reloads', stuck);

  // Several songs: New adds one, Delete removes it, ⌘Z brings it back
  const songCount = () => sm.evaluate(() => document.getElementById('song-pick').options.length);
  const songsAtFirst = await songCount();
  await sm.click('#new-song');
  const songsAdded = await songCount();
  // A blank song plays on (the metronome to hear) until stopped
  await sm.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 1500));
  const blankPlays = await sm.evaluate(() => `${window.songMaker.playing()} ${window.songMaker.liveFrame()}`);
  await sm.keyboard.press(' ');
  report(/^true [\d.]+$/.test(blankPlays) && Number(blankPlays.split(' ')[1]) > 40, 'song blank plays on', blankPlays);
  await sm.click('#delete-song');
  await sm.evaluate(() => [...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Delete song').click());
  const songsRemoved = await songCount();
  await sm.keyboard.down('Meta');
  await sm.keyboard.press('z');
  await sm.keyboard.up('Meta');
  const songsRestored = await songCount();
  report(songsAdded === songsAtFirst + 1 && songsRemoved === songsAtFirst && songsRestored === songsAtFirst + 1, 'song list adds and deletes songs', `${songsAtFirst} → ${songsAdded} → ${songsRemoved} → ${songsRestored}`);

  // Importing an example: a new song, its instruments added to the Instrument Maker's, the song before left alone
  const earlierSong = await sm.evaluate(() => JSON.stringify(window.songMaker.song()));
  await sm.click('#import-song');
  await sm.waitForSelector('#import-songs li button:not([disabled])');
  await sm.click('#import-songs li button:not([disabled])');
  await sm.waitForFunction(() => window.songMaker.song().name === 'Everlasting Annoyance', { timeout: 30000 });
  const importedSong = await sm.evaluate((earlier) => {
    const saved = JSON.parse(localStorage.getItem('sidkid.maker2.v1')).instruments.map((i) => i.name);
    const pick = document.getElementById('song-pick');
    const songs = JSON.parse(localStorage.getItem('sidkid.song2.v1')).songs;
    return `${window.songMaker.song().tracks.length} tracks, ${saved.filter((n) => n.endsWith('(Everlasting Annoyance)')).length} instruments, earlier song ${JSON.stringify(songs[songs.length - 2]) === earlier ? 'kept' : 'changed'}, ${pick.options.length} songs`;
  }, earlierSong);
  report(/^9 tracks, 9 instruments, earlier song kept, \d+ songs$/.test(importedSong), 'song imports an example', importedSong);

  // Exported, the imported song plays in GoatTracker's own player as it plays here; Export downloads the file
  const reExported = await sm.evaluate(() => window.songMaker.exportCheck());
  const downloaded = await sm.evaluate(() => {
    let name = null;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      name = this.download;
    };
    document.getElementById('export-song').click();
    HTMLAnchorElement.prototype.click = click;
    return name;
  });
  report(!reExported.gaps.length && !Object.keys(reExported.differ).length && downloaded === 'Everlasting Annoyance.sng', 'song exports an imported song', `${JSON.stringify(reExported.differ)} ${downloaded}`);

  // Songs offered for import play exactly as GoatTracker's player does
  const importExact = await sm.evaluate(async () => {
    const index = await (await fetch('./examples/index.json')).json();
    const out = [];
    for (const ex of index.filter((e) => e.importable)) {
      const r = await window.songMaker.importCheck(ex.file);
      out.push(`${ex.file}: ${r.gaps.length || Object.keys(r.differ).length ? `${r.gaps.join(', ')} ${JSON.stringify(r.first)}` : 'same'}`);
    }
    return out;
  });
  report(importExact.length > 0 && importExact.every((e) => e.endsWith(': same')), 'song imports play as they did', importExact.join(' | '));

  await sm.screenshot({ path: `${OUT}/${BROWSER}-songs.png` });
  await colorScheme(sm, 'dark');
  await sm.screenshot({ path: `${OUT}/${BROWSER}-songs-dark.png` });
  await colorScheme(sm, 'light');
  await sm.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow3 = await sm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow3 <= 0, 'song maker fits a phone screen', overflow3 > 0 ? `${overflow3}px too wide` : '');
  report(smErrors.length === 0, 'song maker without errors', smErrors.join(' | '));
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
