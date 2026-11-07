// The second instrument maker: an instrument shaped on a timeline rather
// than written as program steps. Each side of the sound is a section on the
// same time axis that folds open and closed: the volume envelope with
// handles to drag, and the waveform as bars in rows, moved and resized like
// clips.

import './style.css';
import './instrumentmaker.css';
import './maker2.css';
import { Analyzer, type Trace } from './engine/analyzer';
import type { TableData } from './engine/configure';
import { loadModel, loadNtsc, Player, saveModel, saveNtsc } from './engine/player';
import { DEFAULT_SETTINGS, type Settings, type Status } from './engine/protocol';
import { ATTACK_MS, DECAY_MS } from './adsr';
import { envelope, NTSC_FRAME_CYCLES, PAL_FRAME_CYCLES } from './envelope';
import { noteName, parseSong, type Instrument } from './song';
import { defaultInstruments, giveIds, migrate, saveIds, NOTE_START, sound, soundTables, STORAGE_KEY } from './instruments';
import { importInstrument, KEY as IMPORT_KEY, type Tracer } from './goatimport';
import { FILTER_BAND, FILTER_HIGH, FILTER_LOW, waveName, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI } from './tables';
import { waveIcon, waveRun } from './waveicon';
import { filterScope, modeIcon } from './filtercurve';
import { freqOf, semitoneText as pitchText, vibratoCurve, vibratoSize, type Wobble } from './vibrato';
import { arrival, chunkAt, stayingOn, FIXED_BASE, RING_BIT, SYNC_BIT, CUTOFF_MAX, defaultFilter, defaultPulse, lineAt, placeChunk, RESONANCE_MAX, heardSpans, LANES, NOTE_HIGH, NOTE_LOW, pitchAt, place, placeNote, programEnd, PULSE_MAX, pulseLine, SQUARE, storable, stretches, waveChanges, waveLooping, widthOn, type Bar, type HeardSpan, type FilterChunk, type Note, type PulseShape, type Shape } from './shape';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';
/**
 * The machine's clock: PAL runs the player 50 times a second, NTSC 60, and
 * NTSC's chip clock is faster too. Instruments are stored in frames, so
 * the same instrument takes less time on NTSC.
 */
let ntsc = loadNtsc();
let FPS = ntsc ? 60 : 50;
/** Chip clock cycles per second */
let CLOCK = ntsc ? 1022727 : 985248;
let settings: Settings = { ...DEFAULT_SETTINGS, ntsc };
/** How a new instrument's notes start: as GoatTracker's do by default */

const TEST_INSTRUMENT = 1;
/** The timeline's length: 32 seconds, the slowest attack (8 s) and decay (24 s) together */
const SECONDS = 32;
let TOTAL = SECONDS * FPS;
const MAX_ZOOM = 24;
const RULER = 24;
const PLOT = 196;
/** The waveform strip showing what is heard */
const HEARD = 24;
/** Each waveform row's height when the rows open under the volume envelope */
const OPEN_LANE_H = 40;
/** Room above full volume and below silence for the dots' labels */
const PAD_TOP = 40;
const PAD_BOTTOM = 8 + HEARD;
/** The volume envelope's height when folded into a preview */
const VOLUME_PREVIEW = 36;
/** The open volume envelope's header, over its top */
const VOLUME_HEAD = 22;
/** Pixels from a bar's end that grab the end rather than the bar */
const EDGE = 7;
/**
 * Across a gap at least this many pixels wide, a dragged dot moves to the
 * next setting once it is this far from the one it came from (rather than
 * halfway), so a long way between settings still answers the pointer.
 */
const STEP_GAP = 40;


interface State {
  instruments: Shape[];
  current: number;
  /** Pixels per frame */
  zoom: number;
  /** When the key goes up in the picture and when Play lets go, in frames */
  keyUp: number;
  /** Whether the volume envelope is open, or folded into a preview */
  volumeOpen: boolean;
  /** Whether the waveform rows are open under the volume envelope */
  waveOpen: boolean;
  /** Whether the notes are open, under the waveform */
  notesOpen: boolean;
  /** Whether the filter is open, at the bottom */
  filterOpen: boolean;
  /** The lowest pitch the roll shows (it shows ROLL_SPAN semitones up from it) */
  rollLow: number;
  /** Whether the Advanced box (note start, sync, ring) is open */
  advancedOpen: boolean;
}

function defaults(): State {
  return {
    instruments: defaultInstruments(),
    current: 0,
    zoom: 0,
    keyUp: 50,
    volumeOpen: true,
    waveOpen: false,
    notesOpen: false,
    filterOpen: false,
    rollLow: -12,
    advancedOpen: false,
  };
}

let state: State = load();
/** The keyboard's octave and the note last played (Space's), kept for coming back to the page */
const TEST_KEY = 'sidkid.maker2.key';
const test = { octave: 3, note: 48 };
try {
  const saved = JSON.parse(localStorage.getItem(TEST_KEY) ?? 'null');
  if (Number.isInteger(saved?.octave) && saved.octave >= 0 && saved.octave <= 6) test.octave = saved.octave;
  if (Number.isInteger(saved?.note) && saved.note >= 0 && saved.note <= 94) test.note = saved.note;
} catch {
  // (the defaults)
}
function saveTest() {
  try {
    localStorage.setItem(TEST_KEY, JSON.stringify(test));
  } catch {
    // (kept for this visit only)
  }
}
const shape = () => state.instruments[state.current];

function load(): State {
  saveIds();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.instruments?.length) {
      migrate(saved.instruments, TOTAL);
      return { ...defaults(), ...saved };
    }
  } catch {
    // Unreadable or blocked storage: start afresh
  }
  return defaults();
}

function persist() {
  giveIds(state.instruments);
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
  selectedPoint = -1;
  selectedNote = -1;
  selectedVibrato = false;
  selectedType = -1;
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

type Audition = { tables: TableData[]; instrument: Instrument };


/** Where the key goes up: the instrument's own place when fixed, else the view's (how long the note is played) */
function keyUp(): number {
  return shape().release ?? state.keyUp;
}
function setKeyUp(f: number) {
  const at = Math.max(1, Math.min(TOTAL - 1, Math.round(f)));
  const s = shape();
  if (s.release !== null) s.release = at;
  else state.keyUp = at;
}

function audition(s: Shape = shape()): Audition {
  // The test note plays on voice 1, so that is the voice it filters
  const t = soundTables([sound(s, 1, 1, true)]);
  return { tables: t.tables, instrument: t.instruments[0] };
}

let analyzer: Analyzer | null = null;

/** What the player writes to the chip for a held note, frame by frame (for tests). */
function trace(frames = 100): Trace | null {
  return traceWith(audition(), frames);
}

function traceWith(a: Audition, frames: number): Trace | null {
  if (!analyzer) return null;
  return analyzer.trace(a.tables, a.instrument, test.note, frames, settings);
}

// --- Volume ---------------------------------------------------------------------

const ENV_STEPS = 4;
const simCache = new Map<string, Float32Array>();

/** The envelope level, ENV_STEPS samples a frame, with the key going up at keyUp. */
function level(ad: number, sr: number, keyUp: number, frames = TOTAL): Float32Array {
  const key = `${ad},${sr},${keyUp},${frames},${FPS}`;
  let out = simCache.get(key);
  if (!out) {
    out = envelope(ad, sr, Array.from({ length: frames }, (_, f) => f < keyUp), ENV_STEPS, ntsc ? NTSC_FRAME_CYCLES : PAL_FRAME_CYCLES);
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

/**
 * The datasheet's envelope times are for a 1 MHz clock; the real ones scale
 * with the machine's, so PAL is a little slower and NTSC a little faster.
 */
const realFrames = (ms: number) => (ms / 1000) * (1e6 / CLOCK) * FPS;
const attackFrames = (a: number) => realFrames(ATTACK_MS[a]);

/** Where the decay reaches the sustain level, with the key held. */
function decayEnd(a: number, d: number, s: number): number {
  const top = attackFrames(a);
  // At full sustain there is no fall: the handle sits a little along the top
  if (s === 15) return top + realFrames(DECAY_MS[d]) * 0.1;
  const frames = Math.ceil(top + realFrames(DECAY_MS[d])) + 4;
  const curve = level((a << 4) | d, s << 4, frames + 1, frames);
  // From the top of the attack: decay starts as soon as it gets there
  let peak = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] > curve[peak]) peak = i;
  return firstFrame(curve, peak / ENV_STEPS, (v) => v <= (s * 17 + 0.5) / 255) ?? frames;
}

/** Where the sound has died away after the key goes up. */
function releaseEnd(ad: number, sr: number, keyUp: number): number {
  const frames = Math.min(2400, Math.ceil(keyUp + realFrames(DECAY_MS[sr & 15])) + 4);
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
  d: (v: number) => `Decay ${timeText(realFrames(DECAY_MS[v]))}`,
  s: (v: number) => `Sustain ${Math.round((v / 15) * 100)}%`,
  r: (v: number) => `Release ${timeText(realFrames(DECAY_MS[v]))}`,
};

// --- Drawing --------------------------------------------------------------------

const plot = $('plot') as unknown as SVGSVGElement;
const scroller = $('scroll');
let selected = -1;
/** The selected pulse width point, or -1 */
let selectedPoint = -1;
/** The selected note, or -1 */
let selectedNote = -1;
/** Whether the vibrato is selected */
let selectedVibrato = false;
/** The selected filter type change, or -1 */
let selectedType = -1;
/** What is being dragged, for its look and the readout */
let dragging: string | null = null;
/** While an envelope handle is dragged it follows the pointer, and the setting it will land on is drawn */
let free: { key: string; f: number; v: number } | null = null;
/** The setting (0-15) the dragged handle had when grabbed */
let origin = 0;
/** Frames from the key going up to where the sustain dot was grabbed, so it doesn't jump */
let grabOffset = 0;
let playhead = -1;
/** Kept from one drawing to the next and moved on its own, so playing doesn't redraw what is under the pointer */
const playheadLine = el('line', { y1: 0, class: 'tl-playhead' });

function movePlayhead() {
  playheadLine.style.display = playhead >= 0 ? '' : 'none';
  playheadLine.setAttribute('x1', String(x(playhead)));
  playheadLine.setAttribute('x2', String(x(playhead)));
  // The filter scope follows the note as it plays
  if (state.filterOpen) updateScope();
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

/** A waveform row, or (wave null) the pulse width row under the pulse row. */
interface Row {
  wave: number | null;
  top: number;
  h: number;
}

/** The pulse width row's height */
const WIDTH_H = 52;

const usesPulse = () => shape().bars.some((b) => b.wave & WAVE_PULSE);

/** The waveform rows, top to bottom, if they are open; pulse width sits under pulse while pulse is used. */
function rows(): Row[] | null {
  if (!state.waveOpen) return null;
  const out: Row[] = [];
  let y = floor() + PAD_BOTTOM;
  for (const wave of LANES) {
    out.push({ wave, top: y, h: OPEN_LANE_H });
    y += OPEN_LANE_H;
    if (wave === WAVE_PULSE && usesPulse()) {
      out.push({ wave: null, top: y, h: WIDTH_H });
      y += WIDTH_H;
    }
  }
  return out;
}

const rowOf = (wave: number | null) => rows()!.find((r) => r.wave === wave)!;

/** Each semitone's height in the notes, and the room above and below them */
const SEMI = 6;
const ROLL_PAD = 6;
/** The roll shows three octaves of pitches at a time, moved an octave at a time */
const ROLL_SPAN = 36;
const ROLL_H = (ROLL_SPAN + 1) * SEMI + 2 * ROLL_PAD;
const rollHigh = () => state.rollLow + ROLL_SPAN;
/** The lowest the roll goes: the octave below the lowest pitch a step can have */
const ROLL_LOWEST = Math.floor(NOTE_LOW / 12) * 12;
/** Moves the roll an octave up or down, within the pitches a step can have */
function moveRoll(by: number) {
  state.rollLow = Math.max(ROLL_LOWEST, Math.min(NOTE_HIGH - ROLL_SPAN, state.rollLow + by));
  persist();
  render();
}
/** The roll moved to show an instrument's pitches, if they are out of sight: from its lowest octave */
function fitRoll() {
  const s = shape();
  const pitches = s.notes.map((n) => n.semis);
  if (!pitches.length || pitches.every((p) => p >= state.rollLow && p <= rollHigh())) return;
  const lo = Math.floor(Math.min(...pitches) / 12) * 12;
  state.rollLow = Math.max(ROLL_LOWEST, Math.min(NOTE_HIGH - ROLL_SPAN, lo));
}

/** The notes' band: under the waveform's band and its rows */
function notesTop(): number {
  const r = rows();
  return r ? r[r.length - 1].top + r[r.length - 1].h : floor() + PAD_BOTTOM;
}

const rollTop = () => notesTop() + PAD_BOTTOM;
/** The top of a semitone's row in the notes */
const noteY = (semis: number) => rollTop() + ROLL_PAD + (rollHigh() - semis) * SEMI;

function semiAt(e: PointerEvent): number {
  const s = rollHigh() - Math.floor((yAt(e) - rollTop() - ROLL_PAD) / SEMI);
  return Math.max(NOTE_LOW, Math.min(NOTE_HIGH, Math.max(state.rollLow, Math.min(rollHigh(), s))));
}

function inRoll(e: PointerEvent): boolean {
  return state.notesOpen && yAt(e) >= rollTop() && yAt(e) < rollTop() + ROLL_H;
}

/** The timeline's height: taller with sections open */
function height(): number {
  return filterTop() + PAD_BOTTOM + (state.filterOpen ? CUTOFF_H + RES_H + TYPE_H : 0);
}

/** The filter's band: under the pitch and its rows */
const filterTop = () => notesTop() + PAD_BOTTOM + (state.notesOpen ? ROLL_H + VIB_H : 0);
/** The cutoff row's height, open */
const CUTOFF_H = 80;
/** The type's row first, then the cutoff's and resonance's */
const TYPE_H = 40;
const typeTop = () => filterTop() + PAD_BOTTOM;
const cutoffTop = () => typeTop() + TYPE_H;
const RES_H = 52;
const resTop = () => cutoffTop() + CUTOFF_H;

function inTypeRow(e: PointerEvent): boolean {
  return state.filterOpen && yAt(e) >= typeTop() && yAt(e) < typeTop() + TYPE_H;
}

/** The vibrato lane, under the notes */
const VIB_H = 34;
const vibTop = () => rollTop() + ROLL_H;

function inVibrato(e: PointerEvent): boolean {
  return state.notesOpen && yAt(e) >= vibTop() && yAt(e) < vibTop() + VIB_H;
}

/** The line at silence, under the envelope or its preview, with the waveform strip below */
function floor(): number {
  return state.volumeOpen ? RULER + PLOT - PAD_BOTTOM : RULER + VOLUME_PREVIEW;
}


const viewWidth = () => scroller.clientWidth - 2 * ORIGIN;

/** Where the instrument reaches: the sound until it has faded, the key going up, and the bars (those that keep going counted a little past their start). */
function dataEnd(volume = true, waves = true): number {
  const s = shape();
  let end = 0;
  if (volume) end = Math.max(keyUp(), releaseEnd(s.ad, s.sr, keyUp()));
  if (waves) end = Math.max(end, ...s.bars.map((b) => b.end ?? b.start + 10), ...s.notes.map((n) => n.start + 1), ...(s.filter.types.length ? [...s.filter.cutoff.points, ...s.filter.resonance.points].map((p) => p.t + 10) : []), ...s.filter.types.map((c) => c.end));
  return Math.min(TOTAL, Math.max(5, end));
}

/** The whole timeline in view */
const wholeZoom = () => viewWidth() / TOTAL;

/** Zoomed right out, everything there is fills a quarter of the view (or the whole timeline shows). */
function minZoom() {
  return Math.min(MAX_ZOOM, Math.max(wholeZoom(), viewWidth() / (4 * dataEnd())));
}

/**
 * How far out zooming can go now: the limit, or where the view already is
 * if that is further out (after the instrument has shrunk), so zooming
 * never jumps. While the slider is dragged, its range stays as it began.
 */
let sliderFloor: number | null = null;
function zoomFloor() {
  return sliderFloor ?? Math.min(minZoom(), state.zoom);
}

/**
 * Zooms around a point in the view (pinching zooms around the pointer), or
 * else around the middle of the instrument: it stays where it is on
 * screen, or comes to the middle of the view if it was out of sight.
 */
function setZoom(z: number, pointer?: number) {
  let mid: number;
  let at: number;
  if (pointer !== undefined) {
    at = pointer;
    mid = (scroller.scrollLeft + pointer - ORIGIN) / state.zoom;
  } else {
    mid = dataEnd() / 2;
    at = x(mid) - scroller.scrollLeft;
    if (at < 0 || at > scroller.clientWidth) at = scroller.clientWidth / 2;
  }
  state.zoom = Math.max(zoomFloor(), Math.min(MAX_ZOOM, z));
  render();
  scroller.scrollLeft = x(mid) - at;
  persist();
}

/** Ruler ticks: a step in frames that leaves room for the labels. */
function tickStep(): number {
  // A frame or two, else a round fraction of a second
  const steps = [1, 2, ...[0.1, 0.2, 0.5, 1, 2, 5, 10].map((s) => s * FPS)];
  return steps.find((s) => s * state.zoom >= 56) ?? 10 * FPS;
}

// --- Choices beside things: how the key up and the pitch go ---------------------

/** A small menu beside something, shown while the pointer is over either */
const choice = document.createElement('div');
choice.className = 'choice-popup';
choice.hidden = true;
document.body.append(choice);
let choiceTimer = 0;
let choiceBuild: ((box: HTMLElement) => void) | null = null;
function showChoice(anchor: Element, build: (box: HTMLElement) => void) {
  clearTimeout(choiceTimer);
  if (dragging) return;
  choiceBuild = build;
  fillChoice();
  choice.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = choice.offsetWidth;
  // Beside it on the right, or on the left where there is no room
  const left = r.right + 8 + w < window.innerWidth ? r.right + 8 : Math.max(8, r.left - 8 - w);
  choice.style.left = `${left + window.scrollX}px`;
  choice.style.top = `${r.top + r.height / 2 - choice.offsetHeight / 2 + window.scrollY}px`;
}
function fillChoice() {
  choice.replaceChildren();
  choiceBuild?.(choice);
}
function hideChoiceSoon() {
  clearTimeout(choiceTimer);
  choiceTimer = window.setTimeout(hideChoice, 250);
}
function hideChoice() {
  choice.hidden = true;
  choiceBuild = null;
}
choice.addEventListener('pointerenter', () => clearTimeout(choiceTimer));
choice.addEventListener('pointerleave', hideChoiceSoon);

/** Two or more buttons, one on, in a row */
function segmented(options: { label: string; on: boolean; title: string; pick: () => void }[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'segmented small';
  for (const o of options) {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.title = o.title;
    b.classList.toggle('on', o.on);
    b.addEventListener('click', () => {
      if (!o.on) o.pick();
      fillChoice();
    });
    box.append(b);
  }
  return box;
}

/** The key up: when the note's key goes up (as played), or always at its place (fixed: drums) */
function keyUpChoice(box: HTMLElement) {
  const s = shape();
  box.append(
    segmented([
      {
        label: 'As played',
        on: s.release === null,
        title: 'The note lets go when its key goes up',
        pick: () => {
          before();
          state.keyUp = s.release!;
          s.release = null;
          changed();
        },
      },
      {
        label: 'Fixed',
        on: s.release !== null,
        title: 'The instrument lets go here however long the note is held, as drums do',
        pick: () => {
          before();
          s.release = state.keyUp;
          changed();
        },
      },
    ]),
  );
}

/** The pitch: from the key played, or always from one note (fixed: drums), stepped a semitone at a time */
function pitchChoice(box: HTMLElement) {
  const s = shape();
  box.append(
    segmented([
      {
        label: 'As played',
        on: s.fixedNote === null,
        title: 'Pitches go from the key played',
        pick: () => {
          before();
          s.fixedNote = null;
          changed();
        },
      },
      {
        label: 'Fixed',
        on: s.fixedNote !== null,
        title: 'Pitches go from one note, whatever key is played, as drums do',
        pick: () => {
          before();
          s.fixedNote = test.note;
          // Steps fixed on their own were from C-4: now from the instrument's note
          s.notes = s.notes.map(({ fixed, ...n }) => (fixed ? { ...n, semis: n.semis + FIXED_BASE - test.note } : n));
          changed();
        },
      },
    ]),
  );
  if (s.fixedNote === null) return;
  const step = (by: number, label: string) => {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = label;
    b.title = by < 0 ? 'A semitone lower' : 'A semitone higher';
    b.addEventListener('click', () => {
      before();
      s.fixedNote = Math.max(1, Math.min(0x5f, s.fixedNote! + by));
      changed();
      fillChoice();
      playShape();
    });
    return b;
  };
  const name = document.createElement('span');
  name.className = 'fixed-note';
  name.textContent = noteName(s.fixedNote);
  const row = document.createElement('div');
  row.className = 'fixed-note-row';
  row.append(step(-1, '‹'), name, step(1, '›'));
  box.append(row);
}

/** Redraws the page; `keepReadout` leaves the controls under the timeline alone (a slider there is being dragged). */
function render(keepReadout = false) {
  if (!state.zoom) state.zoom = Math.max(wholeZoom(), scroller.clientWidth / 100);
  const s = shape();
  $<HTMLInputElement>('name').value = document.activeElement === $('name') ? $<HTMLInputElement>('name').value : s.name;
  $('zoom-label').textContent = `${timeText(scroller.clientWidth / state.zoom)} shown`;
  if (document.activeElement !== zoomSlider) zoomSlider.value = String(sliderValue());
  renderOptions();

  const width = x(TOTAL) + ORIGIN;
  const HEIGHT = height();
  plot.setAttribute('width', String(width));
  plot.setAttribute('height', String(HEIGHT));
  plot.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  playheadLine.setAttribute('y2', String(HEIGHT));
  plot.replaceChildren();

  // Ruler and grid
  const step = tickStep();
  el('rect', { x: 0, y: 0, width, height: RULER, class: 'tl-ruler' }, plot);
  for (let f = 0; f <= TOTAL; f += step) {
    el('line', { x1: x(f), x2: x(f), y1: RULER, y2: HEIGHT, class: f % FPS === 0 ? 'tl-grid second' : 'tl-grid' }, plot);
    el('line', { x1: x(f), x2: x(f), y1: RULER - 6, y2: RULER, class: 'tl-tick' }, plot);
    const label = el('text', { x: x(f) + 3, y: RULER - 9, class: 'tl-label' }, plot);
    label.textContent = f === 0 ? '0' : `${Math.round((f / FPS) * 100) / 100} s`;
  }

  const curve = level(s.ad, s.sr, keyUp());
  drawHead(RULER, state.volumeOpen ? VOLUME_HEAD : VOLUME_PREVIEW);
  drawVolume(curve);

  // The key going up, with a tab just under the ruler to drag it by,
  // pointing up at its time
  // Fixed, it is the instrument letting go itself, however long the note
  const ku = x(keyUp());
  const fixedUp = s.release !== null;
  el('line', { x1: ku, x2: ku, y1: RULER, y2: HEIGHT, class: `tl-keyup${fixedUp ? ' fixed' : ''}` }, plot);
  // (Over the folded volume preview there is no room for it)
  if (state.volumeOpen) {
    const tab = el('g', { class: `tl-keyup-tab${fixedUp ? ' fixed' : ''}${dragging === 'keyup' ? ' dragging' : ''}`, 'data-drag': 'keyup', tabindex: 0, role: 'slider', 'aria-label': `Key up at ${timeText(keyUp())}${fixedUp ? ', fixed' : ''}` }, plot);
    const tabTop = RULER + 6;
    const w = fixedUp ? 84 : 56;
    el('rect', { x: ku - w / 2, y: tabTop, width: w, height: 16, rx: 6 }, tab);
    el('path', { d: `M${ku - 5},${tabTop + 0.5}L${ku},${RULER + 1}L${ku + 5},${tabTop + 0.5}Z`, class: 'tl-keyup-point' }, tab);
    el('text', { x: ku, y: tabTop + 12, 'text-anchor': 'middle' }, tab).textContent = fixedUp ? 'fixed key up' : 'key up';
    // Over it, a choice beside it: as played, or fixed
    tab.addEventListener('pointerenter', () => showChoice(tab, keyUpChoice));
    tab.addEventListener('pointerleave', hideChoiceSoon);
  }

  plot.append(playheadLine);
  movePlayhead();

  renderGutter();
  if (!keepReadout) renderReadout();
}

function renderGutter() {
  const g = $('gutter');
  g.replaceChildren();
  g.style.height = `${height()}px`;
  const add = (top: number, height: number, content: (string | Node)[], cls = '') => {
    const d = document.createElement('div');
    d.className = `tl-gutter-row ${cls}`;
    d.style.top = `${top}px`;
    d.style.height = `${height}px`;
    d.append(...content);
    g.append(d);
    return d;
  };
  // A section name with a triangle, opening and closing it
  const toggle = (top: number, height: number, name: string, open: boolean, flip: () => void, cls = '') => {
    // A solid triangle, pointing down when open and right when closed
    const twisty = document.createElementNS(SVG, 'svg');
    twisty.setAttribute('viewBox', '0 0 12 12');
    twisty.setAttribute('class', 'twisty');
    twisty.setAttribute('aria-hidden', 'true');
    el('path', { d: open ? 'M1,3L11,3L6,10Z' : 'M3,1L10,6L3,11Z' }, twisty);
    const t = add(top, height, [twisty, name], `fold ${cls}`);
    t.setAttribute('role', 'button');
    t.setAttribute('aria-expanded', String(open));
    t.tabIndex = 0;
    t.addEventListener('click', flip);
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      flip();
    });
  };
  if (state.volumeOpen) {
    toggle(RULER, VOLUME_HEAD, 'Volume', true, () => openVolume(false), 'head');
    // Each level's number sits just above its line
    for (const v of [1, 0.5, 0]) add(plotY(v) - 15, 14, [String(v * 100)], 'on-line');
  } else toggle(RULER, VOLUME_PREVIEW, 'Volume', false, () => openVolume(true), 'head');
  toggle(floor(), PAD_BOTTOM, 'Waveform', state.waveOpen, () => openWaves(!state.waveOpen), 'head');
  const r = rows();
  for (const row of r ?? []) {
    if (row.wave !== null) add(row.top, row.h, [waveIcon(row.wave, 26, 14), waveName(row.wave)], 'lane');
    else add(row.top, row.h, ['Width'], 'lane width');
  }
  toggle(notesTop(), PAD_BOTTOM, 'Pitch', state.notesOpen, () => openNotes(!state.notesOpen), 'head');
  if (state.notesOpen) {
    const fixed = shape().fixedNote;
    for (let semis = rollHigh(); semis >= state.rollLow; semis -= 12) {
      const label = fixed !== null ? noteName(fixed + semis) : semis === 0 ? 'played' : semitoneText(semis);
      // Where the pitches go from: a capsule, to show it can be changed
      let content: string | Node = label;
      if (semis === 0) {
        const chip = document.createElement('span');
        chip.className = `pitch-from-chip${fixed !== null ? ' fixed' : ''}`;
        chip.textContent = fixed !== null ? `fixed ${label}` : label;
        content = chip;
      }
      // The top and bottom octaves have arrows beside them, moving the roll
      const arrow = (by: number) => {
        const b = document.createElement('button');
        b.className = 'roll-move';
        b.textContent = by > 0 ? '▲' : '▼';
        b.title = by > 0 ? 'Show higher pitches' : 'Show lower pitches';
        b.disabled = by > 0 ? rollHigh() >= NOTE_HIGH : state.rollLow <= NOTE_LOW;
        b.addEventListener('click', () => moveRoll(by));
        return b;
      };
      const ends = semis === rollHigh() ? [arrow(12)] : semis === state.rollLow ? [arrow(-12)] : [];
      const row = add(noteY(semis) + SEMI / 2 - 7, 14, [...ends, content], `semi${semis === 0 ? ' pitch-from' : ''}`);
      // Over where the pitches go from, a choice beside it: as played, or fixed
      if (semis === 0) {
        row.addEventListener('pointerenter', () => showChoice(row, pitchChoice));
        row.addEventListener('pointerleave', hideChoiceSoon);
      }
    }
    add(vibTop(), VIB_H, ['Vibrato'], 'lane width');
  }
  toggle(filterTop(), PAD_BOTTOM, 'Filter', state.filterOpen, () => openFilter(!state.filterOpen), 'head');
  if (state.filterOpen) {
    add(typeTop(), TYPE_H, ['Type'], 'lane sub');
    add(cutoffTop(), CUTOFF_H, ['Cutoff'], 'lane sub');
    add(resTop(), RES_H, ['Resonance'], 'lane sub');
  }
}

/** Opens or folds the volume envelope. */
function openVolume(open: boolean) {
  state.volumeOpen = open;
  persist();
  render();
}

/** Opens or closes the notes, selecting a note or none. */
function openFilter(open: boolean) {
  state.filterOpen = open;
  persist();
  render();
}

function openNotes(open: boolean, note = -1) {
  state.notesOpen = open;
  selected = -1;
  selectedPoint = -1;
  selectedNote = open ? note : -1;
  selectedVibrato = false;
  selectedType = -1;
  persist();
  render();
}

const semitoneText = (semis: number) => (semis > 0 ? `+${semis}` : semis < 0 ? `−${-semis}` : '0');

/** Opens or closes the waveform rows under the volume envelope, selecting a bar or none. */
function openWaves(open: boolean, bar = -1) {
  state.waveOpen = open;
  selected = open ? bar : -1;
  selectedPoint = -1;
  selectedNote = -1;
  selectedVibrato = false;
  selectedType = -1;
  persist();
  render();
}

function areaPath(curve: Float32Array, from: number, to: number): string {
  const pts: string[] = [];
  const last = Math.min(curve.length - 1, Math.round(to * ENV_STEPS));
  for (let i = Math.round(from * ENV_STEPS); i <= last; i++) pts.push(`${x(i / ENV_STEPS).toFixed(1)},${plotY(curve[i]).toFixed(1)}`);
  return pts.length ? `M${pts.join('L')}` : '';
}

function drawVolume(curve: Float32Array) {
  if (!state.volumeOpen) {
    drawVolumePreview(curve);
    drawWaveBand();
    return;
  }
  const s = shape();
  const a = s.ad >> 4;
  const end = releaseEnd(s.ad, s.sr, keyUp());
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

  // Labels are centred over (or under) their dot, kept inside the timeline;
  // or to one side, to keep clear of a neighbour's
  const text = (parent: Element, cx: number, y: number, content: string, side: 'left' | 'right' | null = null) => {
    const half = content.length * 3.3 + 2;
    const at = side === 'left' ? cx - 10 - half : side === 'right' ? cx + 10 + half : cx;
    const t = el('text', { x: Math.max(half, Math.min(x(TOTAL) + ORIGIN - half, at)), y, 'text-anchor': 'middle' }, parent);
    t.textContent = content;
  };
  // Low down, sustain's label sits above its dot, beside release's: apart if the dots are close
  const sustainLow = s.sr >> 4 <= 2;
  const crowded = sustainLow && x(handlePos('r', s.ad, s.sr).f) - x(keyUp()) < 90;
  const above = (v: number) => plotY(v) - 12;
  const below = (v: number) => plotY(v) + 21;
  drawWaveBand();

  // Attack, decay and release are times: dots that move sideways, labelled
  // above. Sustain is a level, its dot at the key going up: up and down
  // sets the level, sideways the key up; labelled below.
  for (const key of ['a', 'd', 'r', 's']) {
    const p = handlePos(key, s.ad, s.sr);
    const label = handleText(key, s.ad, s.sr);
    const held = free?.key === key;
    const upDown = key === 's';
    const g = el('g', { class: `env-handle${held ? ' held' : ''}`, 'data-drag': key, tabindex: 0, role: 'slider', 'aria-label': label }, plot);
    el('circle', { cx: x(p.f), cy: plotY(p.v), r: 13, class: 'hit' }, g);
    el('circle', { cx: x(p.f), cy: plotY(p.v), r: 6, class: 'dot' }, g);
    if (!held) arrows(g, x(p.f), plotY(p.v), upDown ? 'all' : 'side');
    // Sustain's label goes under its dot, clear of the down arrow, unless
    // it is down by the waveform strip
    if (upDown) text(g, x(p.f), sustainLow ? above(p.v) : below(p.v) + 9, label, crowded ? 'left' : null);
    else text(g, x(p.f), above(p.v), label, key === 'r' && crowded ? 'right' : null);
    // The one in hand stays selected under the pointer, with the ways it moves
    if (held) {
      const grip = el('g', { class: 'env-grip' }, plot);
      el('circle', { cx: x(free!.f), cy: plotY(free!.v), r: 6, class: 'dot' }, grip);
      arrows(grip, x(free!.f), plotY(free!.v), upDown ? 'all' : 'side');
    }
  }
}

/** Little arrows round a handle for the ways it moves: sideways, or all four ways. */
function arrows(parent: Element, cx: number, cy: number, ways: 'side' | 'all') {
  const g = el('g', { class: 'env-arrows' }, parent);
  const at = (dx: number, dy: number, out: number) => {
    // A small triangle pointing away from the handle
    const tip = [cx + dx * (out + 6), cy + dy * (out + 6)];
    const base = [cx + dx * out, cy + dy * out];
    const side = [dy * 4, dx * 4];
    el('path', { d: `M${tip[0]},${tip[1]}L${base[0] + side[0]},${base[1] + side[1]}L${base[0] - side[0]},${base[1] - side[1]}Z` }, g);
  };
  at(-1, 0, 13);
  at(1, 0, 13);
  if (ways === 'all') {
    at(0, -1, 13);
    at(0, 1, 13);
  }
}

/** The volume envelope folded into a thin picture of its shape; clicking it opens it. */
function drawVolumePreview(curve: Float32Array) {
  const s = shape();
  const end = Math.min(TOTAL, releaseEnd(s.ad, s.sr, keyUp()) + 2);
  const py = (v: number) => RULER + 5 + (1 - v) * (VOLUME_PREVIEW - 10);
  const pts: string[] = [];
  for (let i = 0; i <= Math.min(curve.length - 1, Math.round(end * ENV_STEPS)); i++) pts.push(`${x(i / ENV_STEPS).toFixed(1)},${py(curve[i]).toFixed(1)}`);
  el('path', { d: `M${pts.join('L')}L${x(end)},${py(0)}L${x(0)},${py(0)}Z`, class: 'env-area' }, plot);
  el('path', { d: `M${pts.join('L')}`, class: 'env-line thin' }, plot);
  el('rect', { x: 0, y: RULER, width: x(TOTAL) + ORIGIN, height: VOLUME_PREVIEW, class: 'strip-hit', 'data-volume-strip': '' }, plot);
}

/** The line at silence, the waveform strip under it (which opens and closes the rows), and the rows if open. */
function drawWaveBand() {
  const top = floor();
  el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: top, y2: top, class: 'heard-rule' }, plot);
  drawHead(top);
  el('rect', { x: 0, y: top, width: x(TOTAL) + ORIGIN, height: PAD_BOTTOM, class: 'strip-hit', 'data-strip': '' }, plot);
  drawHeard(top + (PAD_BOTTOM - HEARD) / 2);
  if (state.waveOpen) drawBars();
  drawNotes();
  drawFilter();
}

const LINE_PAD = 6;

/** A section's band: its header, shaded across like its name beside it (and over the grid) */
function drawHead(top: number, h = PAD_BOTTOM) {
  if (!plot.querySelector('#head-fade')) {
    const fade = el('linearGradient', { id: 'head-fade', x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, plot));
    el('stop', { offset: 0, class: 'head-fade-top' }, fade);
    el('stop', { offset: 1, class: 'head-fade-bottom' }, fade);
  }
  el('rect', { x: 0, y: top, width: x(TOTAL) + ORIGIN, height: h, fill: 'url(#head-fade)' }, plot);
}

/**
 * The filter: its band opens or closes it, showing the cutoff over time as
 * a thin line (or that there is no filter) while closed; open, the cutoff
 * as a line of points to drag, like pulse width.
 */
function drawFilter() {
  const s = shape();
  const top = filterTop();
  el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: top, y2: top, class: 'heard-rule' }, plot);
  drawHead(top);
  el('rect', { x: 0, y: top, width: x(TOTAL) + ORIGIN, height: PAD_BOTTOM, class: 'strip-hit', 'data-filter-strip': '' }, plot);
  // Folded, the band previews the cutoff (open, its rows show it)
  if (!state.filterOpen && !s.filter.types.length) {
    el('text', { x: x(0) + 8, y: top + PAD_BOTTOM / 2 + 4, class: 'vib-hint' }, plot).textContent = 'No filter';
  } else if (!state.filterOpen) {
    // The cutoff, where it filters, coming round with the repeat
    const py = (v: number) => top + LINE_PAD + (1 - v / CUTOFF_MAX) * (PAD_BOTTOM - 2 * LINE_PAD);
    const rep = filterRepeat();
    const on = stayingOn(s.filter);
    const filtering = (f: number) => (on !== null && f >= on.start) || s.filter.types.some((c) => c.start <= f && (f < c.end || (rep !== null && f === rep.to && c.end === rep.to)));
    let pts: string[] = [];
    const flush = () => {
      if (pts.length > 1) el('polyline', { points: pts.join(' '), class: 'cutoff-preview' }, plot);
      pts = [];
    };
    for (let f = 0; f <= TOTAL; f++) {
      const from = filterSource(f);
      if (filtering(from)) pts.push(`${x(f).toFixed(1)},${py(lineAt(s.filter.cutoff, from)).toFixed(1)}`, `${x(f + 1).toFixed(1)},${py(lineAt(s.filter.cutoff, from)).toFixed(1)}`);
      else flush();
    }
    flush();
  }
  // The types first: the shared repeat's bars and the lines' points go over them
  if (state.filterOpen) drawTypes();
  for (const key of ['cutoff', 'resonance'] as const) {
    const l = lane(key);
    if (!l) continue;
    el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: l.top, y2: l.top, class: 'lane-line' }, plot);
    drawLine(l);
  }
  renderFilterControls();
}

/** The filter's repeat (the cutoff's, shared by type and resonance), if it has one */
function filterRepeat(): { from: number; to: number } | null {
  const c = shape().filter.cutoff;
  if (c.loop === null || c.loop >= c.points.length - 1) return null;
  return { from: c.points[c.loop].t, to: c.points[c.points.length - 1].t };
}

/** The frame whose settings play at a frame: past the repeat's end, the one it comes round to */
function filterSource(f: number): number {
  const r = filterRepeat();
  if (!r || f <= r.to || r.to <= r.from) return f;
  return r.from + ((f - r.to - 1) % (r.to - r.from)) + 1;
}

/** The type row: a capsule for each type from its change to the next, showing its shape */
function drawTypes() {
  const f = shape().filter;
  const top = typeTop();
  el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: top, y2: top, class: 'lane-line' }, plot);
  if (!f.types.length) el('text', { x: x(0) + 8, y: top + TYPE_H / 2 + 4, class: 'vib-hint' }, plot).textContent = 'Drag along here to filter this stretch of the sound';
  // As the filter's repeat comes round, its chunks come round too (faint)
  const rep = filterRepeat();
  if (rep && rep.to > rep.from) {
    const period = rep.to - rep.from;
    for (let n = 1; rep.to + (n - 1) * period < TOTAL; n++) {
      for (const c of f.types) {
        // (a chunk ending on the repeat's end plays its last frame too)
        const a = Math.max(c.start, rep.from + 1);
        const z = Math.min(c.end === rep.to ? c.end + 1 : c.end, rep.to + 1);
        if (z <= a) continue;
        el('rect', { x: x(a + n * period) + 1, y: top + 5, width: Math.max(1, x(z + n * period) - x(a + n * period) - 2), height: TYPE_H - 10, rx: 6, class: 'type-body ghost' }, plot);
      }
    }
  }
  // The filter staying on after its last stretch (faint, to the end)
  const on = stayingOn(f);
  if (on && on.end < TOTAL) el('rect', { x: x(on.end) + 1, y: top + 5, width: Math.max(1, x(TOTAL) - x(on.end) - 2), height: TYPE_H - 10, rx: 6, class: 'type-body ghost' }, plot);
  f.types.forEach((c, i) => {
    const x1 = x(c.start);
    const x2 = x(c.end);
    const g = el('g', { class: `filter-type${i === selectedType ? ' selected' : ''}`, 'data-type': i }, plot);
    el('rect', { x: x1 + 1, y: top + 5, width: Math.max(2, x2 - x1 - 2), height: TYPE_H - 10, rx: 6, class: 'type-body' }, g);
    if (x2 - x1 > 34) {
      const icon = modeIcon(c.passband, 26, 14);
      icon.setAttribute('x', String(x1 + 7));
      icon.setAttribute('y', String(top + TYPE_H / 2 - 7));
      g.append(icon);
    }
    if (x2 - x1 > 90) el('text', { x: x1 + 38, y: top + TYPE_H / 2 + 4, class: 'type-label' }, g).textContent = passbandText(c.passband);
    const grip = Math.min(EDGE, (x2 - x1) / 3);
    el('rect', { x: x1 - 3, y: top + 5, width: grip + 3, height: TYPE_H - 10, class: 'bar-edge', 'data-type-edge': 'start' }, g);
    el('rect', { x: x2 - grip, y: top + 5, width: grip + 3, height: TYPE_H - 10, class: 'bar-edge', 'data-type-edge': 'end' }, g);
  });
}

const PASSBAND_NAMES: [number, string][] = [
  [FILTER_LOW, 'Low'],
  [FILTER_BAND, 'Band'],
  [FILTER_HIGH, 'High'],
];

function passbandText(bits: number): string {
  if (bits === (FILTER_LOW | FILTER_HIGH)) return 'Notch';
  return PASSBAND_NAMES.filter(([b]) => bits & b).map(([, n]) => n).join(' + ') || 'Silent';
}

/** The filter at a frame, as the player has it (from the trace), for the scope */
let filterCache: { key: string; at: { passband: number; resonance: number; cutoff: number }[] } | null = null;
function heardFilter(upTo = 0): { passband: number; resonance: number; cutoff: number }[] | null {
  const a = audition();
  const key = JSON.stringify(a.tables[2] && [Array.from(a.tables[2].left), Array.from(a.tables[2].right)]);
  // (traced on as far as the playhead goes: a repeat keeps it changing)
  if (filterCache?.key === key && filterCache.at.length > upTo) return filterCache.at;
  const frames = Math.min(TOTAL, Math.max(Math.ceil(dataEnd() * 2) + 100, upTo + 200));
  const t = traceWith(a, frames);
  if (!t) return null;
  // Voice 1 not routed through the filter: it isn't filtered then
  filterCache = { key, at: Array.from({ length: frames }, (_, f) => ({ passband: t.routing[f] & 1 ? t.mode[f] & 0x70 : -1, resonance: t.routing[f] >> 4, cutoff: t.cutoff[f] })) };
  return filterCache.at;
}

/** The scope under the timeline, and the frame it shows: the playhead, else the pointer over the filter, else the start */
const scope = filterScope();
let scopeHover = -1;
function updateScope() {
  const f = playhead >= 0 ? playhead : scopeHover >= 0 ? scopeHover : (shape().filter.types[selectedType] ?? shape().filter.types[0])?.start ?? 0;
  const at = heardFilter(Math.round(f));
  if (!at) return;
  scope.set(at[Math.max(0, Math.min(at.length - 1, Math.round(f)))]);
}

/** Under the timeline while the filter is open (and filters somewhere): the scope. */
function renderFilterControls() {
  const box = $('filter-controls');
  box.hidden = !state.filterOpen || !shape().filter.types.length;
  box.replaceChildren();
  if (box.hidden) return;
  box.append(scope.el);
  updateScope();
}

/**
 * The notes: their band opens or closes them, showing the pitch over time
 * as a thin line while closed; open, a roll of semitones from the note played,
 * with the notes as bars to draw, move and resize like the waveform's.
 */
function drawNotes() {
  const s = shape();
  const top = notesTop();
  el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: top, y2: top, class: 'heard-rule' }, plot);
  drawHead(top);
  el('rect', { x: 0, y: top, width: x(TOTAL) + ORIGIN, height: PAD_BOTTOM, class: 'strip-hit', 'data-notes-strip': '' }, plot);
  // Folded, the band previews the pitch as a thin line (open, the roll shows it)
  if (!state.notesOpen) {
    const py = (semis: number) => top + LINE_PAD + ((rollHigh() - Math.max(state.rollLow, Math.min(rollHigh(), semis))) / ROLL_SPAN) * (PAD_BOTTOM - 2 * LINE_PAD);
    el('line', { x1: x(0), x2: x(TOTAL), y1: py(0), y2: py(0), class: 'notes-zero' }, plot);
    // (gliding into a pitch, a slope from the one before)
    heardSpans(s, TOTAL).forEach((sp, k, all) => {
      const glide = s.notes.find((n) => n.start === sp.from)?.glide ?? 0;
      const from = Math.min(sp.start + glide, sp.end ?? TOTAL);
      const cls = `notes-line${sp.again ? ' again' : ''}`;
      if (glide && all[k - 1]?.end === sp.start) el('line', { x1: x(sp.start), x2: x(from), y1: py(all[k - 1].pitch), y2: py(sp.pitch), class: cls }, plot);
      el('line', { x1: x(from), x2: x(sp.end ?? TOTAL), y1: py(sp.pitch), y2: py(sp.pitch), class: cls }, plot);
    });
    return;
  }

  const roll = rollTop();
  for (let semis = state.rollLow; semis <= rollHigh(); semis += 12) {
    el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: noteY(semis) + SEMI / 2, y2: noteY(semis) + SEMI / 2, class: `roll-line${semis === 0 ? ' zero' : ''}` }, plot);
  }
  // The shared repeat runs through the notes too (its ↻ here when the waveform rows are closed)
  const icon = drawWaveRepeat(roll, roll + ROLL_H, true, false);
  // What's drawn in the roll stays in it: steps out of sight are cut off at its edges
  const firstInRoll = plot.childNodes.length;
  // The pitch all the way through, one continuous line of steps: the key
  // played until the first change, then each pitch until the next (its
  // repeats faint)
  const spansHeard = heardSpans(s, TOTAL).filter((sp) => sp.wave || sp.end !== null);
  // One step per pitch: changes of waveform alone don't split it
  const steps: HeardSpan[] = [];
  for (const sp of spansHeard) {
    const last = steps[steps.length - 1];
    if (last && last.pitch === sp.pitch && !!last.again === !!sp.again && last.end === sp.start) last.end = sp.end;
    else steps.push({ ...sp });
  }
  // A step reached by a glide starts after it, the glide a slope up to it from the pitch before
  steps.forEach((sp, k) => {
    const glide = s.notes.find((n) => n.start === sp.from)?.glide ?? 0;
    const from = Math.min(sp.start + glide, sp.end ?? TOTAL);
    const x2 = x(sp.end ?? TOTAL);
    el('rect', { x: x(from), y: noteY(sp.pitch) + 0.5, width: Math.max(1, x2 - x(from)), height: SEMI - 1, rx: 2, class: `note${sp.again ? ' ghost' : ''}` }, plot);
    if (glide) {
      const before = steps[k - 1]?.end === sp.start ? steps[k - 1].pitch : 0;
      const [y1, y2] = [noteY(before) + 0.5, noteY(sp.pitch) + 0.5];
      const [g1, g2] = [x(sp.start), x(from)];
      el('path', { d: `M${g1},${y1}L${g2},${y2}L${g2},${y2 + SEMI - 1}L${g1},${y1 + SEMI - 1}Z`, class: `note glide${sp.again ? ' ghost' : ''}` }, plot);
    }
  });
  // Each change, to grab: its step to move in time and pitch, its start
  // (where it arrives) and end (where the next sets off) to move in time
  const lastEnd = spansHeard.filter((sp) => !sp.again).at(-1)?.end ?? null;
  // The key played's step, before the first change: only its end to grab (the first change's start)
  if (s.notes[0]?.start > 0) {
    const x2 = x(s.notes[0].start);
    const grip = Math.min(EDGE, (x2 - x(0)) / 3);
    const y = noteY(steps[0]?.pitch ?? 0);
    const g = el('g', { class: 'note-bar', 'data-note': -1 }, plot);
    el('rect', { x: x2 - grip, y: y - 3, width: grip + 3, height: SEMI + 6, class: 'bar-edge', 'data-note-edge': 'end' }, g);
  }
  s.notes.forEach((note, i) => {
    const next = s.notes[i + 1]?.start ?? lastEnd ?? TOTAL;
    const x1 = x(arrival(note));
    const x2 = x(Math.max(arrival(note) + 1, next));
    const y = noteY(note.semis);
    const g = el('g', { class: `note-bar${i === selectedNote ? ' selected' : ''}`, 'data-note': i }, plot);
    el('rect', { x: x1, y: y - 3, width: x2 - x1, height: SEMI + 6, class: 'hit' }, g);
    if (i === selectedNote) el('rect', { x: x1, y: y + 0.5, width: x2 - x1, height: SEMI - 1, rx: 2, class: 'note picked' }, g);
    const grip = Math.min(EDGE, (x2 - x1) / 3);
    el('rect', { x: x1 - 3, y: y - 3, width: grip + 3, height: SEMI + 6, class: 'bar-edge', 'data-note-edge': 'start' }, g);
    // Its end is the next change: grabbed here too
    if (s.notes[i + 1]) el('rect', { x: x2 - grip, y: y - 3, width: grip + 3, height: SEMI + 6, class: 'bar-edge', 'data-note-edge': 'end' }, g);
    el('text', { x: x1 + 3, y: y - 2, class: 'note-label' }, g).textContent = note.fixed && s.fixedNote === null ? noteName(FIXED_BASE + note.semis) : semitoneText(note.semis);
  });
  // The pitch as the player makes it, frame by frame: vibrato and all
  const heard = heardPitch();
  if (heard) {
    // Only while there is sound: on to the end holding or repeating, else to where it falls silent
    const end = programEnd(s);
    const until = end === null || s.hold || waveLooping(s) ? TOTAL : end;
    const pts: string[] = [];
    heard.forEach((semis, f) => {
      if (f >= until) return;
      const y = noteY(Math.max(state.rollLow - 0.5, Math.min(rollHigh() + 0.5, semis))) + SEMI / 2;
      pts.push(`${x(f).toFixed(1)},${y.toFixed(1)}`, `${x(f + 1).toFixed(1)},${y.toFixed(1)}`);
    });
    el('polyline', { points: pts.join(' '), class: 'pitch-trace' }, plot);
  }
  const clip = el('clipPath', { id: 'roll-clip' }, plot);
  el('rect', { x: 0, y: roll, width: x(TOTAL) + ORIGIN, height: ROLL_H }, clip);
  const inRoll = el('g', { 'clip-path': 'url(#roll-clip)' }, plot);
  inRoll.append(...Array.from(plot.childNodes).slice(firstInRoll, -2));
  icon();
  drawVibrato();
}

/** The pitch the player makes each frame, in semitones from the key played (cached; null until the engine is ready). */
let heardCache: { key: string; pitch: number[] } | null = null;
function heardPitch(): number[] | null {
  const a = audition();
  const frames = Math.min(TOTAL, Math.ceil(dataEnd() * 2) + 100);
  const key = JSON.stringify([a.tables.map((t) => [Array.from(t.left), Array.from(t.right)]), a.instrument, test.note, frames, ntsc]);
  if (heardCache?.key === key) return heardCache.pitch;
  const t = traceWith(a, frames);
  if (!t) return null;
  const base = freqOf(test.note);
  heardCache = { key, pitch: Array.from(t.freq, (f) => (f ? 12 * Math.log2(f / base) : 0)) };
  return heardCache.pitch;
}

const DEFAULT_WOBBLE: Wobble = { turn: 3, even: true, depth: 3 };

/**
 * Where vibrato first moves the pitch with a delay setting, measured: the
 * player counts the delay only on frames it runs effects (not on a song
 * row's first tick, nor where the wave program sets the pitch), so it is
 * played silently with and without. Null if it never shows.
 */
const startCache = new Map<string, number | null>();
function vibratoStart(delay: number, s: Shape = shape()): number | null {
  if (!s.vibrato) return null;
  const a = audition(s);
  const frames = Math.min(TOTAL, delay * 2 + 60);
  const key = JSON.stringify([a.tables.map((t) => [Array.from(t.left), Array.from(t.right)]), a.instrument, delay, frames, ntsc]);
  if (startCache.has(key)) return startCache.get(key)!;
  const plain = traceWith({ ...a, instrument: { ...a.instrument, vibratoDelay: 0 } }, frames);
  const wobbly = traceWith({ ...a, instrument: { ...a.instrument, vibratoDelay: delay } }, frames);
  if (!plain || !wobbly) return null;
  const at = wobbly.freq.findIndex((f, i) => f !== plain.freq[i]);
  if (startCache.size > 2000) startCache.clear();
  startCache.set(key, at < 0 ? null : at);
  return at < 0 ? null : at;
}

/** The delay setting whose vibrato starts nearest a frame. */
function delayFor(frame: number, s: Shape = shape()): number {
  let lo = 1;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = vibratoStart(mid, s);
    if (at !== null && at < frame) lo = mid + 1;
    else hi = mid;
  }
  const before = lo > 1 ? vibratoStart(lo - 1, s) : null;
  const here = vibratoStart(lo, s);
  if (before !== null && here !== null && frame - before < here - frame) return lo - 1;
  return lo;
}

/** Where to draw the vibrato's start: as measured, or (where it never shows) as the delay would be in frames */
function vibratoFrom(): number {
  const v = shape().vibrato!;
  return vibratoStart(v.delay) ?? Math.round((v.delay * 6) / 5);
}

/** The vibrato lane: a bar from where it starts, with the wobble drawn in it; drawn on to add one. */
function drawVibrato() {
  const s = shape();
  const top = vibTop();
  el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: top, y2: top, class: 'lane-line' }, plot);
  if (!s.vibrato) {
    el('text', { x: x(0) + 8, y: top + VIB_H / 2 + 4, class: 'vib-hint' }, plot).textContent = 'Drag along here to add vibrato from where you start';
    return;
  }
  const from = vibratoFrom();
  // It lasts as the sound does: on to the end holding or repeating, else to where it falls silent
  const end = programEnd(s);
  const until = end === null || s.hold || waveLooping(s) ? TOTAL : Math.max(from + 1, end);
  const g = el('g', { class: `vib${selectedVibrato ? ' selected' : ''}`, 'data-vib': '' }, plot);
  el('rect', { x: x(from), y: top + 5, width: x(until) - x(from), height: VIB_H - 10, rx: 5, class: 'vib-body' }, g);
  // Its shape: a semitone either way fills the bar
  const curve = vibratoCurve(s.vibrato, test.note, 1, Math.max(1, until - from));
  const mid = top + VIB_H / 2;
  const amp = (VIB_H - 14) / 2;
  const pts = Array.from(curve, (v, i) => `${x(from + i).toFixed(1)},${(mid - Math.max(-1, Math.min(1, v)) * amp).toFixed(1)}`);
  el('polyline', { points: pts.join(' '), class: 'vib-wave' }, g);
  el('rect', { x: x(from) - 4, y: top + 5, width: 9, height: VIB_H - 10, class: 'bar-edge', 'data-vib-edge': '' }, g);
  if (vibratoStart(s.vibrato.delay) === null) el('title', {}, g).textContent = 'Not heard: the pitch is set every frame here (a repeating pitch), which restarts the vibrato';
}

/**
 * What is heard: the waveform each stretch of time adds up to, as a strip
 * from `top`. Clicking a stretch opens the rows with its bar picked.
 */
function drawHeard(top: number) {
  const defs = el('defs', {}, plot);
  // Pulse drawn at its width at each moment
  const line = pulseLine(shape().pulse, TOTAL);
  const pulseWidth = (px: number) => widthOn(line, (px - ORIGIN) / state.zoom) / PULSE_MAX;
  // One piece per waveform: changes of pitch alone don't split it
  const pieces: HeardSpan[] = [];
  for (const sp of heardSpans(shape(), TOTAL)) {
    const last = pieces[pieces.length - 1];
    if (last && last.wave === sp.wave && !!last.again === !!sp.again && last.end === sp.start) last.end = sp.end;
    else pieces.push({ ...sp });
  }
  for (const sp of pieces) {
    // Silence shows as nothing
    if (!sp.wave) continue;
    const x1 = x(sp.start);
    const x2 = x(sp.end ?? TOTAL);
    // Coloured like its bars; a mix shades from one row's colour to the
    // next, top to bottom, as the rows are stacked
    const waves = LANES.filter((w) => sp.wave & w);
    const g = el('g', { class: `heard ${LANE_COLORS[waves[0]]}${sp.again ? ' again' : ''}`, 'data-span': sp.from }, plot);
    const rect = el('rect', { x: x1 + 1, y: top + 4, width: Math.max(1, x2 - x1 - 2), height: HEARD - 8, rx: 4 }, g);
    // The waveform drawn along it, start to finish
    const line = x2 - x1 > 8 ? el('polyline', { points: waveRun(sp.wave, x1 + 4, top + 7, x2 - x1 - 8, HEARD - 14, 12, pulseWidth), class: 'heard-wave' }, g) : null;
    if (waves.length > 1) {
      const id = `mix-${top}-${sp.wave}`;
      if (!defs.querySelector(`#${id}`)) {
        const grad = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        waves.forEach((w, i) => el('stop', { offset: i / (waves.length - 1), style: `stop-color: var(--${LANE_COLORS[w]})` }, grad));
      }
      rect.setAttribute('style', `fill: url(#${id}); stroke: url(#${id})`);
      line?.setAttribute('style', `stroke: url(#${id})`);
    }
  }
}

/** Where an envelope handle sits for some settings. */
function handlePos(key: string, ad: number, sr: number): { f: number; v: number } {
  const [a, d, sus] = [ad >> 4, ad & 15, sr >> 4];
  if (key === 'a') return { f: attackFrames(a), v: 1 };
  if (key === 'd') return { f: decayEnd(a, d, sus), v: sus / 15 };
  // At the level held, where the key goes up
  if (key === 's') return { f: keyUp(), v: sus / 15 };
  // Silent by the key going up, there is nothing to release: the dot sits a whole release on
  // from it (still setting how a note let go sooner fades)
  const end = releaseEnd(ad, sr, keyUp());
  return { f: end > keyUp() ? end : keyUp() + realFrames(DECAY_MS[sr & 15]), v: 0 };
}

function handleText(key: string, ad: number, sr: number): string {
  if (key === 'a') return envText.a(ad >> 4);
  if (key === 'd') return envText.d(ad & 15);
  if (key === 's') return envText.s(sr >> 4);
  return envText.r(sr & 15);
}

const LANE_COLORS: Record<number, string> = { [WAVE_TRI]: 'tri', [WAVE_SAW]: 'saw', [WAVE_PULSE]: 'pulse', [WAVE_NOISE]: 'noise' };

/** The waveform rows, and the bars in them. */
function drawBars() {
  const s = shape();
  for (const row of rows()!) el('line', { x1: 0, x2: x(TOTAL) + ORIGIN, y1: row.top, y2: row.top, class: 'lane-line' }, plot);
  const widthLane = lane('pulse');
  if (widthLane) drawLine(widthLane);
  // The waveform rows run together from the top, the width row below them
  const waveRows = rows()!.filter((r) => r.wave !== null);
  const icon = drawWaveRepeat(waveRows[0].top, waveRows[waveRows.length - 1].top + waveRows[waveRows.length - 1].h, true);
  s.bars.forEach((b, i) => {
    const r = rowOf(b.wave);
    const x1 = x(b.start);
    const x2 = x(b.end ?? TOTAL);
    const y = r.top + 5;
    const h = r.h - 10;
    const g = el('g', { class: `bar ${LANE_COLORS[b.wave]}${i === selected ? ' selected' : ''}`, 'data-bar': i }, plot);
    el('rect', { x: x1, y, width: Math.max(2, x2 - x1), height: h, rx: 5, class: 'bar-body' }, g);
    if (x2 - x1 > 44) el('text', { x: x1 + 8, y: y + h / 2 + 4, class: 'bar-label' }, g).textContent = timeText((b.end ?? TOTAL) - b.start);
    el('rect', { x: x1 - 2, y, width: Math.min(EDGE, (x2 - x1) / 3) + 2, height: h, class: 'bar-edge', 'data-edge': 'start' }, g);
    if (b.end !== null) el('rect', { x: x2 - Math.min(EDGE, (x2 - x1) / 3), y, width: Math.min(EDGE, (x2 - x1) / 3) + 2, height: h, class: 'bar-edge', 'data-edge': 'end' }, g);
  });
  // Holding: what plays at the end carries on in its rows, to the end
  const end = programEnd(s);
  if (end !== null && s.hold && !waveLooping(s)) {
    const last = stretches(s).at(-1)!;
    for (const wave of LANES) {
      if (!(last.wave & wave)) continue;
      const r = rowOf(wave);
      el('rect', { x: x(end), y: r.top + 5, width: x(TOTAL) - x(end), height: r.h - 10, class: `bar-body held ${LANE_COLORS[wave]}` }, plot);
    }
  }
  // The repeat's ↻ goes over the bars, so it can always be grabbed
  icon();
}


/**
 * The waveform's repeat, under the bars: the section that repeats shaded in
 * each waveform row, its repeats faint after it, and its two ends as bars
 * to drag; or with no repeat, its start waiting at the end to be pulled
 * back. Returns a function that draws the ↻ over the bars.
 */
function drawWaveRepeat(top: number, bottom: number, withIcons: boolean, ghostBars = true): () => void {
  const s = shape();
  const end = programEnd(s);
  if (end === null) return () => {};
  const edge = (at: number, which: string, cls = '') => {
    const g = el('g', { class: `width-loop-edge wave ${cls}${dragging === which ? ' dragging' : ''}`, [`data-${which}-edge`]: '' }, plot);
    el('rect', { x: x(at) - 6, y: top, width: 12, height: bottom - top, class: 'hit' }, g);
    el('rect', { x: x(at) - 1.5, y: top + 2, width: 3, height: bottom - top - 4, rx: 1.5, class: 'edge-bar' }, g);
    return g;
  };
  if (!waveLooping(s)) {
    // At the end: ↻ to pull a repeat out, and → to hold there or not
    edge(end, 'wave-loop', 'pull');
    if (s.hold) {
      el('rect', { x: x(end), y: top + 1, width: x(TOTAL) - x(end), height: bottom - top - 2, class: 'wave-hold' }, plot);
    }
    return () => {
      if (!withIcons) return;
      const g = el('g', { class: 'width-loop-edge wave icon', 'data-wave-loop-edge': '' }, plot);
      el('rect', { x: x(end) - 18, y: top, width: 16, height: 16, class: 'hit' }, g);
      el('text', { x: x(end) - 4, y: top + 12, 'text-anchor': 'end', class: 'wave-repeat' }, g).textContent = '↻';
      const h = el('g', { class: `wave-hold-toggle${s.hold ? ' on' : ''}`, 'data-hold': '' }, plot);
      el('rect', { x: x(end) + 2, y: top, width: 18, height: 16, class: 'hit' }, h);
      el('text', { x: x(end) + 5, y: top + 12, class: 'wave-repeat' }, h).textContent = '→';
      el('title', {}, h).textContent = s.hold ? 'Holds where it got to until the note ends: click to fall silent instead' : 'Falls silent here: click to hold where it got to until the note ends';
    };
  }
  const from = s.waveLoop!;
  const period = end - from;
  for (let t = end; t < TOTAL; t += period) el('rect', { x: x(t), y: top + 1, width: Math.min(x(TOTAL), x(t + period)) - x(t), height: bottom - top - 2, class: 'wave-loop again' }, plot);
  el('rect', { x: x(from), y: top + 1, width: x(end) - x(from), height: bottom - top - 2, class: 'wave-loop' }, plot);
  // The bars and notes as they come round again, faint
  for (let n = 1; ghostBars && end + (n - 1) * period < TOTAL; n++) {
    for (const b of s.bars) {
      const a = Math.max(b.start, from);
      const z = Math.min(b.end!, end);
      if (z <= a) continue;
      const r = rowOf(b.wave);
      el('rect', { x: x(a + n * period), y: r.top + 5, width: x(z + n * period) - x(a + n * period), height: r.h - 10, rx: 5, class: `bar-body ghost ${LANE_COLORS[b.wave]}` }, plot);
    }
  }
  // (its label is the start's handle too)
  const start = edge(from, 'wave-loop');
  if (withIcons) repeatLabel(start, x(from), top, 'wave-repeat');
  edge(end, 'wave-loop-end');
  return () => {};
}

/** A repeat's "↻ repeat" label, beside its start and part of its handle */
function repeatLabel(handle: SVGGElement, at: number, top: number, cls: string) {
  el('rect', { x: at + 6, y: top + 1, width: 58, height: 15, class: 'hit' }, handle);
  el('text', { x: at + 10, y: top + 12, class: cls }, handle).textContent = '↻ repeat';
}

const WIDTH_PAD = 7;

/** The two lines of points over time: pulse width (under the pulse row) and the filter's cutoff. */
type LineKey = 'pulse' | 'cutoff' | 'resonance';

interface LineLane {
  key: LineKey;
  top: number;
  h: number;
  max: number;
  line: PulseShape;
  /** What a value is called, e.g. "Pulse width 50%" */
  text: (v: number) => string;
  /** A level marked across it (a square wave's width) */
  mid: number | null;
  /** Whether it has a repeat of its own (resonance shares the cutoff's) */
  repeat: boolean;
}

const percentText = (v: number, max: number) => `${Math.round((v / max) * 100)}%`;

/** A line's row, if it is shown. */
function lane(key: LineKey): LineLane | null {
  const s = shape();
  if (key === 'pulse') {
    const r = rows()?.find((row) => row.wave === null);
    return r ? { key, top: r.top, h: r.h, max: PULSE_MAX, line: s.pulse, text: (v) => `Pulse width ${percentText(v, PULSE_MAX)}`, mid: SQUARE, repeat: true } : null;
  }
  if (!state.filterOpen) return null;
  if (key === 'resonance') {
    return { key, top: resTop(), h: RES_H, max: RESONANCE_MAX, line: s.filter.resonance, text: (v) => `Resonance ${Math.round(v)} of 15`, mid: null, repeat: false };
  }
  return { key, top: cutoffTop(), h: CUTOFF_H, max: CUTOFF_MAX, line: s.filter.cutoff, text: (v) => `Cutoff ${percentText(v, CUTOFF_MAX)}`, mid: null, repeat: true };
}

const laneY = (l: LineLane, v: number) => l.top + WIDTH_PAD + (1 - v / l.max) * (l.h - 2 * WIDTH_PAD);

function laneValue(l: LineLane, e: PointerEvent): number {
  const v = 1 - (yAt(e) - l.top - WIDTH_PAD) / (l.h - 2 * WIDTH_PAD);
  return Math.round(Math.max(0, Math.min(1, v)) * l.max);
}

/** The line under the pointer, or whose handle was grabbed */
function laneUnder(target: Element, e: PointerEvent): LineLane | null {
  const key = target.closest<SVGElement>('[data-line]')?.dataset.line as LineKey | undefined;
  if (key) return lane(key);
  for (const k of ['pulse', 'cutoff', 'resonance'] as const) {
    const l = lane(k);
    if (l && yAt(e) >= l.top && yAt(e) < l.top + l.h) return l;
  }
  return null;
}

/** Which line the selected point is on */
let selectedLine: LineKey = 'pulse';

/**
 * A line of points (pulse width or cutoff): strong up to its last point,
 * its repeats light, with the points to drag and the repeat marked.
 */
function drawLine(r: LineLane) {
  const plot = el('g', { class: `line-${r.key}` }, document.getElementById('plot')!);
  const width = x(TOTAL) + ORIGIN;
  const { points } = r.line;
  const loop = r.repeat ? r.line.loop : null;
  // The cutoff's repeat is the whole filter's (one program): it spans type,
  // cutoff and resonance
  const span = r.key === 'cutoff' ? { top: typeTop(), h: resTop() + RES_H - typeTop() } : { top: r.top, h: r.h };
  // The repeat: the section that repeats shaded, its repeats fainter after
  // it, and its start an edge to drag from point to point
  if (loop !== null && loop < points.length - 1) {
    const from = points[loop].t;
    const to = points[points.length - 1].t;
    const period = to - from;
    for (let t = to; t < TOTAL && period > 0; t += period) {
      el('rect', { x: x(t), y: span.top + 1, width: Math.min(x(TOTAL), x(t + period)) - x(t), height: span.h - 2, class: 'width-loop again' }, plot);
    }
    el('rect', { x: x(from), y: span.top + 1, width: x(to) - x(from), height: span.h - 2, class: 'width-loop' }, plot);
    // Both ends drag: the start from point to point (its label too), the end in time
    for (const [at, which] of [
      [from, 'loop'],
      [to, 'loop-end'],
    ] as const) {
      const edge = el('g', { class: `width-loop-edge${dragging === which ? ' dragging' : ''}`, [`data-${which}-edge`]: '', 'data-line': r.key }, plot);
      el('rect', { x: x(at) - 6, y: span.top, width: 12, height: span.h, class: 'hit' }, edge);
      el('rect', { x: x(at) - 1.5, y: span.top + 2, width: 3, height: span.h - 4, rx: 1.5, class: 'edge-bar' }, edge);
      if (which === 'loop') repeatLabel(edge, x(from), span.top, 'width-repeat');
    }
  }
  if (r.mid !== null) el('line', { x1: 0, x2: width, y1: laneY(r, r.mid), y2: laneY(r, r.mid), class: 'width-square' }, plot);
  const line = (corners: { t: number; w: number }[]) => corners.map((p) => `${x(Math.min(TOTAL, p.t)).toFixed(1)},${laneY(r, p.w).toFixed(1)}`).join(' ');
  // The line as drawn, strong, holding after its last point; with a repeat,
  // the repeats after it light
  const looping = loop !== null && loop < points.length - 1;
  if (looping) el('polyline', { points: line(pulseLine(r.line, TOTAL)), class: 'width-line faint' }, plot);
  // Resonance under the filter's repeat: the line as far as the repeat goes (its steps show the rest)
  const shared = r.key === 'resonance' ? filterRepeat() : null;
  const drawn = shared ? pulseLine(r.line, TOTAL).filter((p) => p.t <= shared.to).concat([{ t: shared.to, w: lineAt(r.line, shared.to) }]) : null;
  el('polyline', { points: line(drawn ?? (looping ? points : pulseLine(r.line, TOTAL))), class: 'width-line' }, plot);
  // Resonance plays as steps (16 levels, no sweep): drawn as the steps it
  // takes, coming round again with the filter's repeat (lighter)
  if (r.key === 'resonance') {
    const loopEnd = filterRepeat()?.to ?? TOTAL;
    for (const [a, b, cls] of [
      [0, loopEnd, 'res-steps'],
      [loopEnd, TOTAL, 'res-steps again'],
    ] as const) {
      const stairs: string[] = [];
      for (let f = a; f <= b; f++) {
        const v = Math.round(lineAt(r.line, filterSource(f)));
        stairs.push(`${x(f).toFixed(1)},${laneY(r, v).toFixed(1)}`, `${x(f + 1).toFixed(1)},${laneY(r, v).toFixed(1)}`);
      }
      el('polyline', { points: stairs.join(' '), class: cls }, plot);
    }
  }
  if (r.repeat && !looping && points.length > 1) {
    // No repeat yet: its start waits at the end, to be pulled back from there
    const at = x(points[points.length - 1].t);
    const pull = el('g', { class: 'width-loop-edge pull', 'data-loop-edge': '', 'data-line': r.key }, plot);
    // The bar and the ↻ at its top left both pull it (the last point on the bar is drawn over it)
    el('rect', { x: at - 6, y: span.top, width: 12, height: span.h, class: 'hit' }, pull);
    el('rect', { x: at - 1.5, y: span.top + 2, width: 3, height: span.h - 4, rx: 1.5, class: 'edge-bar' }, pull);
    el('rect', { x: at - 18, y: span.top, width: 16, height: 16, class: 'hit' }, pull);
    el('text', { x: at - 4, y: span.top + 12, 'text-anchor': 'end', class: 'width-repeat' }, pull).textContent = '↻';
    el('title', {}, pull).textContent = 'Drag left to repeat part of the line while the note is held';
  }
  points.forEach((p, i) => {
    const g = el('g', { class: `width-point${i === selectedPoint && selectedLine === r.key ? ' selected' : ''}`, 'data-point': i, 'data-line': r.key }, plot);
    // The last point sits on the repeat's bar: it takes hold only right on
    // it, so the bar around it can be grabbed
    el('circle', { cx: x(p.t), cy: laneY(r, p.w), r: i === points.length - 1 ? 7 : 11, class: 'hit' }, g);
    el('circle', { cx: x(p.t), cy: laneY(r, p.w), r: 5, class: 'dot' }, g);
  });
}

function renderReadout() {
  const box = $('readout');
  box.replaceChildren();
  const s = shape();
  if (state.notesOpen && selectedVibrato && s.vibrato) {
    vibratoReadout(box);
    return;
  }
  if (state.notesOpen && s.notes[selectedNote]) {
    const n = s.notes[selectedNote];
    const text = document.createElement('span');
    const from = s.fixedNote === null ? 'the note played' : noteName(s.fixedNote);
    const pitch =
      n.fixed && s.fixedNote === null
        ? noteName(FIXED_BASE + n.semis)
        : n.semis
          ? `${semitoneText(n.semis)} semitone${Math.abs(n.semis) === 1 ? '' : 's'}${s.fixedNote === null ? '' : ` (${noteName(s.fixedNote + n.semis)})`}`
          : from;
    text.textContent = `From ${timeText(n.start)}: ${pitch}${n.glide ? `, gliding there over ${timeText(n.glide)}` : ''}`;
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = 'Delete';
    del.addEventListener('click', deleteNote);
    box.append(text);
    // On its own, a step can be one pitch whatever key is played (a drum hit before a bass, say)
    if (s.fixedNote === null) {
      const label = document.createElement('label');
      label.className = 'step-fixed';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!n.fixed;
      input.addEventListener('change', () => {
        before();
        if (input.checked) n.fixed = true;
        else delete n.fixed;
        changed();
      });
      label.append(input, ` Fixed to ${noteName(FIXED_BASE + n.semis)}`);
      box.append(label);
    }
    box.append(del);
    return;
  }
  if (state.filterOpen && s.filter.types[selectedType]) {
    typeReadout(box);
    return;
  }
  if (lane(selectedLine)?.line.points[selectedPoint]) {
    pointReadout(box);
    return;
  }
  // The envelope's settings are on it already: only a selected bar has more to say
  if (!(state.waveOpen && s.bars[selected])) return;
  const b = s.bars[selected];
  if (!b) {
    box.textContent = s.bars.length ? 'Click a bar to change it.' : 'No waveform yet: the note is silent. Drag along a row to draw one.';
    return;
  }
  const text = document.createElement('span');
  text.textContent = `${waveName(b.wave)} from ${timeText(b.start)} for ${timeText((b.end ?? TOTAL) - b.start)}`;
  const del = document.createElement('button');
  del.className = 'mini danger';
  del.textContent = 'Delete';
  del.addEventListener('click', deleteSelected);
  box.append(text, del);
}

/** The vibrato: where it starts, its speed and depth, and deleting it. */
function vibratoReadout(box: HTMLElement) {
  const s = shape();
  const v = s.vibrato!;
  const from = vibratoStart(v.delay);
  const text = document.createElement('span');
  text.textContent = from === null ? 'Vibrato: not heard here (the pitch is set every frame)' : `Vibrato from ${timeText(from)}`;
  const size = () => vibratoSize(v, test.note);
  const outputs: (() => void)[] = [];
  const range = (label: string, value: number, min: number, max: number, show: () => string, set: (n: number) => void) => {
    const l = document.createElement('label');
    l.className = 'vib-slider';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    const out = document.createElement('output');
    out.textContent = show();
    outputs.push(() => (out.textContent = show()));
    let marked = false;
    input.addEventListener('input', () => {
      if (!marked) before();
      marked = true;
      set(Number(input.value));
      // The depth either way grows with the time between turns, so every readout follows
      for (const refresh of outputs) refresh();
      persist();
      sendToPlayer();
      // Not the controls: rebuilding them would pull the slider out from under the pointer
      render(true);
    });
    input.addEventListener('change', () => {
      marked = false;
      playShape();
    });
    l.append(label, input, out);
    return l;
  };
  // Fewer frames between turns is faster, so it runs backwards. The usual
  // ranges stretch to take in whatever a loaded song has.
  const speed = range('Speed', -v.turn, -Math.max(15, v.turn), -Math.min(1, v.turn), () => `${size().rate.toFixed(1)} a second`, (n) => (v.turn = -n));
  // The same on every note: fewer halvings of a semitone's step are deeper.
  // Wider on low notes: a fixed amount, whose size depends on the note.
  const depth = v.even
    ? range('Depth', -v.depth, -Math.max(8, v.depth), 0, () => `± ${pitchText(size().depth)}`, (n) => (v.depth = -n))
    : range('Depth', v.depth, Math.min(1, v.depth), 255, () => `± ${pitchText(size().depth)} on ${noteName(test.note)}`, (n) => (v.depth = n));
  const kind = document.createElement('div');
  kind.className = 'segmented small vib-kind';
  for (const [even, label, title] of [
    [true, 'Same on every note', 'The wobble is the same size on every note'],
    [false, 'Wider on low notes', 'A fixed amount, as GoatTracker usually has it: wider on low notes, narrower on high ones'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.classList.toggle('on', v.even === even);
    b.addEventListener('click', () => {
      if (v.even === even) return;
      before();
      Object.assign(v, convertWobble(v, even));
      changed();
      playShape();
    });
    kind.append(b);
  }
  const del = document.createElement('button');
  del.className = 'mini danger';
  del.textContent = 'Delete';
  del.addEventListener('click', deleteVibrato);
  box.append(text, speed, depth, kind, del);
}

/** The same vibrato the other way: the depth that comes closest on the test note. */
function convertWobble(w: Wobble, even: boolean): Wobble {
  if (w.even === even) return w;
  const want = vibratoSize(w, test.note).depth;
  let best = { ...w, even, depth: even ? 3 : 32 };
  const options = even ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : Array.from({ length: 255 }, (_, i) => i + 1);
  for (const depth of options) {
    const next = { ...w, even, depth };
    if (Math.abs(vibratoSize(next, test.note).depth - want) < Math.abs(vibratoSize(best, test.note).depth - want)) best = next;
  }
  return best;
}

function deleteVibrato() {
  const s = shape();
  if (!s.vibrato) return;
  before();
  s.vibrato = null;
  selectedVibrato = false;
  selectedType = -1;
  changed();
}

/** The selected chunk of filtering: switches for low, band and high (they combine), its shape, and deleting it. */
function typeReadout(box: HTMLElement) {
  const f = shape().filter;
  const c = f.types[selectedType];
  const text = document.createElement('span');
  text.textContent = `${passbandText(c.passband)} from ${timeText(c.start)} for ${timeText(c.end - c.start)}`;
  const del = document.createElement('button');
  del.className = 'mini danger';
  del.textContent = 'Delete';
  del.addEventListener('click', deleteType);
  box.append(text, ...passbandSwitches(c), del);
}

/** A chunk of filtering's switches for low, band and high (they combine), and its shape */
function passbandSwitches(c: FilterChunk): Element[] {
  const types = document.createElement('div');
  types.className = 'segmented small';
  for (const [bit, name] of PASSBAND_NAMES) {
    const b = document.createElement('button');
    b.textContent = name;
    b.classList.toggle('on', (c.passband & bit) !== 0);
    b.addEventListener('click', () => {
      before();
      c.passband ^= bit;
      changed();
      playShape();
    });
    types.append(b);
  }
  const icon = modeIcon(c.passband, 60, 26);
  icon.classList.add('type-shape');
  return [types, icon];
}

function deleteType() {
  const f = shape().filter;
  if (!f.types[selectedType]) return;
  before();
  f.types.splice(selectedType, 1);
  selectedType = -1;
  changed();
}

/** The selected point on a line: its value and time, and deleting it. */
function pointReadout(box: HTMLElement) {
  const l = lane(selectedLine)!;
  const i = selectedPoint;
  const p = l.line.points[i];
  const text = document.createElement('span');
  text.textContent = `${l.text(p.w)} at ${timeText(p.t)}`;
  box.append(text);
  // A cutoff or resonance point under a chunk of filtering: that chunk's switches too
  if (l.key !== 'pulse') {
    const f = shape().filter;
    const on = stayingOn(f);
    const under = chunkAt(f.types, p.t) ?? (on && p.t >= on.end ? on : null);
    if (under) box.append(...passbandSwitches(under));
  }
  if (i > 0) {
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = 'Delete';
    del.addEventListener('click', deletePoint);
    box.append(del);
  }
}

function deletePoint() {
  const pulse = lane(selectedLine)?.line;
  const i = selectedPoint;
  if (!pulse) return;
  if (i <= 0 || i >= pulse.points.length) return;
  before();
  pulse.points.splice(i, 1);
  if (pulse.loop !== null) {
    if (pulse.loop === i || pulse.loop >= pulse.points.length - 1) pulse.loop = null;
    else if (pulse.loop > i) pulse.loop--;
  }
  selectedPoint = -1;
  selectedNote = -1;
  selectedVibrato = false;
  selectedType = -1;
  changed();
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

/** The waveform of the row under the pointer, or the nearest waveform row to it (past the width row). */
function laneAt(e: PointerEvent): number {
  const y = yAt(e);
  const waves = rows()!.filter((r) => r.wave !== null);
  const near = (r: Row) => (y < r.top ? r.top - y : y > r.top + r.h ? y - r.top - r.h : 0);
  return waves.reduce((a, b) => (near(b) < near(a) ? b : a)).wave!;
}


// Over the filter, the scope shows the moment under the pointer
plot.addEventListener('pointermove', (e) => {
  if (!state.filterOpen || dragging) return;
  const y = yAt(e);
  const over = y >= filterTop() && y < height();
  const next = over ? Math.max(0, Math.round(frameAt(e))) : -1;
  if (next === scopeHover) return;
  scopeHover = next;
  updateScope();
});
plot.addEventListener('pointerleave', () => {
  if (scopeHover < 0) return;
  scopeHover = -1;
  updateScope();
});

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
  const span = target.closest<SVGGElement>('[data-span]');

  const strip = target.closest('[data-strip]');
  if (target.closest('[data-hold]')) {
    // After the end: hold where it got to, or fall silent
    before();
    s.hold = !s.hold;
    changed();
    playShape();
    return;
  } else if (target.closest('[data-notes-strip]')) {
    openNotes(!state.notesOpen);
    return;
  } else if (target.closest('[data-filter-strip]')) {
    openFilter(!state.filterOpen);
    return;
  } else if (target.closest('[data-volume-strip]')) {
    openVolume(true);
    return;
  } else if (span || strip) {
    // The waveform strip opens the rows (picking the bar clicked) or closes them
    const at = span ? Number(span.dataset.span) : -1;
    openWaves(!state.waveOpen, s.bars.findIndex((b) => b.start <= at && at < (b.end ?? Infinity)));
    return;
  } else if (handle) {
    const key = handle.dataset.drag!;
    dragging = key;
    // Selected from the moment it is grabbed
    if (key !== 'keyup') free = { key, ...handlePos(key, s.ad, s.sr) };
    grabOffset = start - keyUp();
    origin = key === 'a' ? s.ad >> 4 : key === 'd' ? s.ad & 15 : s.sr & 15;
    // Where the key goes up is a view setting, not part of the instrument (unless fixed)
    if (key !== 'keyup' || s.release !== null) before();
    move = (e) => dragHandle(key, e);
  } else if (target.closest('[data-wave-loop-edge]')) {
    // Where the waveform repeats from: on a place it changes, settling there
    // as the envelope's dots do. Pulled out from the end it makes a repeat
    // (and bars that kept going end there); pushed back onto the end, none.
    // With no repeat yet, waiting at the end, it also drags right: the bars ending there go on to it.
    before();
    const places = () => [...waveChanges(s), programEnd(s)!];
    const from = waveLooping(s) ? places().indexOf(s.waveLoop!) : places().length - 1;
    // (held where it was grabbed: the bar, or its label beside it)
    const grab = frameAt(e) - (waveLooping(s) ? s.waveLoop! : programEnd(s)!);
    const waiting = !waveLooping(s);
    const end = programEnd(s)!;
    const bars = s.bars;
    dragging = 'wave-loop';
    plot.style.cursor = 'ew-resize';
    move = (e) => {
      const t = frameAt(e) - grab;
      if (waiting && Math.round(t) > end) {
        const to = Math.min(TOTAL, Math.round(t));
        s.waveLoop = null;
        s.bars = bars.map((b) => (b.end === end ? { ...b, end: to } : b));
        render();
        return;
      }
      s.bars = bars;
      const p = places();
      const at = settleAt(p, t, from < 0 ? p.length - 1 : from);
      s.waveLoop = at < p.length - 1 ? p[at] : null;
      render();
    };
  } else if (target.closest('[data-wave-loop-end-edge]')) {
    // Where the waveform repeat ends: the bars ending there end with it,
    // never before the last change ahead of it
    before();
    let end = programEnd(s)!;
    const floor = Math.max(s.waveLoop!, ...waveChanges(s).filter((t) => t < end)) + 1;
    dragging = 'wave-loop-end';
    plot.style.cursor = 'ew-resize';
    move = (e) => {
      const to = Math.max(floor, Math.min(TOTAL, Math.round(frameAt(e))));
      s.bars = s.bars.map((b) => (b.end === end ? { ...b, end: to } : b));
      end = to;
      render();
    };
  } else if (target.closest('[data-vib]') && !target.closest('[data-vib-edge]')) {
    // The vibrato's bar: a click selects it
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = true;
    render();
    return;
  } else if (target.closest('[data-vib-edge]') || (inVibrato(e) && !s.vibrato)) {
    // Its start, dragged; or drawn on an empty lane to add it from there
    before();
    if (!s.vibrato) {
      s.vibrato = { delay: 1, ...DEFAULT_WOBBLE };
      s.vibrato.delay = delayFor(Math.max(0, Math.round(start)));
      moved = true;
    }
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = true;
    dragging = 'vib';
    plot.style.cursor = 'ew-resize';
    move = (e) => {
      s.vibrato!.delay = delayFor(Math.max(0, Math.round(frameAt(e))));
      render();
    };
  } else if (target.closest('[data-note]')) {
    // A step of pitch: moved whole (its change and the next, so it keeps its
    // length) in time and pitch, or either end in time
    const noteEl = target.closest<SVGGElement>('[data-note]')!;
    const original = s.notes;
    const edge = target.getAttribute('data-note-edge');
    const at = Number(noteEl.dataset.note);
    // The right end is the next change's start
    const i = edge === 'end' ? at + 1 : at;
    const note = original[i];
    const following = edge ? null : original[i + 1] ?? null;
    // Kept between the changes either side (and clear of their glides)
    const lo = i > 0 ? arrival(original[i - 1]) + 1 : 0;
    const beyond = original[i + (following ? 2 : 1)];
    const hi = (beyond ? beyond.start - 1 : TOTAL - 1) - ((following ? arrival(following) : arrival(note)) - note.start);
    selectedNote = i;
    selected = -1;
    selectedPoint = -1;
    selectedVibrato = false;
    selectedType = -1;
    before();
    dragging = 'note';
    plot.style.cursor = edge ? 'ew-resize' : 'grabbing';
    move = (e) => {
      const df = Math.round(frameAt(e) - start);
      let next: Note;
      if (edge) {
        // An end pulled away from where the pitch before it ends makes a
        // glide between them; pushed together, it jumps again
        const ends = (beyond ? beyond.start : TOTAL) - 1;
        const at = Math.max(lo, Math.min(ends, (edge === 'start' ? arrival(note) : note.start) + df));
        if (edge === 'start') next = at >= note.start ? { ...note, glide: at - note.start } : { ...note, start: at, glide: 0 };
        else next = at <= arrival(note) ? { ...note, start: at, glide: arrival(note) - at } : { ...note, start: at, glide: 0 };
        if (!next.glide) delete next.glide;
      } else {
        const moveBy = Math.max(lo, Math.min(hi, note.start + df)) - note.start;
        next = { ...note, start: note.start + moveBy, semis: semiAt(e) };
      }
      const moveBy = edge ? 0 : next.start - note.start;
      s.notes = original.map((o) => (o === note ? next : o === following ? { ...o, start: o.start + moveBy } : o));
      // The step grabbed stays selected (for its right end, that is the step before the change moved)
      selectedNote = edge === 'end' ? at : s.notes.indexOf(next);
      render();
    };
  } else if (inRoll(e)) {
    const double = e.timeStamp - lastPress.time < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 6;
    lastPress = double ? { time: 0, x: 0, y: 0 } : { time: e.timeStamp, x: e.clientX, y: e.clientY };
    if (double) {
      addGridNote(e);
      return;
    }
    // Drawing along a semitone: a change to it where the drag starts, and
    // back to the pitch that was there where it ends (unless a change comes first)
    const semis = semiAt(e);
    const original = s.notes;
    const from = Math.max(0, Math.round(start));
    before();
    dragging = 'note';
    move = (e) => {
      const to = Math.max(from + 1, Math.min(TOTAL - 1, Math.round(frameAt(e))));
      const next: Note = { start: from, semis };
      let notes = placeNote(original, next);
      const back = pitchAt(original, to);
      if (!original.some((n) => n.start > from && n.start <= to) && back !== semis) notes = placeNote(notes, { start: to, semis: back });
      s.notes = notes;
      selectedNote = s.notes.indexOf(next);
      render();
    };
    // A click without dragging just clears the selection
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = false;
    selectedType = -1;
  } else if (target.closest('[data-type]') || inTypeRow(e)) {
    // Chunks of filtering, handled like waveform bars: moved, resized, drawn
    const f = s.filter;
    const typeEl = target.closest<SVGGElement>('[data-type]');
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = false;
    if (typeEl) {
      const i = Number(typeEl.dataset.type);
      const original = f.types;
      const chunk = original[i];
      const edge = target.getAttribute('data-type-edge');
      selectedType = i;
      before();
      dragging = 'type';
      plot.style.cursor = edge ? 'ew-resize' : 'grabbing';
      move = (e) => {
        const df = Math.round(frameAt(e) - start);
        let next: FilterChunk;
        if (edge === 'start') next = { ...chunk, start: Math.max(0, Math.min(chunk.end - 1, chunk.start + df)) };
        else if (edge === 'end') next = { ...chunk, end: Math.max(chunk.start + 1, Math.min(TOTAL, Math.round(frameAt(e)))) };
        else {
          const len = chunk.end - chunk.start;
          const from = Math.max(0, Math.min(TOTAL - len, chunk.start + df));
          next = { ...chunk, start: from, end: from + len };
        }
        f.types = placeChunk(
          original.filter((o) => o !== chunk),
          next,
        );
        selectedType = f.types.indexOf(next);
        render();
      };
    } else {
      // A new chunk, of the type used last (low pass to begin with): a grid step on a double-click, or drawn
      const passband = f.types.at(-1)?.passband ?? FILTER_LOW;
      const double = e.timeStamp - lastPress.time < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 6;
      lastPress = double ? { time: 0, x: 0, y: 0 } : { time: e.timeStamp, x: e.clientX, y: e.clientY };
      if (double) {
        const step = tickStep();
        const from = Math.max(0, Math.floor(frameAt(e) / step) * step);
        const chunk: FilterChunk = { start: from, end: Math.min(TOTAL, from + step), passband };
        before();
        f.types = placeChunk(f.types, chunk);
        selectedType = f.types.indexOf(chunk);
        changed();
        playShape();
        return;
      }
      const original = f.types;
      const from = Math.max(0, Math.round(start));
      selectedType = -1;
      before();
      dragging = 'type';
      move = (e) => {
        const to = Math.max(0, Math.min(TOTAL, Math.round(frameAt(e))));
        const chunk: FilterChunk = { start: Math.min(from, to), end: Math.max(Math.min(from, to) + 1, Math.max(from, to)), passband };
        f.types = placeChunk(original, chunk);
        selectedType = f.types.indexOf(chunk);
        render();
      };
    }
  } else if (target.closest('[data-loop-end-edge]') && laneUnder(target, e)) {
    // Where the repeat ends: the last point, moved in time only, and never
    // past the point before it
    const pts = laneUnder(target, e)!.line.points;
    before();
    dragging = 'loop-end';
    plot.style.cursor = 'ew-resize';
    move = (e) => {
      const last = pts[pts.length - 1];
      last.t = Math.max(pts[pts.length - 2].t + 1, Math.min(TOTAL - 1, Math.round(frameAt(e))));
      render();
    };
  } else if (target.closest('[data-loop-edge]') && laneUnder(target, e)) {
    // Where the repeat starts: on a point, settling there as the envelope's
    // dots do. Pulled out from the end it makes one; pushed back onto the
    // end, there is none.
    const pulse = laneUnder(target, e)!.line;
    const from = pulse.loop ?? pulse.points.length - 1;
    // (held where it was grabbed: the bar, or its label beside it)
    const grab = frameAt(e) - pulse.points[from].t;
    before();
    dragging = 'loop';
    plot.style.cursor = 'ew-resize';
    move = (e) => {
      const pts = pulse.points;
      const last = pts.length - 1;
      const at = settleAt(
        pts.map((p) => p.t),
        frameAt(e) - grab,
        from,
      );
      pulse.loop = at < last ? at : null;
      render();
    };
  } else if (laneUnder(target, e) && (target.closest('[data-point]') || !target.closest('[data-line]'))) {
    // A line (pulse width or cutoff): drag a point, or add one where the row is clicked
    const l = laneUnder(target, e)!;
    const pulse = l.line;
    const widthAt = (e: PointerEvent) => laneValue(l, e);
    selectedLine = l.key;
    const pointEl = target.closest<SVGGElement>('[data-point]');
    before();
    let i: number;
    if (pointEl) i = Number(pointEl.dataset.point);
    else {
      const t = Math.max(0, Math.min(TOTAL - 1, Math.round(start)));
      i = pulse.points.findIndex((p) => p.t >= t);
      if (i >= 0 && pulse.points[i].t === t) pulse.points[i].w = widthAt(e);
      else {
        if (i < 0) i = pulse.points.length;
        pulse.points.splice(i, 0, { t, w: widthAt(e) });
        if (pulse.loop !== null && pulse.loop >= i) pulse.loop++;
      }
      moved = true;
    }
    selectedPoint = i;
    selected = -1;
    selectedNote = -1;
    selectedVibrato = false;
    selectedType = -1;
    dragging = 'point';
    plot.style.cursor = 'grabbing';
    move = (e) => {
      const pts = pulse.points;
      const p = pts[i];
      // The first point stays at the start; the others move between their neighbours
      if (i > 0) p.t = Math.max(pts[i - 1].t + 1, Math.min(i + 1 < pts.length ? pts[i + 1].t - 1 : TOTAL - 1, Math.round(frameAt(e))));
      p.w = widthAt(e);
      render();
    };
  } else if (rows() && barEl) {
    const i = Number(barEl.dataset.bar);
    const original = s.bars;
    const bar = original[i];
    const edge = target.getAttribute('data-edge');
    selected = i;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = false;
    selectedType = -1;
    before();
    dragging = 'bar';
    // The pointer keeps the look it had over the bar or its end while dragging
    plot.style.cursor = edge ? 'ew-resize' : 'grabbing';
    move = (e) => {
      const df = Math.round(frameAt(e) - start);
      let next: Bar;
      if (edge === 'start') {
        const end = bar.end ?? TOTAL;
        next = { ...bar, start: Math.max(0, Math.min(end - 1, bar.start + df)) };
      } else if (edge === 'end') {
        next = { ...bar, end: Math.max(bar.start + 1, Math.min(TOTAL, Math.round(frameAt(e)))) };
      } else {
        const len = bar.end === null ? null : bar.end - bar.start;
        const from = Math.max(0, Math.min(TOTAL - 1, bar.start + df));
        next = { wave: laneAt(e), start: from, end: len === null ? null : from + len };
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
  } else if (rows() && yAt(e) > rows()![0].top) {
    const double = e.timeStamp - lastPress.time < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 6;
    lastPress = double ? { time: 0, x: 0, y: 0 } : { time: e.timeStamp, x: e.clientX, y: e.clientY };
    if (double) {
      addGridBar(e);
      return;
    }
    // Drawing a new bar along a row
    const wave = laneAt(e);
    const original = s.bars;
    const from = Math.max(0, Math.round(start));
    before();
    dragging = 'bar';
    move = (e) => {
      // Not before the note starts, nor past the end
      const to = Math.max(0, Math.min(TOTAL, Math.round(frameAt(e))));
      const next: Bar = { wave, start: Math.min(from, to), end: Math.max(from, to) === Math.min(from, to) ? Math.min(from, to) + 1 : Math.max(from, to) };
      const bars = place(original, next);
      if (!storable(bars)) return;
      s.bars = bars;
      selected = bars.indexOf(next);
      render();
    };
    // A click without dragging just clears the selection
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = false;
    selectedType = -1;
  } else {
    selected = -1;
    selectedPoint = -1;
    selectedNote = -1;
    selectedVibrato = false;
    selectedType = -1;
    render();
    return;
  }

  e.preventDefault();
  hideChoice();
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
    plot.style.cursor = '';
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

/**
 * Which of some places in time (in order) a dragged handle lands on, for
 * the pointer at a frame. Places close together switch halfway between;
 * across a wide gap, it moves on once the pointer is STEP_GAP pixels from
 * the place it came from (`origin`), and back within it.
 */
function settleAt(places: number[], at: number, origin: number): number {
  let lo = -1;
  places.forEach((p, i) => p <= at && (lo = i));
  if (lo < 0) return 0;
  if (lo === places.length - 1) return lo;
  const hi = lo + 1;
  const px = (frames: number) => frames * state.zoom;
  if (px(places[hi] - places[lo]) < STEP_GAP) return at - places[lo] <= places[hi] - at ? lo : hi;
  if (origin >= hi) return px(places[hi] - at) >= STEP_GAP ? lo : hi;
  return px(at - places[lo]) >= STEP_GAP ? hi : lo;
}

function dragHandle(key: string, e: PointerEvent) {
  const s = shape();
  const f = frameAt(e);
  const [a, d, sus, r] = [s.ad >> 4, s.ad & 15, s.sr >> 4, s.sr & 15];
  const settle = (position: (v: number) => number, at: number) => settleAt(Array.from({ length: 16 }, (_, v) => position(v)), at, origin);
  let v = 0;
  if (key === 'keyup') setKeyUp(f);
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
    setKeyUp(f - grabOffset);
  } else if (key === 'r') {
    const releaseAt = (rv: number) => handlePos('r', s.ad, (sus << 4) | rv).f;
    s.sr = (sus << 4) | settle(releaseAt, f);
  }
  // Sustain's dot stays on the key going up
  free = key === 'keyup' ? null : { key, f: key === 's' ? handlePos('s', s.ad, s.sr).f : Math.max(0, f), v };
  render();
}

/**
 * Adds a bar of a row's waveform, one grid step long, from the grid line
 * before the pointer: what double-clicking an empty spot in a row does.
 */
function addGridBar(e: PointerEvent) {
  const s = shape();
  const step = tickStep();
  const from = Math.max(0, Math.floor(frameAt(e) / step) * step);
  const bar: Bar = { wave: laneAt(e), start: from, end: Math.min(TOTAL, from + step) };
  const bars = place(s.bars, bar);
  if (!storable(bars)) return;
  before();
  s.bars = bars;
  selected = bars.indexOf(bar);
  changed();
  playShape();
}

/** Changes the pitch to the semitone under the pointer, at the grid line before it: what double-clicking the pitch does. */
function addGridNote(e: PointerEvent) {
  const s = shape();
  const step = tickStep();
  const from = Math.max(0, Math.floor(frameAt(e) / step) * step);
  const note: Note = { start: from, semis: semiAt(e) };
  before();
  s.notes = placeNote(s.notes, note);
  selectedNote = s.notes.indexOf(note);
  selected = -1;
  selectedPoint = -1;
  changed();
  playShape();
}

function deleteNote() {
  const s = shape();
  if (!s.notes[selectedNote]) return;
  before();
  s.notes.splice(selectedNote, 1);
  selectedNote = -1;
  selectedVibrato = false;
  selectedType = -1;
  changed();
}

/** The last press on an empty spot in a row, to tell a double-click (the page redraws between the clicks, so the browser can't) */
let lastPress = { time: 0, x: 0, y: 0 };

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
  if (key === 'keyup') setKeyUp(keyUp() + dir * 5);
  else if (key === 'a') s.ad = (clamp((s.ad >> 4) + dir) << 4) | (s.ad & 15);
  else if (key === 'd') s.ad = (s.ad & 0xf0) | clamp((s.ad & 15) + dir);
  else if (key === 's' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) s.sr = (clamp((s.sr >> 4) + dir) << 4) | (s.sr & 15);
  else if (key === 's') setKeyUp(keyUp() + dir);
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
  // What is open, or with both folded, everything
  const none = !state.volumeOpen && !state.waveOpen && !state.notesOpen && !state.filterOpen;
  const frames = dataEnd(state.volumeOpen || none, state.waveOpen || state.notesOpen || state.filterOpen || none);
  setZoom(viewWidth() / Math.min(TOTAL, frames * 1.08 + 2));
  scroller.scrollLeft = 0;
});

// The zoom slider runs evenly from the whole timeline to the closest view
const zoomSlider = $<HTMLInputElement>('zoom-slider');
const SLIDER_STEPS = 1000;
function sliderValue() {
  const lo = Math.log(zoomFloor());
  return Math.round(((Math.log(state.zoom) - lo) / (Math.log(MAX_ZOOM) - lo)) * SLIDER_STEPS);
}
zoomSlider.max = String(SLIDER_STEPS);
const holdSlider = () => (sliderFloor ??= zoomFloor());
const letSliderGo = () => (sliderFloor = null);
zoomSlider.addEventListener('pointerdown', holdSlider);
zoomSlider.addEventListener('keydown', holdSlider);
zoomSlider.addEventListener('change', letSliderGo);
zoomSlider.addEventListener('pointerup', letSliderGo);
zoomSlider.addEventListener('blur', letSliderGo);
zoomSlider.addEventListener('input', () => {
  holdSlider();
  const lo = Math.log(zoomFloor());
  setZoom(Math.exp(lo + (Number(zoomSlider.value) / SLIDER_STEPS) * (Math.log(MAX_ZOOM) - lo)));
});
new ResizeObserver(() => {
  // A narrower view can't show more than the whole timeline
  state.zoom = Math.max(wholeZoom(), state.zoom);
  render();
}).observe(scroller);

$<HTMLInputElement>('name').addEventListener('input', (e) => {
  before();
  shape().name = (e.target as HTMLInputElement).value;
  persist();
  renderInstruments();
});

// --- Instruments -----------------------------------------------------------------

// Instruments added elsewhere (a song imported in the Song Maker, in another tab) join the list here
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const saved = JSON.parse(e.newValue) as { instruments?: Shape[] };
    if (!saved.instruments?.length) return;
    migrate(saved.instruments, TOTAL);
    const id = shape().id;
    state.instruments = saved.instruments;
    state.current = Math.max(0, state.instruments.findIndex((s) => s.id === id));
    renderInstruments();
    render();
    sendToPlayer();
  } catch {
    // Unreadable: keep what's here
  }
});

// The Advanced box: closed until wanted
function renderAdvanced() {
  $('advanced-toggle').setAttribute('aria-expanded', String(state.advancedOpen));
  $('advanced-twisty').setAttribute('d', state.advancedOpen ? 'M1,3L11,3L6,10Z' : 'M3,1L10,6L3,11Z');
  $('instrument-options').hidden = !state.advancedOpen;
}
renderAdvanced();
$('advanced-toggle').addEventListener('click', () => {
  state.advancedOpen = !state.advancedOpen;
  persist();
  renderAdvanced();
});

function renderInstruments() {
  const select = $<HTMLSelectElement>('instrument');
  select.replaceChildren(...state.instruments.map((s, i) => new Option(s.name || `Instrument ${i + 1}`, String(i))));
  select.value = String(state.current);
  $<HTMLButtonElement>('delete-instrument').disabled = state.instruments.length < 2;
}

function pick(i: number) {
  state.current = i;
  fitRoll();
  selected = -1;
  selectedPoint = -1;
  selectedNote = -1;
  selectedVibrato = false;
  selectedType = -1;
  renderInstruments();
  changed();
}

$<HTMLSelectElement>('instrument').addEventListener('change', (e) => pick(Number((e.target as HTMLSelectElement).value)));
$('new-instrument').addEventListener('click', () => {
  before();
  state.instruments.push({ name: `Instrument ${state.instruments.length + 1}`, ad: 0x09, sr: 0x00, bars: [{ wave: WAVE_PULSE, start: 0, end: 10 }], notes: [], hold: true, vibrato: null, filter: defaultFilter(), pulse: defaultPulse(), waveLoop: null, fixedNote: null, release: null, hardRestart: true, ...NOTE_START });
  pick(state.instruments.length - 1);
});
$('duplicate-instrument').addEventListener('click', () => {
  before();
  const s = shape();
  state.instruments.splice(state.current + 1, 0, { ...s, name: `${s.name} copy`, bars: s.bars.map((b) => ({ ...b })), notes: s.notes.map((n) => ({ ...n })), vibrato: s.vibrato && { ...s.vibrato }, filter: s.filter && JSON.parse(JSON.stringify(s.filter)), pulse: JSON.parse(JSON.stringify(s.pulse)) });
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
  saveTest();
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
  // The filter a note left on stays on (no pop as it lets go): one without a filter starts with it off
  if (!shape().filter.types.length) player.clearFilter();
  player.noteOn(0, note, TEST_INSTRUMENT);
  noteStart = performance.now();
  releaseAt = null;
  if (held !== note) noteOff();
  animate();
}

function noteOff(note?: number) {
  if (held === null || (note !== undefined && note !== held)) return;
  held = null;
  // With the key up fixed, the instrument lets go itself, there
  const fixedUp = shape().release;
  releaseAt = fixedUp ?? Math.max(1, liveFrame());
  if (player.started && fixedUp === null) player.noteOff(0);
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
    playTimer = window.setTimeout(() => noteOff(note), (keyUp() / FPS) * 1000);
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

// Space plays the note as a key does (held while it's down), wherever the focus is: never a focused button, fold or menu (only typing takes it)
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (e.key !== ' ' || typing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === 'keyup') noteOff(test.note);
      else if (!e.repeat) void noteOn(test.note);
    },
    { capture: true },
  );
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing(e)) {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if (e.key === 'Escape') {
    silence();
    if (selected >= 0 || selectedPoint >= 0) {
      selected = -1;
      selectedPoint = -1;
      selectedNote = -1;
      selectedVibrato = false;
      selectedType = -1;
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.notesOpen && selectedVibrato) {
    e.preventDefault();
    deleteVibrato();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.notesOpen && selectedNote >= 0) {
    e.preventDefault();
    deleteNote();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.filterOpen && selectedType >= 0) {
    e.preventDefault();
    deleteType();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && lane(selectedLine) && selectedPoint > 0) {
    e.preventDefault();
    deletePoint();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && rows() && selected >= 0) {
    e.preventDefault();
    deleteSelected();
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
  saveTest();
  renderKeyboard();
});
$('octave-up').addEventListener('click', () => {
  test.octave = Math.min(6, test.octave + 1);
  saveTest();
  renderKeyboard();
});
$('play').addEventListener('click', playShape);
/**
 * The instrument's checkboxes, under the timeline: how its notes start and
 * run into each other, and sync and ring modulation (whole note on or off;
 * partly, as imported, shows as neither)
 */
function renderOptions() {
  const s = shape();
  const box = $('instrument-options');
  box.replaceChildren();
  const option = (name: string, about: string, on: boolean | 'partly', flip: (on: boolean) => void, disabled = false) => {
    const label = document.createElement('label');
    label.className = 'instrument-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on === true;
    input.indeterminate = on === 'partly';
    input.disabled = disabled;
    input.addEventListener('change', () => {
      before();
      flip(input.checked);
      changed();
    });
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = name;
    text.append(strong, ` ${about}`);
    label.append(input, text);
    box.append(label);
  };
  option('Hard restart', 'Silences the note before for a moment, so each attack starts clean.', s.hardRestart && !s.legato, (on) => (s.hardRestart = on), s.legato);
  option('Legato', 'Notes run into each other without the volume starting again.', s.legato, (on) => (s.legato = on));
  const bitOn = (bit: number): boolean | 'partly' => {
    const bars = s.bits.filter((b) => b.wave === bit);
    if (!bars.length) return false;
    return bars.length === 1 && bars[0].start === 0 && bars[0].end === null ? true : 'partly';
  };
  const setBit = (bit: number, on: boolean) => (s.bits = [...s.bits.filter((b) => b.wave !== bit), ...(on ? [{ wave: bit, start: 0, end: null }] : [])]);
  option('Sync', 'Restarts the waveform with the voice before it, for hard, tearing tones (heard in a song).', bitOn(SYNC_BIT), (on) => setBit(SYNC_BIT, on));
  option('Ring modulation', 'Mixes the triangle with the voice before it, for bell-like, metallic tones (heard in a song).', bitOn(RING_BIT), (on) => setBit(RING_BIT, on));
}

// The clock: PAL or NTSC, remembered for the instrument pages
function renderClock() {
  for (const b of $('clock').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', (b.dataset.ntsc === '1') === ntsc);
}
renderClock();
player.setSettings(settings);
$('clock').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ntsc]');
  if (!b) return;
  ntsc = b.dataset.ntsc === '1';
  FPS = ntsc ? 60 : 50;
  CLOCK = ntsc ? 1022727 : 985248;
  TOTAL = SECONDS * FPS;
  settings = { ...settings, ntsc };
  saveNtsc(ntsc);
  player.setSettings(settings);
  state.keyUp = Math.min(state.keyUp, TOTAL - 1);
  for (const ins of state.instruments) if (ins.release !== null) ins.release = Math.min(ins.release, TOTAL - 1);
  simCache.clear();
  renderClock();
  render();
});

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

// --- From GoatTracker songs ------------------------------------------------------

/** How long an imported instrument is played to read its shape: long enough to see slow repeats come round */
const IMPORT_FRAMES = 1200;

/**
 * A song's instruments as shapes, each with what didn't come across: its
 * gaps, and where playing the shape differs from the original (a trace of
 * each, compared frame by frame).
 */
function importSong(bytes: Uint8Array, only?: number): { name: string; gaps: string[]; differs: string[]; shape: Shape; traces?: Trace[] }[] {
  if (!analyzer) return [];
  const song = parseSong(bytes);
  const a = analyzer;
  const tracer: Tracer = (ins, note, frames) => a.trace(song.tables, ins, note, frames, settings);
  const out = [];
  for (let n = 1; n < song.instruments.length; n++) {
    const ins = song.instruments[n];
    if (!ins || !ins.tables[0] || (only !== undefined && n !== only)) continue;
    const { shape: imported, gaps } = importInstrument(ins, song.tables, tracer, IMPORT_FRAMES);
    const original = tracer(ins, IMPORT_KEY, IMPORT_FRAMES);
    // The player counts vibrato's delay only on frames that don't set the
    // pitch, so the same delay can start it elsewhere in the shape: start it
    // where the original does
    if (imported.vibrato) {
      const plain = tracer({ ...ins, tables: [ins.tables[0], ins.tables[1], ins.tables[2], 0] }, IMPORT_KEY, IMPORT_FRAMES);
      const from = original.freq.findIndex((f, i) => f !== plain.freq[i]);
      if (from >= 0) imported.vibrato.delay = delayFor(from, imported);
    }
    const au = audition(imported);
    const copy = a.trace(au.tables, au.instrument, IMPORT_KEY, IMPORT_FRAMES, settings);
    out.push({ name: `${n}: ${ins.name}`, gaps, differs: differences(original, copy), shape: imported, ...(only !== undefined ? { traces: [original, copy] } : {}) });
  }
  return out;
}

/** Where two traces of a note part ways: what, and from when */
function differences(a: Trace, b: Trace): string[] {
  const out: string[] = [];
  const first = (what: string, differ: (f: number) => boolean) => {
    for (let f = 0; f < a.frames; f++) {
      if (differ(f)) {
        out.push(`${what} from frame ${f}`);
        return;
      }
    }
  };
  first('waveform', (f) => (a.control[f] & 0xf1) !== (b.control[f] & 0xf1));
  first('pitch', (f) => Math.abs(12 * Math.log2((a.freq[f] || 1) / (b.freq[f] || 1))) > 0.05);
  // (within 2 of 4096: a straight sweep for one whose steps alternate a little)
  first('pulse width', (f) => !!(a.control[f] & 0x40) && Math.abs(a.pulse[f] - b.pulse[f]) > 2);
  const filtered = (t: Trace, f: number) => (t.routing[f] & 7) !== 0;
  first('filtering', (f) => filtered(a, f) !== filtered(b, f));
  first('filter type', (f) => filtered(a, f) && (a.mode[f] & 0x70) !== (b.mode[f] & 0x70));
  first('cutoff', (f) => filtered(a, f) && a.cutoff[f] !== b.cutoff[f]);
  first('resonance', (f) => filtered(a, f) && a.routing[f] >> 4 !== b.routing[f] >> 4);
  first('envelope', (f) => a.ad[f] !== b.ad[f] || a.sr[f] !== b.sr[f]);
  return out;
}

// For scripts/browsertest.mjs
Object.assign(window, {
  maker2: {
    state: () => state,
    /** After changing the state: redraws, saves and updates the player */
    changed,
    trace,
    traceWith,
    audition,
    ready: () => analyzer !== null,
    status: () => lastStatus,
    importSong,
    /** A song's instrument played on a key, for looking into imports */
    traceSongInstrument: (bytes: Uint8Array, n: number, frames: number) => {
      const song = parseSong(bytes);
      return analyzer!.trace(song.tables, song.instruments[n], IMPORT_KEY, frames, settings);
    },
    /** Sets the key the traces play */
    setKey: (note: number) => (test.note = note),
    /** The keyboard's octave and Space's note */
    test: () => ({ ...test }),
  },
});
