// The second instrument maker: an instrument shaped on a timeline rather
// than written as program steps. Each tab draws one side of the sound
// against the same time axis: the volume envelope with handles to drag, and
// the waveform as bars in rows, moved and resized like clips.

import './style.css';
import './instrumentmaker.css';
import './maker2.css';
import { Analyzer, type Trace } from './engine/analyzer';
import type { TableData } from './engine/configure';
import { loadModel, Player, saveModel } from './engine/player';
import { DEFAULT_SETTINGS, type Status } from './engine/protocol';
import { ATTACK_MS, DECAY_MS } from './adsr';
import { envelope } from './envelope';
import { noteName, type Instrument } from './song';
import { layOut, waveName, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI } from './tables';
import { waveIcon } from './waveicon';
import { LANES, place, pulseProgram, spans, storable, waveProgram, type Bar, type Shape } from './shape';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';
const FPS = 50;
const STORAGE_KEY = 'sidkid.maker2.v1';
const TEST_INSTRUMENT = 1;
/** The timeline's length: 15 seconds */
const TOTAL = 750;
const MAX_ZOOM = 24;
const RULER = 24;
const PLOT = 232;
const HEIGHT = RULER + PLOT;
/** In the waveform tab, the strip above the rows showing what is heard */
const HEARD = 24;
const LANE_H = (PLOT - HEARD) / LANES.length;
/** Room above full volume and below silence for the dots' labels */
const PAD_TOP = 24;
const PAD_BOTTOM = 32;
/** Pixels from a bar's end that grab the end rather than the bar */
const EDGE = 7;
/** Half the sustain capsule's width, in pixels */
const CAPSULE_HALF = 14;
/**
 * Across a gap at least this many pixels wide, a dragged dot moves to the
 * next setting once it is this far from the one it came from (rather than
 * halfway), so a long way between settings still answers the pointer.
 */
const STEP_GAP = 40;

type Tab = 'volume' | 'wave';

interface State {
  instruments: Shape[];
  current: number;
  tab: Tab;
  /** Pixels per frame */
  zoom: number;
  /** When the key goes up in the picture and when Play lets go, in frames */
  keyUp: number;
}

function defaults(): State {
  return {
    instruments: [
      { name: 'Lead', ad: 0x09, sr: 0xa9, bars: [{ wave: WAVE_PULSE, start: 0, end: null }] },
      {
        name: 'Bass',
        ad: 0x08,
        sr: 0x88,
        bars: [
          { wave: WAVE_PULSE, start: 0, end: 3 },
          { wave: WAVE_SAW, start: 3, end: null },
        ],
      },
      {
        name: 'Snare',
        ad: 0x08,
        sr: 0x00,
        bars: [
          { wave: WAVE_NOISE, start: 0, end: 1 },
          { wave: WAVE_PULSE, start: 1, end: 3 },
          { wave: WAVE_NOISE, start: 3, end: null },
        ],
      },
    ],
    current: 0,
    tab: 'volume',
    zoom: 0,
    keyUp: 50,
  };
}

let state: State = load();
const test = { octave: 3, note: 48 };
const shape = () => state.instruments[state.current];

function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.instruments?.length) return { ...defaults(), ...saved };
  } catch {
    // Unreadable or blocked storage: start afresh
  }
  return defaults();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be full or blocked; the page still works
  }
}

// --- Undo -------------------------------------------------------------------

const undoStack: string[] = [];
const redoStack: string[] = [];
const snapshot = () => JSON.stringify({ instruments: state.instruments, current: state.current });

/** Call before a change, once per drag or edit. */
function before() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function undo(redo = false) {
  const from = redo ? redoStack : undoStack;
  const to = redo ? undoStack : redoStack;
  const s = from.pop();
  if (!s) return;
  to.push(snapshot());
  Object.assign(state, JSON.parse(s));
  selected = -1;
  changed();
  renderInstruments();
}

/** After any change to the instrument: redraws, saves and updates the player. */
function changed() {
  persist();
  render();
  sendToPlayer();
}

// --- For the player -----------------------------------------------------------

interface Audition {
  tables: TableData[];
  instrument: Instrument;
}

function audition(): Audition {
  const s = shape();
  const wave = waveProgram(s.bars, s.name);
  const pulse = pulseProgram(s.bars, s.name);
  const empty = { left: new Uint8Array(0), right: new Uint8Array(0) };
  return {
    tables: [layOut([wave]).table, pulse ? layOut([pulse]).table : empty, empty, empty],
    instrument: { name: s.name, ad: s.ad, sr: s.sr, tables: [1, pulse ? 1 : 0, 0, 0], vibratoDelay: 0, gateTimer: 2, firstWave: 0x09 },
  };
}

let analyzer: Analyzer | null = null;

/** What the player writes to the chip for a held note, frame by frame (for tests). */
function trace(frames = 100): Trace | null {
  if (!analyzer) return null;
  const a = audition();
  return analyzer.trace(a.tables, a.instrument, test.note, frames, DEFAULT_SETTINGS);
}

// --- Volume ---------------------------------------------------------------------

const ENV_STEPS = 4;
const simCache = new Map<string, Float32Array>();

/** The envelope level, ENV_STEPS samples a frame, with the key going up at keyUp. */
function level(ad: number, sr: number, keyUp: number, frames = TOTAL): Float32Array {
  const key = `${ad},${sr},${keyUp},${frames}`;
  let out = simCache.get(key);
  if (!out) {
    out = envelope(ad, sr, Array.from({ length: frames }, (_, f) => f < keyUp), ENV_STEPS);
    if (simCache.size > 400) simCache.clear();
    simCache.set(key, out);
  }
  return out;
}

/** The frame (fractional) a level first meets a test after `from`, or null. */
function firstFrame(curve: Float32Array, from: number, meets: (v: number) => boolean): number | null {
  for (let i = Math.max(0, Math.floor(from * ENV_STEPS)); i < curve.length; i++) if (meets(curve[i])) return i / ENV_STEPS;
  return null;
}

const attackFrames = (a: number) => ATTACK_MS[a] / 1000 * FPS;

/** Where the decay reaches the sustain level, with the key held. */
function decayEnd(a: number, d: number, s: number): number {
  const top = attackFrames(a);
  // At full sustain there is no fall: the handle sits a little along the top
  if (s === 15) return top + (DECAY_MS[d] / 1000) * FPS * 0.1;
  const frames = Math.ceil(top + (DECAY_MS[d] / 1000) * FPS) + 4;
  const curve = level((a << 4) | d, s << 4, frames + 1, frames);
  // From the top of the attack: decay starts as soon as it gets there
  let peak = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] > curve[peak]) peak = i;
  return firstFrame(curve, peak / ENV_STEPS, (v) => v <= (s * 17 + 0.5) / 255) ?? frames;
}

/** Where the sound has died away after the key goes up. */
function releaseEnd(ad: number, sr: number, keyUp: number): number {
  const frames = Math.min(2000, Math.ceil(keyUp + (DECAY_MS[sr & 15] / 1000) * FPS) + 4);
  const curve = level(ad, sr, keyUp, frames);
  return firstFrame(curve, keyUp, (v) => v < 0.01) ?? frames;
}

function timeText(frames: number): string {
  const s = frames / FPS;
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  return `${Math.round(s * 100) / 100} s`;
}

const envText = {
  a: (v: number) => `Attack ${timeText(attackFrames(v))}`,
  d: (v: number) => `Decay ${timeText((DECAY_MS[v] / 1000) * FPS)}`,
  s: (v: number) => `Sustain ${Math.round((v / 15) * 100)}%`,
  r: (v: number) => `Release ${timeText((DECAY_MS[v] / 1000) * FPS)}`,
};

// --- Drawing --------------------------------------------------------------------

const plot = $('plot') as unknown as SVGSVGElement;
const scroller = $('scroll');
let selected = -1;
/** What is being dragged, for its look and the readout */
let dragging: string | null = null;
/** While an envelope handle is dragged it follows the pointer, and the setting it will land on is drawn */
let free: { key: string; f: number; v: number } | null = null;
/** The setting (0-15) the dragged handle had when grabbed */
let origin = 0;
/** Frames from the key going up to where the sustain capsule was grabbed, so it doesn't jump */
let grabOffset = 0;
let playhead = -1;
/** Kept from one drawing to the next and moved on its own, so playing doesn't redraw what is under the pointer */
const playheadLine = el('line', { y1: 0, y2: HEIGHT, class: 'tl-playhead' });

function movePlayhead() {
  playheadLine.style.display = playhead >= 0 ? '' : 'none';
  playheadLine.setAttribute('x1', String(x(playhead)));
  playheadLine.setAttribute('x2', String(x(playhead)));
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** Room left of time 0, so handles there can be grabbed */
const ORIGIN = 16;
const x = (f: number) => ORIGIN + f * state.zoom;
const LEVEL_H = PLOT - PAD_TOP - PAD_BOTTOM;
const plotY = (v: number) => RULER + PAD_TOP + (1 - v) * LEVEL_H;
const laneTop = (i: number) => RULER + HEARD + i * LANE_H;

function minZoom() {
  return Math.max(0.5, (scroller.clientWidth - 2 * ORIGIN) / TOTAL);
}

function setZoom(z: number, around = scroller.clientWidth / 2) {
  const frame = (scroller.scrollLeft + around - ORIGIN) / state.zoom;
  state.zoom = Math.max(minZoom(), Math.min(MAX_ZOOM, z));
  render();
  scroller.scrollLeft = x(frame) - around;
  persist();
}

/** Ruler ticks: a step in frames that leaves room for the labels. */
function tickStep(): number {
  return [1, 2, 5, 10, 25, 50, 100, 250, 500].find((s) => s * state.zoom >= 56) ?? 500;
}

function render() {
  if (!state.zoom) state.zoom = Math.max(minZoom(), scroller.clientWidth / 100);
  const s = shape();
  $<HTMLInputElement>('name').value = document.activeElement === $('name') ? $<HTMLInputElement>('name').value : s.name;
  for (const b of $('tabs').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.tab === state.tab);
  $('zoom-label').textContent = `${timeText(scroller.clientWidth / state.zoom)} shown`;
  if (document.activeElement !== zoomSlider) zoomSlider.value = String(sliderValue());
  $('tab-hint').textContent =
    state.tab === 'volume'
      ? 'Drag the dots: how fast it rises, falls to the level it holds, and fades once the key goes up. Drag “key up” to hold the note longer.'
      : 'Drag along a row to draw a waveform; drag bars to move them, or their ends to resize. Bars that overlap play together.';

  const width = x(TOTAL) + ORIGIN;
  plot.setAttribute('width', String(width));
  plot.setAttribute('height', String(HEIGHT));
  plot.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  plot.replaceChildren();
  plot.dataset.tab = state.tab;

  // Ruler and grid
  const step = tickStep();
  el('rect', { x: 0, y: 0, width, height: RULER, class: 'tl-ruler' }, plot);
  for (let f = 0; f <= TOTAL; f += step) {
    el('line', { x1: x(f), x2: x(f), y1: RULER, y2: HEIGHT, class: f % 50 === 0 ? 'tl-grid second' : 'tl-grid' }, plot);
    el('line', { x1: x(f), x2: x(f), y1: RULER - 6, y2: RULER, class: 'tl-tick' }, plot);
    const label = el('text', { x: x(f) + 3, y: RULER - 9, class: 'tl-label' }, plot);
    label.textContent = f === 0 ? '0' : `${Math.round((f / FPS) * 100) / 100} s`;
  }

  const curve = level(s.ad, s.sr, state.keyUp);
  if (state.tab === 'volume') drawVolume(curve);
  else drawWaves(curve);

  // The key going up, with a tab on the ruler to drag it by
  const ku = x(state.keyUp);
  el('line', { x1: ku, x2: ku, y1: RULER, y2: HEIGHT, class: 'tl-keyup' }, plot);
  const tab = el('g', { class: `tl-keyup-tab${dragging === 'keyup' ? ' dragging' : ''}`, 'data-drag': 'keyup', tabindex: 0, role: 'slider', 'aria-label': `Key up at ${timeText(state.keyUp)}` }, plot);
  el('rect', { x: ku - 30, y: 3, width: 60, height: RULER - 6, rx: 6 }, tab);
  el('text', { x: ku, y: RULER / 2 + 4, 'text-anchor': 'middle' }, tab).textContent = 'key up';

  plot.append(playheadLine);
  movePlayhead();

  renderGutter();
  renderReadout();
}

function renderGutter() {
  const g = $('gutter');
  g.replaceChildren();
  g.style.height = `${HEIGHT}px`;
  const add = (top: number, height: number, content: (string | Node)[], cls = '') => {
    const d = document.createElement('div');
    d.className = `tl-gutter-row ${cls}`;
    d.style.top = `${top}px`;
    d.style.height = `${height}px`;
    d.append(...content);
    g.append(d);
  };
  if (state.tab === 'volume') {
    add(plotY(1) - 8, 16, ['Full']);
    add(plotY(0.5) - 8, 16, ['Half']);
    add(plotY(0) - 8, 16, ['Silent']);
  } else {
    add(RULER, HEARD, ['You hear'], 'heard');
    LANES.forEach((w, i) => add(laneTop(i), LANE_H, [waveIcon(w, 26, 14), waveName(w)], 'lane'));
  }
}

function areaPath(curve: Float32Array, from: number, to: number): string {
  const pts: string[] = [];
  const last = Math.min(curve.length - 1, Math.round(to * ENV_STEPS));
  for (let i = Math.round(from * ENV_STEPS); i <= last; i++) pts.push(`${x(i / ENV_STEPS).toFixed(1)},${plotY(curve[i]).toFixed(1)}`);
  return pts.length ? `M${pts.join('L')}` : '';
}

function drawVolume(curve: Float32Array) {
  const s = shape();
  const [a, d, sus] = [s.ad >> 4, s.ad & 15, s.sr >> 4];
  const end = releaseEnd(s.ad, s.sr, state.keyUp);
  const line = areaPath(curve, 0, Math.min(TOTAL, end + 2));
  el('path', { d: `${line}L${x(Math.min(TOTAL, end + 2))},${plotY(0)}L${x(0)},${plotY(0)}Z`, class: 'env-area' }, plot);
  // The whole decay, faintly: how it would fall all the way to silence with
  // the key held, past the sustain level and the key going up. Its length
  // is the decay setting.
  const whole = level(s.ad, s.sr & 0x0f, TOTAL);
  const top = attackFrames(a);
  const silent = firstFrame(whole, top + 1, (v) => v < 0.01) ?? TOTAL;
  el('path', { d: areaPath(whole, top, Math.min(TOTAL, silent)), class: 'env-held' }, plot);
  el('path', { d: line, class: 'env-line' }, plot);

  // Labels are centred over (or under) their dot, kept inside the timeline
  const text = (parent: Element, cx: number, y: number, content: string, cls = '') => {
    const half = content.length * 3.3 + 2;
    const t = el('text', { x: Math.max(half, Math.min(x(TOTAL) + ORIGIN - half, cx)), y, 'text-anchor': 'middle', class: cls }, parent);
    t.textContent = content;
  };
  const above = (v: number) => plotY(v) - 12;
  const below = (v: number) => plotY(v) + 21;
  // Attack, decay and release are times: dots that move sideways, labelled
  // above. Sustain is a level: a capsule on its line that moves up and down,
  // labelled below.
  for (const key of ['a', 'd', 'r', 's']) {
    const p = handlePos(key, s.ad, s.sr);
    const label = handleText(key, s.ad, s.sr);
    const held = free?.key === key;
    const upDown = key === 's';
    const g = el('g', { class: `env-handle${held ? ' held' : ''}`, 'data-drag': key, tabindex: 0, role: 'slider', 'aria-label': label }, plot);
    if (upDown) {
      el('rect', { x: x(p.f) - 22, y: plotY(p.v) - 11, width: 44, height: 22, class: 'hit' }, g);
      capsule(g, x(p.f), plotY(p.v));
    } else {
      el('circle', { cx: x(p.f), cy: plotY(p.v), r: 13, class: 'hit' }, g);
      el('circle', { cx: x(p.f), cy: plotY(p.v), r: 6, class: 'dot' }, g);
    }
    if (!held) arrows(g, x(p.f), plotY(p.v), upDown ? 'all' : 'side');
    // Under the capsule, clear of its down arrow
    text(g, x(p.f), upDown ? below(p.v) + 7 : above(p.v), label);
    // The one in hand stays selected under the pointer, with the ways it moves
    if (held) {
      const grip = el('g', { class: 'env-grip' }, plot);
      if (upDown) capsule(grip, x(free!.f), plotY(free!.v));
      else el('circle', { cx: x(free!.f), cy: plotY(free!.v), r: 6, class: 'dot' }, grip);
      arrows(grip, x(free!.f), plotY(free!.v), upDown ? 'all' : 'side');
    }
  }
}

function capsule(parent: Element, cx: number, cy: number) {
  el('rect', { x: cx - CAPSULE_HALF, y: cy - 5, width: CAPSULE_HALF * 2, height: 10, rx: 5, class: 'dot' }, parent);
}

/** Little arrows round a handle for the ways it moves: sideways, or all four ways for the capsule. */
function arrows(parent: Element, cx: number, cy: number, ways: 'side' | 'all') {
  const g = el('g', { class: 'env-arrows' }, parent);
  const at = (dx: number, dy: number, out: number) => {
    // A small triangle pointing away from the handle
    const tip = [cx + dx * (out + 6), cy + dy * (out + 6)];
    const base = [cx + dx * out, cy + dy * out];
    const side = [dy * 4, dx * 4];
    el('path', { d: `M${tip[0]},${tip[1]}L${base[0] + side[0]},${base[1] + side[1]}L${base[0] - side[0]},${base[1] - side[1]}Z` }, g);
  };
  if (ways === 'all') {
    at(0, -1, 9);
    at(0, 1, 9);
    at(-1, 0, CAPSULE_HALF + 5);
    at(1, 0, CAPSULE_HALF + 5);
  } else {
    at(-1, 0, 13);
    at(1, 0, 13);
  }
}

/** Where an envelope handle sits for some settings. */
function handlePos(key: string, ad: number, sr: number): { f: number; v: number } {
  const [a, d, sus] = [ad >> 4, ad & 15, sr >> 4];
  if (key === 'a') return { f: attackFrames(a), v: 1 };
  if (key === 'd') return { f: decayEnd(a, d, sus), v: sus / 15 };
  // At the level held, ending where the key goes up
  if (key === 's') return { f: state.keyUp - CAPSULE_HALF / state.zoom, v: sus / 15 };
  return { f: releaseEnd(ad, sr, state.keyUp), v: 0 };
}

function handleText(key: string, ad: number, sr: number): string {
  if (key === 'a') return envText.a(ad >> 4);
  if (key === 'd') return envText.d(ad & 15);
  if (key === 's') return `${envText.s(sr >> 4)} · key up at ${timeText(state.keyUp)}`;
  return envText.r(sr & 15);
}

const LANE_COLORS: Record<number, string> = { [WAVE_TRI]: 'tri', [WAVE_SAW]: 'saw', [WAVE_PULSE]: 'pulse', [WAVE_NOISE]: 'noise' };

function drawWaves(curve: Float32Array) {
  const s = shape();
  // The volume, faintly, so the waveform can be placed against it
  const ghost = areaPath(curve, 0, TOTAL);
  const gy = (v: number) => RULER + HEARD + (1 - v) * (PLOT - HEARD);
  const pts: string[] = [];
  for (let i = 0; i < curve.length; i += 2) pts.push(`${x(i / ENV_STEPS).toFixed(1)},${gy(curve[i]).toFixed(1)}`);
  if (ghost) el('path', { d: `M${pts.join('L')}L${x(TOTAL)},${gy(0)}L${x(0)},${gy(0)}Z`, class: 'env-ghost' }, plot);

  LANES.forEach((_, i) => el('line', { x1: 0, x2: x(TOTAL), y1: laneTop(i), y2: laneTop(i), class: 'lane-line' }, plot));

  // What is heard: the waveform each stretch of time adds up to
  for (const sp of spans(s.bars)) {
    const x1 = x(sp.start);
    const x2 = x(sp.end ?? TOTAL);
    const g = el('g', { class: `heard${sp.wave ? '' : ' none'}` }, plot);
    el('rect', { x: x1 + 1, y: RULER + 4, width: Math.max(1, x2 - x1 - 2), height: HEARD - 8, rx: 4 }, g);
    const t = el('text', { x: x1 + 6, y: RULER + HEARD / 2 + 4 }, g);
    if (x2 - x1 > 60) t.textContent = sp.wave ? waveName(sp.wave) : 'Silent';
  }

  s.bars.forEach((b, i) => {
    const lane = LANES.indexOf(b.wave);
    const x1 = x(b.start);
    const x2 = x(b.end ?? TOTAL);
    const y = laneTop(lane) + 5;
    const h = LANE_H - 10;
    const g = el('g', { class: `bar ${LANE_COLORS[b.wave]}${i === selected ? ' selected' : ''}${b.end === null ? ' open' : ''}`, 'data-bar': i }, plot);
    el('rect', { x: x1, y, width: Math.max(2, x2 - x1), height: h, rx: 5, class: 'bar-body' }, g);
    if (b.end === null) {
      // It keeps going: an arrow at the far end
      el('path', { d: `M${x2 - 14},${y + h / 2 - 5}l6,5l-6,5`, class: 'bar-arrow' }, g);
    }
    if (x2 - x1 > 44) {
      const t = el('text', { x: x1 + 8, y: y + h / 2 + 4, class: 'bar-label' }, g);
      t.textContent = b.end === null ? `${waveName(b.wave)} on` : timeText(b.end - b.start);
    }
    el('rect', { x: x1 - 2, y, width: Math.min(EDGE, (x2 - x1) / 3) + 2, height: h, class: 'bar-edge', 'data-edge': 'start' }, g);
    if (b.end !== null) el('rect', { x: x2 - Math.min(EDGE, (x2 - x1) / 3), y, width: Math.min(EDGE, (x2 - x1) / 3) + 2, height: h, class: 'bar-edge', 'data-edge': 'end' }, g);
  });
}

function renderReadout() {
  const box = $('readout');
  box.replaceChildren();
  const s = shape();
  if (state.tab === 'volume') {
    const parts = [envText.a(s.ad >> 4), envText.d(s.ad & 15), envText.s(s.sr >> 4), envText.r(s.sr & 15), `key up after ${timeText(state.keyUp)}`];
    box.textContent = parts.join(' · ');
    return;
  }
  const b = s.bars[selected];
  if (!b) {
    box.textContent = s.bars.length ? 'Click a bar to change it.' : 'No waveform yet: the note is silent. Drag along a row to draw one.';
    return;
  }
  const text = document.createElement('span');
  text.textContent = `${waveName(b.wave)} from ${timeText(b.start)}${b.end === null ? ', until the note ends' : ` for ${timeText(b.end - b.start)}`}`;
  const keep = document.createElement('label');
  keep.className = 'check';
  const box2 = document.createElement('input');
  box2.type = 'checkbox';
  box2.checked = b.end === null;
  box2.addEventListener('change', () => {
    before();
    const later = s.bars.filter((o) => o.wave === b.wave && o.start > b.start);
    const bar: Bar = { ...b, end: box2.checked ? null : Math.min(TOTAL, Math.max(b.start + 1, state.keyUp)) };
    s.bars = commit(s.bars.filter((o) => !box2.checked || !later.includes(o)), b, bar);
    changed();
  });
  keep.append(box2, ' Keeps going until the note ends');
  const del = document.createElement('button');
  del.className = 'mini danger';
  del.textContent = 'Delete';
  del.addEventListener('click', deleteSelected);
  box.append(text, keep, del);
}

/** Replaces a bar with another, overwriting what it lands on, and selects it. */
function commit(bars: Bar[], old: Bar | null, bar: Bar): Bar[] {
  const out = place(
    bars.filter((o) => o !== old),
    bar,
  );
  selected = out.indexOf(bar);
  return out;
}

function deleteSelected() {
  const s = shape();
  if (!s.bars[selected]) return;
  before();
  s.bars.splice(selected, 1);
  selected = -1;
  changed();
}

// --- Dragging -------------------------------------------------------------------

/** The frame under the pointer, unrounded. */
function frameAt(e: PointerEvent): number {
  return (e.clientX - plot.getBoundingClientRect().left - ORIGIN) / state.zoom;
}

function yAt(e: PointerEvent): number {
  return e.clientY - plot.getBoundingClientRect().top;
}

function laneAt(e: PointerEvent): number {
  return Math.max(0, Math.min(LANES.length - 1, Math.floor((yAt(e) - RULER - HEARD) / LANE_H)));
}

plot.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const target = e.target as Element;
  const handle = target.closest<SVGGElement>('[data-drag]');
  const barEl = target.closest<SVGGElement>('[data-bar]');
  const s = shape();
  const start = frameAt(e);
  const [downX, downY] = [e.clientX, e.clientY];
  const marks = undoStack.length;
  let move: ((e: PointerEvent) => void) | null = null;
  let moved = false;

  if (handle) {
    const key = handle.dataset.drag!;
    dragging = key;
    // Selected from the moment it is grabbed
    if (key !== 'keyup') free = { key, ...handlePos(key, s.ad, s.sr) };
    grabOffset = start - state.keyUp;
    origin = key === 'a' ? s.ad >> 4 : key === 'd' ? s.ad & 15 : s.sr & 15;
    // Where the key goes up is a view setting, not part of the instrument
    if (key !== 'keyup') before();
    move = (e) => dragHandle(key, e);
  } else if (state.tab === 'wave' && barEl) {
    const i = Number(barEl.dataset.bar);
    const original = s.bars;
    const bar = original[i];
    const edge = target.getAttribute('data-edge');
    selected = i;
    before();
    dragging = 'bar';
    move = (e) => {
      const df = Math.round(frameAt(e) - start);
      let next: Bar;
      if (edge === 'start') {
        const end = bar.end ?? TOTAL;
        next = { ...bar, start: Math.max(0, Math.min(end - 1, bar.start + df)) };
      } else if (edge === 'end') {
        const end = Math.round(frameAt(e));
        // Pulled to the far end, it keeps going
        next = { ...bar, end: end >= TOTAL - 2 ? null : Math.max(bar.start + 1, end) };
      } else {
        const len = bar.end === null ? null : bar.end - bar.start;
        const from = Math.max(0, Math.min(TOTAL - 1, bar.start + df));
        next = { wave: LANES[laneAt(e)], start: from, end: len === null ? null : from + len };
      }
      const bars = place(
        original.filter((o) => o !== bar),
        next,
      );
      // Noise with both saw and pulse can't be stored: that move doesn't happen
      if (!storable(bars)) return;
      s.bars = bars;
      selected = bars.indexOf(next);
      render();
    };
  } else if (state.tab === 'wave' && yAt(e) > RULER + HEARD) {
    // Drawing a new bar along a row
    const wave = LANES[laneAt(e)];
    const original = s.bars;
    const from = Math.max(0, Math.round(start));
    before();
    dragging = 'bar';
    move = (e) => {
      const to = Math.round(frameAt(e));
      const next: Bar = { wave, start: Math.min(from, to), end: Math.max(from, to) === Math.min(from, to) ? Math.min(from, to) + 1 : Math.max(from, to) };
      if (next.end! >= TOTAL - 1) next.end = null;
      const bars = place(original, next);
      if (!storable(bars)) return;
      s.bars = bars;
      selected = bars.indexOf(next);
      render();
    };
    // A click without dragging just clears the selection
    selected = -1;
  } else {
    selected = -1;
    render();
    return;
  }

  e.preventDefault();
  plot.setPointerCapture(e.pointerId);
  const onMove = (e: PointerEvent) => {
    // A drag starts once the pointer has moved a few pixels, any way
    if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 3) return;
    moved = true;
    move!(e);
  };
  const onUp = () => {
    plot.removeEventListener('pointermove', onMove);
    plot.removeEventListener('pointerup', onUp);
    plot.removeEventListener('pointercancel', onUp);
    dragging = null;
    free = null;
    if (moved) {
      changed();
      playShape();
    } else {
      // A click: keep the selection, drop the undo point
      undoStack.length = marks;
      render();
    }
  };
  plot.addEventListener('pointermove', onMove);
  plot.addEventListener('pointerup', onUp);
  plot.addEventListener('pointercancel', onUp);
  render();
});

function dragHandle(key: string, e: PointerEvent) {
  const s = shape();
  const f = frameAt(e);
  const [a, d, sus, r] = [s.ad >> 4, s.ad & 15, s.sr >> 4, s.sr & 15];
  // The setting the pointer is at. Settings close together switch halfway
  // between; across a wide gap, the dot moves on once the pointer is
  // STEP_GAP pixels from the setting it came from, and back within it.
  const settle = (position: (v: number) => number, at: number): number => {
    let lo = -1;
    for (let v = 0; v < 16; v++) if (position(v) <= at) lo = v;
    if (lo < 0) return 0;
    if (lo === 15) return 15;
    const hi = lo + 1;
    const px = (frames: number) => frames * state.zoom;
    if (px(position(hi) - position(lo)) < STEP_GAP) return at - position(lo) <= position(hi) - at ? lo : hi;
    if (origin >= hi) return px(position(hi) - at) >= STEP_GAP ? lo : hi;
    return px(at - position(lo)) >= STEP_GAP ? hi : lo;
  };
  let v = 0;
  if (key === 'keyup') state.keyUp = Math.max(1, Math.min(TOTAL - 1, Math.round(f)));
  else if (key === 'a') {
    s.ad = (settle(attackFrames, f) << 4) | d;
    v = 1;
  } else if (key === 'd') {
    s.ad = (a << 4) | settle((dv) => decayEnd(a, dv, sus), f);
    v = sus / 15;
  } else if (key === 's') {
    // Up and down is the level, to the nearest (they are close together);
    // sideways is when the key goes up, for Play and the picture
    v = Math.max(0, Math.min(1, 1 - (yAt(e) - RULER - PAD_TOP) / LEVEL_H));
    s.sr = (Math.round(v * 15) << 4) | r;
    state.keyUp = Math.max(1, Math.min(TOTAL - 1, Math.round(f - grabOffset)));
  } else if (key === 'r') {
    const releaseAt = (rv: number) => releaseEnd(s.ad, (sus << 4) | rv, state.keyUp);
    s.sr = (sus << 4) | settle(releaseAt, f);
  }
  // Sustain's capsule keeps its end on the key going up
  free = key === 'keyup' ? null : { key, f: key === 's' ? handlePos('s', s.ad, s.sr).f : Math.max(0, f), v };
  render();
}

// Handles move with the arrow keys too, a step at a time
plot.addEventListener('keydown', (e) => {
  const key = (e.target as Element).closest<SVGGElement>('[data-drag]')?.dataset.drag;
  if (!key) return;
  const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  e.stopPropagation();
  const s = shape();
  const clamp = (v: number) => Math.max(0, Math.min(15, v));
  before();
  if (key === 'keyup') state.keyUp = Math.max(1, Math.min(TOTAL - 1, state.keyUp + dir * 5));
  else if (key === 'a') s.ad = (clamp((s.ad >> 4) + dir) << 4) | (s.ad & 15);
  else if (key === 'd') s.ad = (s.ad & 0xf0) | clamp((s.ad & 15) + dir);
  else if (key === 's' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) s.sr = (clamp((s.sr >> 4) + dir) << 4) | (s.sr & 15);
  else if (key === 's') state.keyUp = Math.max(1, Math.min(TOTAL - 1, state.keyUp + dir));
  else if (key === 'r') s.sr = (s.sr & 0xf0) | clamp((s.sr & 15) + dir);
  changed();
  (plot.querySelector(`[data-drag="${key}"]`) as SVGGElement | null)?.focus();
});

scroller.addEventListener(
  'wheel',
  (e) => {
    // Pinching, or scrolling with ⌘/Ctrl, zooms around the pointer
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - scroller.getBoundingClientRect().left);
  },
  { passive: false },
);
$('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.5));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.5));
$('zoom-fit').addEventListener('click', () => {
  // What the tab is about: the sound until it has faded, or the bars
  const s = shape();
  let frames: number;
  if (state.tab === 'volume') frames = Math.max(state.keyUp, releaseEnd(s.ad, s.sr, state.keyUp));
  else {
    // Bars that keep going are shown a little way past where they start
    frames = Math.max(0, ...s.bars.map((b) => b.end ?? b.start + 10));
    if (frames <= 10 && s.bars.every((b) => b.end === null)) frames = state.keyUp;
  }
  setZoom((scroller.clientWidth - 2 * ORIGIN) / Math.min(TOTAL, Math.max(5, frames * 1.08 + 2)), 0);
  scroller.scrollLeft = 0;
});

// The zoom slider runs evenly from the whole timeline to the closest view
const zoomSlider = $<HTMLInputElement>('zoom-slider');
const SLIDER_STEPS = 1000;
function sliderValue() {
  const lo = Math.log(minZoom());
  return Math.round(((Math.log(state.zoom) - lo) / (Math.log(MAX_ZOOM) - lo)) * SLIDER_STEPS);
}
zoomSlider.max = String(SLIDER_STEPS);
zoomSlider.addEventListener('input', () => {
  const lo = Math.log(minZoom());
  setZoom(Math.exp(lo + (Number(zoomSlider.value) / SLIDER_STEPS) * (Math.log(MAX_ZOOM) - lo)));
});
new ResizeObserver(() => {
  state.zoom = Math.max(minZoom(), state.zoom);
  render();
}).observe(scroller);

for (const b of $('tabs').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab as Tab;
    persist();
    render();
  });
}

$<HTMLInputElement>('name').addEventListener('input', (e) => {
  before();
  shape().name = (e.target as HTMLInputElement).value;
  persist();
  renderInstruments();
});

// --- Instruments -----------------------------------------------------------------

function renderInstruments() {
  const select = $<HTMLSelectElement>('instrument');
  select.replaceChildren(...state.instruments.map((s, i) => new Option(s.name || `Instrument ${i + 1}`, String(i))));
  select.value = String(state.current);
  $<HTMLButtonElement>('delete-instrument').disabled = state.instruments.length < 2;
}

function pick(i: number) {
  state.current = i;
  selected = -1;
  renderInstruments();
  changed();
}

$<HTMLSelectElement>('instrument').addEventListener('change', (e) => pick(Number((e.target as HTMLSelectElement).value)));
$('new-instrument').addEventListener('click', () => {
  before();
  state.instruments.push({ name: `Instrument ${state.instruments.length + 1}`, ad: 0x09, sr: 0x00, bars: [{ wave: WAVE_PULSE, start: 0, end: null }] });
  pick(state.instruments.length - 1);
});
$('duplicate-instrument').addEventListener('click', () => {
  before();
  const s = shape();
  state.instruments.splice(state.current + 1, 0, { ...s, name: `${s.name} copy`, bars: s.bars.map((b) => ({ ...b })) });
  pick(state.current + 1);
});
$('delete-instrument').addEventListener('click', () => {
  if (state.instruments.length < 2) return;
  before();
  const name = shape().name;
  state.instruments.splice(state.current, 1);
  pick(Math.min(state.current, state.instruments.length - 1));
  toast(`Deleted ${name} (⌘Z brings it back)`);
});

// --- Playing ---------------------------------------------------------------------

const player = new Player();
player.onError = (m) => toast(m);
let lastStatus: Status | null = null;
player.onStatus = (status) => (lastStatus = status);
let held: number | null = null;
let noteStart = 0;
let releaseAt: number | null = null;
let playTimer = 0;

function sendToPlayer() {
  if (!player.started) return;
  const a = audition();
  player.setTables(a.tables);
  player.setInstrument(TEST_INSTRUMENT, a.instrument);
}

async function noteOn(note: number) {
  held = note;
  test.note = note;
  clearTimeout(playTimer);
  renderKeyboard();
  if (!player.started) {
    try {
      await player.start();
    } catch (err) {
      held = null;
      renderKeyboard();
      toast(`Audio failed to start: ${err}`);
      return;
    }
    sendToPlayer();
  }
  player.noteOn(0, note, TEST_INSTRUMENT);
  noteStart = performance.now();
  releaseAt = null;
  if (held !== note) noteOff();
  animate();
}

function noteOff(note?: number) {
  if (held === null || (note !== undefined && note !== held)) return;
  held = null;
  releaseAt = Math.max(1, liveFrame());
  if (player.started) player.noteOff(0);
  renderKeyboard();
}

function silence() {
  held = null;
  clearTimeout(playTimer);
  if (player.started) player.silence();
  renderKeyboard();
}

/** Plays the last note held until the key-up line, as drawn. */
function playShape() {
  const note = test.note;
  void noteOn(note).then(() => {
    clearTimeout(playTimer);
    playTimer = window.setTimeout(() => noteOff(note), (state.keyUp / FPS) * 1000);
  });
}

/** The timeline frame the note has reached. */
function liveFrame(): number {
  const elapsed = (performance.now() - noteStart) / 1000 - player.latency;
  // The note sounds after the gate timer and a frame of setup
  return Math.floor(elapsed * FPS) - 3;
}

let animating = false;
function animate() {
  if (animating) return;
  animating = true;
  const step = () => {
    const f = liveFrame();
    const s = shape();
    const end = releaseAt === null ? TOTAL : Math.min(TOTAL, releaseEnd(s.ad, s.sr, releaseAt));
    const was = playhead;
    playhead = f >= 0 && f < end ? f : -1;
    if (playhead !== was) movePlayhead();
    if (f < end) requestAnimationFrame(step);
    else animating = false;
  };
  requestAnimationFrame(step);
}

const KEY_LETTERS = [...'AWSEDFTGYHUJKOLP;'];
const KEYS: Record<string, number> = Object.fromEntries(KEY_LETTERS.map((k, i) => [k.toLowerCase(), i]));

function renderKeyboard() {
  const board = $('keyboard');
  const base = test.octave * 12;
  if (!board.childElementCount) {
    let white = 0;
    for (let i = 0; i < 25; i++) {
      const black = [1, 3, 6, 8, 10].includes(i % 12);
      const key = document.createElement('button');
      key.className = black ? 'key black' : 'key';
      key.dataset.offset = String(i);
      key.style.setProperty('--x', String(black ? white - 0.3 : white));
      if (!black) white++;
      key.tabIndex = -1;
      board.append(key);
    }
    board.style.setProperty('--whites', String(white));
    const keyAt = (e: PointerEvent) => document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('#keyboard .key');
    let down = false;
    board.addEventListener('pointerdown', (e) => {
      const key = keyAt(e);
      if (!key) return;
      e.preventDefault();
      board.setPointerCapture(e.pointerId);
      down = true;
      void noteOn(test.octave * 12 + Number(key.dataset.offset));
    });
    board.addEventListener('pointermove', (e) => {
      if (!down) return;
      const key = keyAt(e);
      const note = key ? test.octave * 12 + Number(key.dataset.offset) : null;
      if (note !== null && note !== held) void noteOn(note);
    });
    const end = () => {
      down = false;
      noteOff();
    };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
  }
  const labels = $('key-labels');
  labels.replaceChildren();
  for (const key of board.querySelectorAll<HTMLElement>('.key')) {
    const offset = Number(key.dataset.offset);
    const n = base + offset;
    key.classList.toggle('down', n === held);
    key.textContent = KEY_LETTERS[offset] ?? '';
    key.setAttribute('aria-label', noteName(n));
    if (n % 12 === 0) {
      const label = document.createElement('span');
      label.textContent = noteName(n).replace('-', '');
      label.style.setProperty('--x', key.style.getPropertyValue('--x'));
      labels.append(label);
    }
  }
}

/** Only fields you type into keep the keys; elsewhere the keys play notes. */
function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea') || t.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing(e)) {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if (e.key === 'Escape') {
    silence();
    if (selected >= 0) {
      selected = -1;
      render();
    }
    if (typing(e)) (e.target as HTMLElement).blur();
    return;
  }
  if (e.key === 'Enter' && typing(e)) {
    (e.target as HTMLElement).blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || e.repeat) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.tab === 'wave' && selected >= 0) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === ' ' && !(e.target as HTMLElement).matches('button, select')) {
    e.preventDefault();
    playShape();
    return;
  }
  const offset = KEYS[e.key.toLowerCase()];
  if (offset === undefined) return;
  e.preventDefault();
  void noteOn(Math.min(94, test.octave * 12 + offset));
});
window.addEventListener('keyup', (e) => {
  const offset = KEYS[e.key.toLowerCase()];
  if (offset !== undefined) noteOff(Math.min(94, test.octave * 12 + offset));
});
window.addEventListener('blur', () => noteOff());
document.addEventListener('visibilitychange', () => document.hidden && silence());

$('octave-down').addEventListener('click', () => {
  test.octave = Math.max(0, test.octave - 1);
  renderKeyboard();
});
$('octave-up').addEventListener('click', () => {
  test.octave = Math.min(6, test.octave + 1);
  renderKeyboard();
});
$('play').addEventListener('click', playShape);

// The chip is a setting for the whole app
{
  const model = loadModel();
  player.setModel(model);
  for (const b of $('model').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', Number(b.dataset.model) === model);
    b.addEventListener('click', () => {
      player.setModel(Number(b.dataset.model));
      saveModel(Number(b.dataset.model));
      for (const o of $('model').querySelectorAll('button')) o.classList.toggle('on', o === b);
    });
  }
}

let toastTimer = 0;
function toast(message: string) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 3200);
}

// --- Start --------------------------------------------------------------------------

renderInstruments();
render();
renderKeyboard();
Analyzer.create()
  .then((a) => (analyzer = a))
  .catch((err) => toast(`Engine failed to start: ${err}`));

// For scripts/browsertest.mjs
Object.assign(window, {
  maker2: {
    state: () => state,
    trace,
    audition,
    ready: () => analyzer !== null,
    status: () => lastStatus,
  },
});
