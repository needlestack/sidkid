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
      { wave: 0x10, start: 60, end: null },
    ];
    s.instruments[s.current].bars = bars;
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

  await colorScheme(m2, 'dark');
  await m2.screenshot({ path: `${OUT}/${BROWSER}-maker2-dark.png` });
  await colorScheme(m2, 'light');
  await m2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow2 = await m2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow2 <= 0, 'maker2 fits a phone screen', overflow2 > 0 ? `${overflow2}px too wide` : '');
  report(m2Errors.length === 0, 'maker2 without errors', m2Errors.join(' | '));
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
