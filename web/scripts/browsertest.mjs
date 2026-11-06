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
    // A gap between chunks isn't filtered
    ins.filter = { ...ins.filter, cutoff: { points: [{ t: 0, w: 0x80 }], loop: null }, types: [{ start: 0, end: 5, passband: 0x10 }] };
    const gap = window.maker2.trace(10).routing[6] & 1;
    // A chunk ending on the repeat's end stays on all the way round (its last frame too)
    ins.filter = { ...ins.filter, cutoff: { points: [{ t: 0, w: 0x80 }, { t: 5, w: 0x40 }, { t: 15, w: 0xc0 }], loop: 1 }, types: [{ start: 0, end: 15, passband: 0x10 }] };
    const round = window.maker2.trace(60).routing.slice(0, 60).every((r) => r & 1);
    ins.filter = was;
    if (gap) return 'still filtered after its chunk';
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

  // A note starts on its frame: step 4 at 6 frames a step is frame 24 (the gate goes off two frames before, for the hard restart)
  const onTime = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks.forEach((t) => (t.clips = []));
    s.tracks[0].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 4, length: 4, note: 48 }] }];
    window.songMaker.render();
    return window.songMaker.trace(60);
  });
  const onRuns = voiceRuns(onTime, 0);
  report(onRuns === '0:0x23 0:1x1 1168:1x24 1168:0x12', 'song notes play on their frames', onRuns);

  // Two tracks on one voice take turns: the newer note takes it, and the held one comes back after
  const turns = await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks[1].voice = 0;
    s.tracks[1].clips = [{ start: 0, length: 16, span: 16, notes: [{ start: 0, length: 16, note: 31 }] }];
    window.songMaker.render();
    return window.songMaker.trace(100);
  });
  const turnRuns = voiceRuns(turns, 0);
  report(turnRuns === '685:1x21 685:0x2 685:1x1 1168:1x21 1168:0x2 1168:1x1 685:1x48 685:0x4', 'song tracks on one voice take turns', turnRuns);

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
  report(clicks === '-36,60 / -84,-60,-12,12,36,84,108,132 / 96', 'song metronome and count-in', clicks);

  // Double-click in a lane makes a clip; double-click in the editor adds a note
  await sm.evaluate(() => {
    const s = window.songMaker.song();
    s.tracks.forEach((t) => (t.clips = []));
    window.songMaker.render();
  });
  const arrBox = await sm.$eval('#arr', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.click(arrBox.x + 6 * 16 + 30, arrBox.y + 32 + 56 + 28, { count: 2 });
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
  const cursors = await sm.evaluate(() => ['.roll-note-end', '.roll-note', '.arr-cycle-end', '.arr-cycle', '.clip2-edge'].map((q) => getComputedStyle(document.querySelector(q)).cursor).join(' '));
  await sm.mouse.move(nb.x + 2, nb.y + 4);
  await sm.mouse.down();
  await sm.mouse.move(nb.x + 2 - 22, nb.y + 4, { steps: 3 });
  const during = await sm.evaluate(() => getComputedStyle(document.body).cursor);
  await sm.mouse.up();
  const stretched = await sm.evaluate(() => JSON.stringify(window.songMaker.openClip().notes.map((n) => [n.start, n.length])));
  report(stretched === '[[3,3]]' && cursors === 'ew-resize grab ew-resize grab ew-resize' && during === 'ew-resize', 'song note ends and cursors', `${stretched} ${cursors} / ${during}`);

  // The editor's ruler numbers the song's bars (this clip starts on bar 2)
  const rollBars = await sm.evaluate(() => [...document.querySelectorAll('#roll-ruler text')].map((t) => t.textContent).join(' '));
  report(rollBars.startsWith('2 2.2 2.3 2.4 3'), 'song editor shows bars', rollBars.slice(0, 40));

  // The clip's upper right edge repeats it
  const clipBox = await sm.$eval('.clip2-body', (e) => e.getBoundingClientRect().toJSON());
  await sm.mouse.move(clipBox.right - 5, clipBox.y + 8);
  await sm.mouse.down();
  await sm.mouse.move(clipBox.right - 5 + 96, clipBox.y + 8, { steps: 6 });
  await sm.mouse.up();
  const repeated = await sm.evaluate(() => JSON.stringify(window.songMaker.song().tracks[1].clips.map((c) => [c.start, c.length, c.span])));
  report(repeated === '[[16,16,32]]', 'song clip repeats', repeated);

  // Recording: R plays, a held key becomes a note on the selected track (no count-in here)
  await sm.click('#count-in');
  await sm.mouse.click(arrBox.x - 100, arrBox.y + 32 + 20);
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
