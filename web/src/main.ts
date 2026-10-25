import './style.css';
import { encodeWav, renderSong } from './engine/export';
import { MODEL_6581, Player } from './engine/player';
import { DEFAULT_SETTINGS, type Settings, type SongInfo, type Status } from './engine/protocol';
import * as sid from './sid';

interface Example {
  file: string;
  title: string;
  author: string;
  copyright: string;
  settings?: Partial<Settings>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const player = new Player();
let song: SongInfo | null = null;
let songBytes: ArrayBuffer | null = null;
let status: Status | null = null;
let muted = [false, false, false];
let settings: Settings = DEFAULT_SETTINGS;
let model = MODEL_6581;
const exampleList = new Map<string, Example>();

// --- voices -----------------------------------------------------------------

const voiceTemplate = $<HTMLTemplateElement>('voice-template');
const voices = [0, 1, 2].map((v) => {
  const el = (voiceTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  el.querySelector('h2')!.textContent = `Voice ${v + 1}`;
  el.querySelector('.mute')!.addEventListener('click', () => toggleMute(v));
  el.querySelector('.solo')!.addEventListener('click', () => toggleSolo(v));
  $('voices').append(el);
  return {
    el,
    note: el.querySelector('.note') as HTMLElement,
    gate: el.querySelector('.gate') as HTMLElement,
    waves: Array.from(el.querySelectorAll<HTMLElement>('[data-w]')),
    env: el.querySelector('.env') as HTMLElement,
    pw: el.querySelector('.pw') as HTMLElement,
    adsr: el.querySelector('.adsr') as HTMLElement,
    flags: el.querySelector('.flags') as HTMLElement,
    mute: el.querySelector('.mute') as HTMLElement,
    solo: el.querySelector('.solo') as HTMLElement,
  };
});

function setMuted(next: boolean[]) {
  muted = next;
  if (player.started) muted.forEach((m, c) => player.setMuted(c, m));
  renderMutes();
}

function toggleMute(v: number) {
  setMuted(muted.map((m, c) => (c === v ? !m : m)));
}

function toggleSolo(v: number) {
  const soloed = muted.every((m, c) => m === (c !== v));
  setMuted(soloed ? [false, false, false] : muted.map((_, c) => c !== v));
}

function renderMutes() {
  const soloed = muted.filter((m) => !m).length === 1;
  voices.forEach((ui, c) => {
    ui.el.classList.toggle('muted', muted[c]);
    ui.mute.classList.toggle('on', muted[c]);
    ui.solo.classList.toggle('on', soloed && !muted[c]);
  });
}

// --- song loading -------------------------------------------------------------

function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout((toast as { timer?: number }).timer);
  (toast as { timer?: number }).timer = window.setTimeout(() => el.classList.remove('show'), 4000);
}

player.onError = toast;

// Browsers only let audio start from a user gesture, before any await, so
// every handler that may need sound calls this first.
function startAudio(): Promise<boolean> {
  return player.start().then(
    () => true,
    (err) => {
      toast(`Could not start audio: ${err instanceof Error ? err.message : err}`);
      return false;
    },
  );
}

async function loadSong(audio: Promise<boolean>, bytes: ArrayBuffer, name: string, preset?: Partial<Settings>) {
  if (!(await audio)) return;
  const copy = bytes.slice(0); // load() transfers bytes to the worklet
  const info = await player.load(bytes);
  if (!info) {
    toast(`${name} is not a GoatTracker song`);
    return;
  }
  song = info;
  songBytes = copy;
  muted.forEach((m, c) => player.setMuted(c, m));
  applySettings(savedSettings() ?? { ...DEFAULT_SETTINGS, ...preset }, false);
  $('title').textContent = info.title || name;
  $('byline').textContent = [info.author, info.copyright].filter(Boolean).join(' · ') || name;
  const subsong = $<HTMLSelectElement>('subsong');
  subsong.replaceChildren(
    ...Array.from({ length: Math.max(info.subsongs, 1) }, (_, i) => new Option(`${i + 1} of ${Math.max(info.subsongs, 1)}`, String(i))),
  );
  subsong.disabled = info.subsongs < 2;
  $<HTMLButtonElement>('play').disabled = false;
  $<HTMLButtonElement>('export').disabled = false;
  player.play(0);
  if (!player.running) toast('Press Play to start the sound');
}

$('open').addEventListener('click', () => {
  void startAudio();
  $<HTMLInputElement>('file').click();
});
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const audio = startAudio();
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await loadSong(audio, await file.arrayBuffer(), file.name);
  (e.target as HTMLInputElement).value = '';
});

const examples = $<HTMLSelectElement>('examples');
fetch(`${import.meta.env.BASE_URL}examples/index.json`)
  .then((r) => r.json() as Promise<Example[]>)
  .then((list) => {
    for (const ex of list) {
      exampleList.set(ex.file, ex);
      examples.append(new Option(ex.author ? `${ex.title} — ${ex.author}` : ex.title, ex.file));
    }
  })
  .catch(() => toast('Could not load the example list'));

examples.addEventListener('change', async () => {
  const file = examples.value;
  if (!file) return;
  const audio = startAudio();
  const response = await fetch(`${import.meta.env.BASE_URL}examples/${file}`);
  await loadSong(audio, await response.arrayBuffer(), file, exampleList.get(file)?.settings);
});

// Drag and drop anywhere on the page
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $('drop').classList.add('show');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth === 0) $('drop').classList.remove('show');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('show');
  const file = e.dataTransfer?.files[0];
  if (file) await loadSong(startAudio(), await file.arrayBuffer(), file.name);
});

// --- transport ----------------------------------------------------------------

function togglePlay() {
  if (!song) return;
  void startAudio();
  if (status?.playing) player.stop();
  else player.play(Number($<HTMLSelectElement>('subsong').value) || 0);
}

$('play').addEventListener('click', togglePlay);
$<HTMLSelectElement>('subsong').addEventListener('change', (e) => {
  player.play(Number((e.target as HTMLSelectElement).value));
});

$('model').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-model]');
  if (!button) return;
  model = Number(button.dataset.model);
  player.setModel(model);
  for (const b of $('model').querySelectorAll('button')) b.classList.toggle('on', b === button);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (/^Digit[123]$/.test(e.code)) {
    const v = Number(e.code.slice(5)) - 1;
    if (e.shiftKey) toggleSolo(v);
    else toggleMute(v);
  }
});

// --- playback settings ----------------------------------------------------------

// Settings are not part of .sng files, so remember them per song
function settingsKey(): string | null {
  return song ? `sidkid:settings:${song.title}|${song.author}` : null;
}

function savedSettings(): Settings | null {
  const key = settingsKey();
  try {
    const saved = key && localStorage.getItem(key);
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : null;
  } catch {
    return null;
  }
}

/** Applies settings; when they change during playback, restarts the song so speed and timing take effect. */
function applySettings(next: Settings, save = true) {
  const restart = status?.playing && (next.multiplier !== settings.multiplier || next.ntsc !== settings.ntsc);
  settings = next;
  player.setSettings(settings);
  if (restart) player.play(Number($<HTMLSelectElement>('subsong').value) || 0);
  const key = settingsKey();
  if (save && key) {
    try {
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // Private mode etc.: settings just aren't remembered
    }
  }
  renderSettings();
}

function renderSettings() {
  for (const b of $('speed').querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', Number(b.dataset.speed) === settings.multiplier);
  for (const b of $('timing').querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', (b.dataset.ntsc === '1') === settings.ntsc);
  const hr = $<HTMLInputElement>('hardrestart');
  if (document.activeElement !== hr) hr.value = settings.hardRestart.toString(16).toUpperCase().padStart(4, '0');
  hr.classList.remove('invalid');
  $<HTMLInputElement>('pulseopt').checked = settings.pulseOptimization;
  $<HTMLInputElement>('realtimeopt').checked = settings.realtimeOptimization;
}

$('speed').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-speed]');
  if (b) applySettings({ ...settings, multiplier: Number(b.dataset.speed) });
});
$('timing').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ntsc]');
  if (b) applySettings({ ...settings, ntsc: b.dataset.ntsc === '1' });
});
$<HTMLInputElement>('hardrestart').addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  if (/^[0-9a-f]{4}$/i.test(input.value)) applySettings({ ...settings, hardRestart: parseInt(input.value, 16) });
  else input.classList.add('invalid');
});
$<HTMLInputElement>('hardrestart').addEventListener('blur', renderSettings);
$<HTMLInputElement>('pulseopt').addEventListener('change', (e) => {
  applySettings({ ...settings, pulseOptimization: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('realtimeopt').addEventListener('change', (e) => {
  applySettings({ ...settings, realtimeOptimization: (e.target as HTMLInputElement).checked });
});

// --- WAV export -------------------------------------------------------------------

function formatTime(seconds: number) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

$('export').addEventListener('click', async () => {
  if (!song || !songBytes) return;
  const button = $<HTMLButtonElement>('export');
  button.disabled = true;
  button.textContent = 'Exporting…';
  try {
    const rendered = await renderSong({
      song: songBytes.slice(0),
      settings,
      model,
      subsong: Number($<HTMLSelectElement>('subsong').value) || 0,
      muted,
      onProgress: (seconds) => (button.textContent = `Exporting ${formatTime(seconds)}…`),
    });
    const url = URL.createObjectURL(encodeWav(rendered.samples, rendered.sampleRate));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(song.title || 'song').replace(/[\\/:*?"<>|]+/g, '_')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const length = formatTime(rendered.samples.length / rendered.sampleRate);
    toast(rendered.looped ? `Exported ${length}: one pass plus a fade-out` : `Exported ${length}; the song didn't loop within 10 minutes`);
  } catch (err) {
    toast(`Export failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Export WAV';
  }
});

// --- display --------------------------------------------------------------------

player.onStatus = (s) => {
  status = s;
};

function hex(n: number) {
  return n.toString(16).toUpperCase();
}

function render() {
  requestAnimationFrame(render);
  if (!status) return;
  const { regs, envelopes, playing, frames } = status;

  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Stop' : 'Play');
  const framesPerSecond = (settings.ntsc ? 60 : 50) * (settings.multiplier || 0.5);
  $('time').textContent = formatTime(frames / framesPerSecond);

  voices.forEach((ui, v) => {
    const st = sid.voice(regs, v, settings.ntsc ? sid.NTSC_CLOCK : sid.PAL_CLOCK);
    ui.note.textContent = st.note || '—';
    ui.gate.classList.toggle('on', st.gate);
    for (const chip of ui.waves) chip.classList.toggle('on', st[chip.dataset.w as 'triangle' | 'sawtooth' | 'pulse' | 'noise']);
    ui.env.style.width = `${(envelopes[v] / 255) * 100}%`;
    ui.pw.style.width = `${st.pulseWidth * 100}%`;
    ui.pw.parentElement!.classList.toggle('dim', !st.pulse);
    ui.adsr.textContent = `ADSR ${hex(st.attack)}${hex(st.decay)}${hex(st.sustain)}${hex(st.release)}`;
    ui.flags.textContent = [st.filtered && 'Filter', st.ring && 'Ring', st.sync && 'Sync'].filter(Boolean).join(' · ');
  });

  const f = sid.filter(regs);
  for (const chip of $('filter').querySelectorAll<HTMLElement>('[data-f]')) {
    chip.classList.toggle('on', f[chip.dataset.f as 'lowpass' | 'bandpass' | 'highpass']);
  }
  $('cutoff').style.width = `${(f.cutoff / 2047) * 100}%`;
  $('resonance').style.width = `${(f.resonance / 15) * 100}%`;
  $('volume').style.width = `${(f.volume / 15) * 100}%`;
}

const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined;
if (sourceUrl) $('source-link').innerHTML = ` · <a href="${sourceUrl}">Source code</a>`;

renderMutes();
renderSettings();
requestAnimationFrame(render);
