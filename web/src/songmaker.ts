// The song maker: tracks of notes along a timeline, each for an instrument
// from Instrument Maker 2, played on one of the chip's three voices. Tracks
// sharing a voice take turns (see songdoc.ts). Notes are recorded by playing
// along, or drawn in the editor under the arrangement. Clips repeat by
// pulling out their upper right edge.

import './style.css';
import './instrumentmaker.css';
import './maker2.css';
import './songmaker.css';
import { Analyzer } from './engine/analyzer';
import { loadModel, loadNtsc, Player, saveModel, saveNtsc } from './engine/player';
import { DEFAULT_SETTINGS, type Settings } from './engine/protocol';
import type { Sequence } from './engine/sequencer';
import { loadInstruments, sounds, soundTables, STORAGE_KEY as INSTRUMENTS_KEY } from './instruments';
import { noteName } from './song';
import { clipNotes, newId, songEnd, songFrame, songSequence, songSounds, voiceSegments, VOICES, type Clip, type SongDoc, type SongNote, type Track } from './songdoc';
import type { Shape } from './shape';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

let ntsc = loadNtsc();
let FPS = ntsc ? 60 : 50;
let settings: Settings = { ...DEFAULT_SETTINGS, ntsc };

const SONG_KEY = 'sidkid.song2.v1';
/** Instrument timelines are this long (only for bringing old saves up to date) */
const INSTRUMENT_SECONDS = 32;

/** Arrangement: the ruler (the cycle along its top), then a lane per track */
const RULER_H = 32;
const CYCLE_H = 12;
const LANE_H = 56;
const EDGE = 7;
/** Editor: a row per semitone, all of GoatTracker's notes */
const ROW = 11;
const LOWEST = 0;
const HIGHEST = 95;
const KEYS_W = 44;

interface Saved {
  song: SongDoc;
  /** Pixels a step, in the arrangement and in the editor */
  zoom: number;
  rollZoom: number;
}

function defaultSong(): SongDoc {
  return {
    name: 'New song',
    stepFrames: 6,
    stepsPerBeat: 4,
    beatsPerBar: 4,
    tracks: [0, 1, 2].map((v) => ({ id: newId(), instrument: instruments[v % instruments.length]?.id ?? '', voice: v, muted: false, clips: [] })),
    cycle: { start: 0, end: 64 },
    cycling: false,
  };
}

let instruments: Shape[] = loadInstruments(INSTRUMENT_SECONDS * FPS);
let byId = new Map(instruments.map((s) => [s.id!, s]));

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(SONG_KEY) ?? 'null') as Saved | null;
    if (saved?.song?.tracks) return { ...saved, zoom: saved.zoom ?? 6, rollZoom: saved.rollZoom ?? 22 };
  } catch {
    // Unreadable or blocked storage: start afresh
  }
  return { song: defaultSong(), zoom: 6, rollZoom: 22 };
}

const view = load();
const song = () => view.song;
const barSteps = () => song().stepsPerBeat * song().beatsPerBar;

function persist() {
  try {
    localStorage.setItem(SONG_KEY, JSON.stringify(view));
  } catch {
    // Storage may be full or blocked; the page still works
  }
}

// --- Selection ---------------------------------------------------------------

/** The track keys play and recording goes to */
let current = 0;
/** The clip in the editor */
let openClip: Clip | null = null;
const selectedNotes = new Set<SongNote>();
/** Where Delete and the arrow keys act: the arrangement or the editor */
let focus: 'arrange' | 'roll' = 'arrange';
/** Where Play starts, in steps */
let playhead = 0;
const keyboard = { octave: 3 };
/** The length the next drawn note gets */
let lastLength = 2;

const track = () => song().tracks[current] as Track | undefined;
const trackOf = (c: Clip) => song().tracks.find((t) => t.clips.includes(c));

// --- Undo -------------------------------------------------------------------------

const undoStack: string[] = [];
const redoStack: string[] = [];

function before() {
  undoStack.push(JSON.stringify(view.song));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function undo(redo = false) {
  const from = redo ? redoStack : undoStack;
  const to = redo ? undoStack : redoStack;
  const s = from.pop();
  if (!s) return;
  to.push(JSON.stringify(view.song));
  view.song = JSON.parse(s);
  openClip = null;
  selectedNotes.clear();
  current = Math.min(current, song().tracks.length - 1);
  changed();
}

/** After any change to the song: saves, redraws, and plays the change */
function changed() {
  persist();
  render();
  if (transport.playing) restartSequence(true);
}

// --- Sounds -------------------------------------------------------------------------

const player = new Player();
player.onError = (m) => toast(m);
let trackSound: number[] = [];

/** The tables and instruments for every track's instrument on its voice, to the player */
function sendSounds() {
  const { sounds: list, trackSound: numbers } = songSounds(song(), byId);
  trackSound = numbers;
  if (!player.started) return;
  const t = soundTables(sounds(list.map((s) => ({ shape: s.shape, voices: 1 << s.voice }))));
  player.setTables(t.tables);
  t.instruments.forEach((ins, i) => player.setInstrument(i + 1, ins));
}

async function startAudio(): Promise<boolean> {
  if (player.started) return true;
  try {
    await player.start();
  } catch (err) {
    toast(`Audio failed to start: ${err}`);
    return false;
  }
  player.setSettings(settings);
  player.setModel(loadModel());
  sendSounds();
  return true;
}

// Instruments edited in Instrument Maker 2 (another tab) come straight over
window.addEventListener('storage', (e) => {
  if (e.key !== INSTRUMENTS_KEY) return;
  instruments = loadInstruments(INSTRUMENT_SECONDS * FPS);
  byId = new Map(instruments.map((s) => [s.id!, s]));
  sendSounds();
  render();
  if (transport.playing) restartSequence(true);
});

// --- Playing ----------------------------------------------------------------------------

const transport = {
  playing: false,
  recording: false,
  /** Where this play started, and the cycle it goes round (frames) */
  from: 0,
  cycle: null as { start: number; end: number } | null,
  seq: null as Sequence | null,
  /** The latest frame the player said it was at, and when */
  at: null as number | null,
  atTime: 0,
  /** Recorded notes go into clips that cover them, or this one, made for the take */
  take: null as Clip | null,
};

function playRange(): { from: number; cycle: { start: number; end: number } | null } {
  const sf = song().stepFrames;
  const s = song();
  let from = Math.round(playhead * sf);
  const cycle = s.cycling ? { start: s.cycle.start * sf, end: s.cycle.end * sf } : null;
  if (cycle && (from < cycle.start || from >= cycle.end)) from = cycle.start;
  if (!cycle && from >= songEnd(s) * sf) from = 0;
  return { from, cycle };
}

function restartSequence(keep: boolean) {
  sendSounds();
  const seq = songSequence(song(), songSounds(song(), byId).sounds, trackSound, transport.from, transport.cycle);
  transport.seq = seq;
  player.sequence(seq, keep);
}

async function play(record = false) {
  if (!(await startAudio())) return;
  const range = playRange();
  transport.from = range.from;
  transport.cycle = range.cycle;
  transport.playing = true;
  transport.recording = record;
  transport.take = null;
  transport.at = null;
  restartSequence(false);
  renderTransport();
  animate();
}

function stop() {
  if (!transport.playing) return;
  for (const k of [...held.keys()]) keyUp(k);
  const f = liveFrame();
  transport.playing = false;
  transport.recording = false;
  player.sequence(null);
  player.silence();
  if (f !== null) playhead = f / song().stepFrames;
  renderTransport();
  render();
}

player.onStatus = (status) => {
  if (!transport.playing) return;
  if (status.sequence === null) {
    // Played to the end (statuses from before it started don't count)
    if (transport.at !== null) {
      stop();
      playhead = transport.from / song().stepFrames;
      render();
    }
    return;
  }
  transport.at = status.sequence;
  transport.atTime = performance.now();
};

/** The song frame being heard now, or null before the first note */
function liveFrame(): number | null {
  const seq = transport.seq;
  if (!transport.playing || !seq) return null;
  if (transport.at === null) return transport.from;
  let f = transport.at + ((performance.now() - transport.atTime) / 1000 - player.latency) * FPS;
  if (seq.loopFrom !== null && f >= seq.length) f = seq.loopFrom + ((f - seq.loopFrom) % (seq.length - seq.loopFrom));
  if (f < 0) return transport.from;
  return songFrame(f, transport.from, transport.cycle, seq);
}

let animating = false;
function animate() {
  if (animating) return;
  animating = true;
  const step = () => {
    const f = liveFrame();
    if (f === null) {
      animating = false;
      movePlayhead();
      return;
    }
    playhead = f / song().stepFrames;
    movePlayhead(true);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- Keys: playing and recording --------------------------------------------------------

/** Keys down: the note each plays, and when it went down (song frame) when recording */
const held = new Map<string, { note: number; voice: number; at: number | null; track: number }>();

async function keyDown(key: string, note: number) {
  const t = track();
  if (!t || held.has(key)) return;
  if (!(await startAudio())) return;
  const sound = trackSound[current];
  if (!sound) return;
  player.noteOn(t.voice, note, sound);
  held.set(key, { note, voice: t.voice, at: transport.recording ? liveFrame() : null, track: current });
  renderKeyboard();
}

function keyUp(key: string) {
  const h = held.get(key);
  if (!h) return;
  held.delete(key);
  const t = song().tracks[h.track];
  // The note on the voice now: let go, unless another key has taken it since, or the instrument lets go itself
  const later = [...held.values()].some((o) => o.voice === h.voice);
  const shape = t && byId.get(t.instrument);
  if (player.started && !later && shape?.release === null) player.noteOff(h.voice);
  if (h.at !== null && transport.recording && t) record(t, h.note, h.at, liveFrame() ?? h.at);
  renderKeyboard();
}

/** Puts a played note into the track, on the nearest steps */
function record(t: Track, note: number, from: number, to: number) {
  const sf = song().stepFrames;
  const start = Math.round(from / sf);
  let length = Math.round(to / sf) - start;
  // Let go after coming round the cycle
  if (length < 0 && transport.cycle) length += (transport.cycle.end - transport.cycle.start) / sf;
  length = Math.max(1, length);
  before();
  let clip = t.clips.find((c) => c.start <= start && start < c.start + c.span);
  if (!clip) {
    const bar = barSteps();
    const take = transport.take;
    if (take && t.clips.includes(take) && start >= take.start) {
      // The take grows a bar at a time to hold it
      take.length = take.span = Math.ceil((start + 1 - take.start) / bar) * bar;
      clip = take;
    } else {
      clip = { start: Math.floor(start / bar) * bar, length: bar, span: bar, notes: [] };
      t.clips.push(clip);
      transport.take = clip;
    }
  }
  const at = (start - clip.start) % clip.length;
  clip.notes.push({ start: at, length, note });
  // A note played over the same spot again replaces it
  clip.notes = clip.notes.filter((n, i) => i === clip.notes.length - 1 || n.start !== at);
  if (!openClip) openClip = clip;
  changed();
}

// --- Drawing helpers --------------------------------------------------------------------

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** Each track keeps a colour as tracks come and go */
function hue(t: Track): number {
  let h = 0;
  for (const c of t.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const instrumentName = (t: Track) => byId.get(t.instrument)?.name ?? 'No instrument';

function positionText(step: number): string {
  const s = song();
  const whole = Math.floor(step);
  const bar = Math.floor(whole / barSteps());
  const beat = Math.floor((whole % barSteps()) / s.stepsPerBeat);
  return `${bar + 1}.${beat + 1}.${(whole % s.stepsPerBeat) + 1}`;
}

// --- Arrangement ------------------------------------------------------------------------

const arr = $('arr') as unknown as SVGSVGElement;
const arrScroll = $('arr-scroll');
const ax = (step: number) => step * view.zoom;
const laneTop = (i: number) => RULER_H + i * LANE_H;
/** Steps the arrangement shows: the song and room after it */
const arrSteps = () => {
  const bar = barSteps();
  const end = Math.max(songEnd(song()), song().cycle.end, Math.ceil(playhead));
  return Math.max(Math.ceil(end / bar) + 8, Math.ceil(arrScroll.clientWidth / (bar * view.zoom)) + 1) * bar;
};
/** Clip moves and edges snap to beats, or to steps zoomed in */
const snap = () => (view.zoom >= 14 ? 1 : song().stepsPerBeat);

function render() {
  renderHeads();
  renderArrangement();
  renderEditor();
  renderTransport();
  renderTrackNow();
}

function renderHeads() {
  const heads = $('track-heads');
  heads.replaceChildren();
  const spacer = document.createElement('div');
  spacer.className = 'heads-ruler';
  heads.append(spacer);
  song().tracks.forEach((t, i) => {
    const head = document.createElement('div');
    head.className = `track-head${i === current ? ' current' : ''}${t.muted ? ' muted' : ''}`;
    head.style.setProperty('--h', String(hue(t)));
    head.addEventListener('pointerdown', () => {
      if (current !== i) {
        current = i;
        render();
      }
    });
    const select = document.createElement('select');
    select.className = 'track-instrument';
    select.title = 'The instrument this track plays';
    select.append(...instruments.map((s) => new Option(s.name, s.id)));
    if (!byId.has(t.instrument)) select.append(new Option('No instrument', t.instrument));
    select.value = t.instrument;
    select.addEventListener('change', () => {
      before();
      t.instrument = select.value;
      changed();
    });
    const voices = document.createElement('div');
    voices.className = 'voice-pick';
    voices.title = 'The voice of the chip this track plays on. Tracks on the same voice take turns: the newest note plays.';
    for (let v = 0; v < VOICES; v++) {
      const b = document.createElement('button');
      b.textContent = String(v + 1);
      b.className = v === t.voice ? 'on' : '';
      b.setAttribute('aria-label', `Voice ${v + 1}`);
      b.addEventListener('click', () => {
        if (t.voice === v) return;
        before();
        t.voice = v;
        changed();
      });
      voices.append(b);
    }
    const mute = document.createElement('button');
    mute.className = `mini track-mute${t.muted ? ' set' : ''}`;
    mute.textContent = 'M';
    mute.title = t.muted ? 'Muted: click to hear this track' : 'Mute this track';
    mute.setAttribute('aria-pressed', String(t.muted));
    mute.addEventListener('click', () => {
      before();
      t.muted = !t.muted;
      changed();
    });
    const remove = document.createElement('button');
    remove.className = 'mini danger track-remove';
    remove.textContent = '×';
    remove.title = 'Remove this track';
    remove.setAttribute('aria-label', 'Remove this track');
    remove.disabled = song().tracks.length < 2;
    remove.addEventListener('click', () => removeTrack(i));
    const row = document.createElement('div');
    row.className = 'track-row';
    const voiceLabel = document.createElement('span');
    voiceLabel.className = 'voice-label';
    voiceLabel.textContent = 'Voice';
    row.append(voiceLabel, voices, mute, remove);
    head.append(select, row);
    heads.append(head);
  });
  const add = document.createElement('button');
  add.className = 'mini add-track';
  add.textContent = '+ Track';
  add.title = 'Add a track';
  add.addEventListener('click', addTrack);
  heads.append(add);
}

function addTrack() {
  before();
  const s = song();
  // The voice used least, and an instrument no track plays yet
  const uses = [0, 1, 2].map((v) => s.tracks.filter((t) => t.voice === v).length);
  const voice = uses.indexOf(Math.min(...uses));
  const instrument = (instruments.find((i) => !s.tracks.some((t) => t.instrument === i.id)) ?? instruments[0])?.id ?? '';
  s.tracks.push({ id: newId(), instrument, voice, muted: false, clips: [] });
  current = s.tracks.length - 1;
  changed();
}

function removeTrack(i: number) {
  const s = song();
  if (s.tracks.length < 2) return;
  before();
  const [gone] = s.tracks.splice(i, 1);
  if (openClip && gone.clips.includes(openClip)) openClip = null;
  current = Math.min(current, s.tracks.length - 1);
  changed();
  toast('Removed the track (⌘Z brings it back)');
}

const playheadLine = el('line', { class: 'arr-playhead', y1: 0 });
const rollPlayhead = el('line', { class: 'arr-playhead', y1: 0 });

function renderArrangement() {
  const s = song();
  const steps = arrSteps();
  const width = ax(steps);
  const height = laneTop(s.tracks.length);
  arr.setAttribute('width', String(width));
  arr.setAttribute('height', String(height));
  arr.replaceChildren();
  // Ruler, cycle, grid
  el('rect', { x: 0, y: 0, width, height: RULER_H, class: 'arr-ruler', 'data-ruler': '' }, arr);
  const c = s.cycle;
  el('rect', { x: ax(c.start), y: 2, width: ax(c.end - c.start), height: CYCLE_H - 2, rx: 3, class: `arr-cycle${s.cycling ? ' on' : ''}`, 'data-cycle': '' }, arr);
  if (s.cycling) el('rect', { x: ax(c.start), y: RULER_H, width: ax(c.end - c.start), height: height - RULER_H, class: 'arr-cycle-band' }, arr);
  const bar = barSteps();
  const beatPx = ax(s.stepsPerBeat);
  for (let st = 0; st <= steps; st += beatPx >= 14 ? s.stepsPerBeat : bar) {
    const isBar = st % bar === 0;
    el('line', { x1: ax(st) + 0.5, x2: ax(st) + 0.5, y1: isBar ? CYCLE_H : RULER_H - 6, y2: height, class: isBar ? 'arr-grid bar' : 'arr-grid' }, arr);
    const barN = st / bar + 1;
    if (isBar && (ax(bar) >= 28 || barN % 4 === 1)) el('text', { x: ax(st) + 4, y: RULER_H - 7, class: 'arr-label' }, arr).textContent = String(barN);
  }
  // Lanes and their clips
  s.tracks.forEach((t, i) => {
    const top = laneTop(i);
    el('rect', { x: 0, y: top, width, height: LANE_H, class: `arr-lane${i === current ? ' current' : ''}`, 'data-lane': i }, arr);
    el('line', { x1: 0, x2: width, y1: top + LANE_H - 0.5, y2: top + LANE_H - 0.5, class: 'arr-lane-line' }, arr);
    // Where another track on the voice has it, this one is drawn hatched
    const heard = voiceSegments(s, t.voice).filter((g) => g.track === i);
    t.clips.forEach((clip, k) => drawClip(t, i, clip, k, heard));
  });
  playheadLine.setAttribute('y2', String(height));
  arr.append(playheadLine);
  movePlayhead();
}

function drawClip(t: Track, ti: number, clip: Clip, k: number, heard: { start: number; end: number }[]) {
  const s = song();
  const top = laneTop(ti) + 3;
  const h = LANE_H - 6;
  const g = el('g', { class: `clip2${clip === openClip ? ' open' : ''}${t.muted ? ' muted' : ''}`, 'data-track': ti, 'data-clip': k }, arr);
  g.style.setProperty('--h', String(hue(t)));
  const x0 = ax(clip.start);
  const w = Math.max(4, ax(clip.span));
  el('rect', { x: x0 + 0.5, y: top + 0.5, width: w - 1, height: h - 1, rx: 5, class: 'clip2-body' }, g);
  // Repeats: a notch where each pass starts
  for (let at = clip.length; at < clip.span; at += clip.length) {
    el('path', { d: `M${x0 + ax(at)},${top + 1}v${h - 2}`, class: 'clip2-notch' }, g);
  }
  // Its notes, scaled to the clip's range of pitch
  const notes = clipNotes(clip);
  if (notes.length) {
    const lo = Math.min(...notes.map((n) => n.note));
    const hi = Math.max(...notes.map((n) => n.note));
    const range = Math.max(12, hi - lo);
    const ny = (n: number) => top + 6 + (1 - (n - lo + (range - (hi - lo)) / 2) / range) * (h - 14);
    const sf = s.stepFrames;
    for (const n of notes) {
      const from = n.start * sf;
      const to = (n.start + n.length) * sf;
      const stolen = !heard.some((g) => g.start <= from && g.end >= to);
      el('rect', { x: ax(n.start) + 0.5, y: ny(n.note) - 1.5, width: Math.max(1.5, ax(n.length) - 1), height: 3, rx: 1, class: `clip2-note${n.start >= clip.start + clip.length ? ' again' : ''}${stolen ? ' stolen' : ''}` }, g);
    }
  }
  // Pull handles: the length (lower right) and the repeat (upper right)
  el('rect', { x: x0 + w - EDGE, y: top + h / 2, width: EDGE, height: h / 2, class: 'clip2-edge', 'data-edge': 'length' }, g).append(title('Drag to change the length'));
  const loop = el('g', { class: 'clip2-loop', 'data-edge': 'span' }, g);
  el('rect', { x: x0 + w - EDGE * 2, y: top, width: EDGE * 2, height: h / 2, class: 'clip2-edge' }, loop);
  el('path', { d: `M${x0 + w - 11},${top + 9}a4,4 0 1 1 1.5,3.1m-1.5,-3.1l-1.4,-2.6m1.4,2.6l2.6,-1.3`, class: 'clip2-loop-icon' }, loop);
  loop.append(title('Drag to repeat'));
}

/**
 * A second press soon after the first, in about the same place. (The
 * dblclick event can't be used: the first press redraws what was under it.)
 */
const lastPress = { time: 0, x: 0, y: 0 };
function isDouble(e: PointerEvent): boolean {
  const double = e.timeStamp - lastPress.time < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 6;
  Object.assign(lastPress, { time: double ? 0 : e.timeStamp, x: e.clientX, y: e.clientY });
  return double;
}

function title(text: string) {
  const t = el('title');
  t.textContent = text;
  return t;
}

function movePlayhead(follow = false) {
  const x = ax(playhead) + 0.5;
  playheadLine.setAttribute('x1', String(x));
  playheadLine.setAttribute('x2', String(x));
  $('position').textContent = positionText(playhead);
  if (follow) {
    const left = arrScroll.scrollLeft;
    const w = arrScroll.clientWidth;
    if (x > left + w - 40 || x < left) arrScroll.scrollLeft = Math.max(0, x - 40);
  }
  // In the editor, where the open clip is up to
  const c = openClip;
  const inClip = c && playhead >= c.start && playhead < c.start + c.span;
  rollPlayhead.style.display = inClip ? '' : 'none';
  if (inClip) {
    const rx = KEYS_PAD + ((playhead - c.start) % c.length) * view.rollZoom + 0.5;
    rollPlayhead.setAttribute('x1', String(rx));
    rollPlayhead.setAttribute('x2', String(rx));
  }
}

// Arrangement pointer: ruler (cycle along its top), clips (moved, lengthened, repeated), lanes
type ArrDrag =
  | { kind: 'seek' }
  | { kind: 'cycle-new'; from: number }
  | { kind: 'cycle'; what: 'start' | 'end' | 'move'; x0: number; start: number; end: number }
  | { kind: 'clip'; what: 'move' | 'length' | 'span'; clip: Clip; track: number; x0: number; y0: number; start: number; length: number; span: number; copy: boolean; moved: boolean };
let arrDrag: ArrDrag | null = null;

const arrPoint = (e: PointerEvent) => {
  const r = arr.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const stepAt = (x: number) => Math.max(0, x / view.zoom);

arr.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  focus = 'arrange';
  const p = arrPoint(e);
  const target = e.target as Element;
  const s = song();
  arr.setPointerCapture(e.pointerId);
  if (p.y < RULER_H) {
    if (target.closest('[data-cycle]') && p.y < CYCLE_H) {
      const c = s.cycle;
      const near = (st: number) => Math.abs(p.x - ax(st)) <= EDGE;
      arrDrag = { kind: 'cycle', what: near(c.start) ? 'start' : near(c.end) ? 'end' : 'move', x0: p.x, start: c.start, end: c.end };
      before();
    } else if (p.y < CYCLE_H) {
      before();
      const at = Math.round(stepAt(p.x) / snap()) * snap();
      arrDrag = { kind: 'cycle-new', from: at };
    } else {
      arrDrag = { kind: 'seek' };
      seek(stepAt(p.x));
    }
    return;
  }
  const g = target.closest<SVGGElement>('[data-clip]');
  if (g) {
    const ti = Number(g.dataset.track);
    const clip = s.tracks[ti].clips[Number(g.dataset.clip)];
    const edge = target.closest<SVGElement>('[data-edge]')?.dataset.edge as 'length' | 'span' | undefined;
    current = ti;
    const other = openClip !== clip;
    if (other) selectedNotes.clear();
    openClip = clip;
    arrDrag = { kind: 'clip', what: edge ?? 'move', clip, track: ti, x0: p.x, y0: p.y, start: clip.start, length: clip.length, span: clip.span, copy: e.altKey && !edge, moved: false };
    render();
    if (other) centreRoll();
    return;
  }
  const lane = target.closest<SVGElement>('[data-lane]');
  if (lane && isDouble(e)) {
    addClip(p);
    return;
  }
  if (lane) {
    current = Number(lane.dataset.lane);
    openClip = null;
    selectedNotes.clear();
    arrDrag = null;
    render();
  }
});

arr.addEventListener('pointermove', (e) => {
  const p = arrPoint(e);
  const d = arrDrag;
  const s = song();
  if (!d) {
    // The cycle's ends can be dragged
    const c = s.cycle;
    const onCycle = p.y < CYCLE_H && (Math.abs(p.x - ax(c.start)) <= EDGE || Math.abs(p.x - ax(c.end)) <= EDGE);
    arr.style.cursor = onCycle ? 'ew-resize' : '';
    return;
  }
  const by = Math.round((p.x - ('x0' in d ? d.x0 : p.x)) / view.zoom / snap()) * snap();
  if (d.kind === 'seek') seek(stepAt(p.x));
  else if (d.kind === 'cycle-new') {
    const at = Math.round(stepAt(p.x) / snap()) * snap();
    s.cycle = { start: Math.min(d.from, at), end: Math.max(d.from, at, Math.min(d.from, at) + snap()) };
    s.cycling = true;
    renderArrangement();
    renderTransport();
  } else if (d.kind === 'cycle') {
    const len = d.end - d.start;
    if (d.what === 'move') s.cycle = { start: Math.max(0, d.start + by), end: Math.max(0, d.start + by) + len };
    else if (d.what === 'start') s.cycle = { start: Math.max(0, Math.min(d.end - snap(), d.start + by)), end: d.end };
    else s.cycle = { start: d.start, end: Math.max(d.start + snap(), d.end + by) };
    renderArrangement();
  } else if (d.kind === 'clip') {
    if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 3) return;
    if (!d.moved) {
      before();
      d.moved = true;
      if (d.copy) {
        // ⌥-drag leaves the original where it was and moves a copy
        const copy = JSON.parse(JSON.stringify(d.clip)) as Clip;
        s.tracks[d.track].clips.push(copy);
        d.clip = copy;
        openClip = copy;
      }
    }
    const c = d.clip;
    if (d.what === 'move') {
      c.start = Math.max(0, d.start + by);
      // Up or down to another track
      const lane = Math.max(0, Math.min(s.tracks.length - 1, Math.floor((p.y - RULER_H) / LANE_H)));
      const from = s.tracks.findIndex((t) => t.clips.includes(c));
      if (lane !== from) {
        s.tracks[from].clips.splice(s.tracks[from].clips.indexOf(c), 1);
        s.tracks[lane].clips.push(c);
        current = lane;
      }
    } else if (d.what === 'length') {
      // Changing the length starts the repeats over: it plays once
      c.length = Math.max(1, d.length + Math.round((p.x - d.x0) / view.zoom / snap()) * snap());
      if (d.span === d.length) c.span = c.length;
      else c.span = Math.max(c.length, d.span);
    } else {
      c.span = Math.max(1, d.span + by);
    }
    render();
  }
});

const endArrDrag = () => {
  const d = arrDrag;
  arrDrag = null;
  if (!d) return;
  if (d.kind === 'clip' && d.moved) changed();
  else if (d.kind === 'cycle' || d.kind === 'cycle-new') changed();
};
arr.addEventListener('pointerup', endArrDrag);
arr.addEventListener('pointercancel', endArrDrag);

/** Double-clicking in a lane makes a clip a bar long there */
function addClip(p: { x: number; y: number }) {
  const ti = Math.floor((p.y - RULER_H) / LANE_H);
  const t = song().tracks[ti];
  if (!t) return;
  before();
  const bar = barSteps();
  const clip: Clip = { start: Math.floor(stepAt(p.x) / bar) * bar, length: bar, span: bar, notes: [] };
  t.clips.push(clip);
  current = ti;
  openClip = clip;
  selectedNotes.clear();
  changed();
}

// Pinch or ⌘/Ctrl + scroll zooms around the pointer
arrScroll.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = arrScroll.getBoundingClientRect();
    zoomTo(view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left);
  },
  { passive: false },
);

function zoomTo(z: number, pointer = arrScroll.clientWidth / 2) {
  const step = (arrScroll.scrollLeft + pointer) / view.zoom;
  view.zoom = Math.max(1.5, Math.min(40, z));
  renderArrangement();
  arrScroll.scrollLeft = step * view.zoom - pointer;
  persist();
}
$('zoom-in').addEventListener('click', () => zoomTo(view.zoom * 1.5));
$('zoom-out').addEventListener('click', () => zoomTo(view.zoom / 1.5));

function seek(step: number) {
  playhead = Math.max(0, step);
  if (transport.playing) {
    void play(transport.recording);
    return;
  }
  movePlayhead();
}

// --- Editor -----------------------------------------------------------------------------------

const roll = $('roll') as unknown as SVGSVGElement;
const rollScroll = $('roll-scroll');
const rollKeys = $('roll-keys') as unknown as SVGSVGElement;
/** Room left of step 0 in the editor */
const KEYS_PAD = 8;
const rx = (step: number) => KEYS_PAD + step * view.rollZoom;
const ry = (note: number) => (HIGHEST - note) * ROW;
const BLACK = [1, 3, 6, 8, 10];

function renderEditor() {
  const c = openClip;
  const t = c ? trackOf(c) : undefined;
  $('editor').classList.toggle('empty', !c);
  $('editor-title').textContent = c && t ? `Notes: ${instrumentName(t)}` : 'Notes';
  $('editor-hint').textContent = c
    ? 'Double-click to add a note. Drag notes to move them, their right end to lengthen them. ↑↓ move selected notes a semitone, with ⇧ an octave.'
    : 'Pick a clip to see its notes here.';
  const s = song();
  const steps = c ? Math.max(c.length, ...c.notes.map((n) => n.start + n.length)) : barSteps();
  const shown = Math.max(steps + s.stepsPerBeat, Math.ceil((rollScroll.clientWidth - KEYS_PAD) / view.rollZoom));
  const width = rx(shown);
  const height = (HIGHEST - LOWEST + 1) * ROW;
  roll.setAttribute('width', String(width));
  roll.setAttribute('height', String(height));
  roll.replaceChildren();
  for (let n = LOWEST; n <= HIGHEST; n++) {
    el('rect', { x: 0, y: ry(n), width, height: ROW, class: `roll-row${BLACK.includes(n % 12) ? ' black' : ''}` }, roll);
    if (n % 12 === 0) el('line', { x1: 0, x2: width, y1: ry(n) + ROW - 0.5, y2: ry(n) + ROW - 0.5, class: 'roll-octave' }, roll);
  }
  const bar = barSteps();
  for (let st = 0; st <= shown; st++) {
    const kind = st % bar === 0 ? 'bar' : st % s.stepsPerBeat === 0 ? 'beat' : 'step';
    el('line', { x1: rx(st) + 0.5, x2: rx(st) + 0.5, y1: 0, y2: height, class: `roll-grid ${kind}` }, roll);
  }
  if (c) {
    // Past the clip's length: not played
    el('rect', { x: rx(c.length), y: 0, width: Math.max(0, width - rx(c.length)), height, class: 'roll-past' }, roll);
    const g = el('g', {}, roll);
    g.style.setProperty('--h', String(t ? hue(t) : 250));
    c.notes.forEach((n, i) => {
      const r = el('rect', { x: rx(n.start) + 1, y: ry(n.note) + 1, width: Math.max(3, n.length * view.rollZoom - 2), height: ROW - 2, rx: 3, class: `roll-note${selectedNotes.has(n) ? ' selected' : ''}${n.start >= c.length ? ' past' : ''}`, 'data-note': i }, g);
      r.append(title(noteName(n.note)));
    });
    rollPlayhead.setAttribute('y2', String(height));
    roll.append(rollPlayhead);
  }
  if (band) el('rect', { x: Math.min(band.x0, band.x1), y: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0), class: 'roll-band' }, roll);
  // The note names alongside
  rollKeys.setAttribute('width', String(KEYS_W));
  rollKeys.setAttribute('height', String(height));
  rollKeys.replaceChildren();
  for (let n = LOWEST; n <= HIGHEST; n++) {
    el('rect', { x: 0, y: ry(n), width: KEYS_W, height: ROW, class: `roll-key${BLACK.includes(n % 12) ? ' black' : ''}`, 'data-key': n }, rollKeys);
    if (n % 12 === 0) el('text', { x: KEYS_W - 5, y: ry(n) + ROW - 2, class: 'roll-key-label', 'text-anchor': 'end' }, rollKeys).textContent = noteName(n).replace('-', '');
  }
  movePlayhead();
}

/** Scrolls the editor to the clip's notes, or around C-3 */
function centreRoll() {
  const c = openClip;
  const notes = c?.notes.length ? c.notes.map((n) => n.note) : [36, 48];
  const mid = (Math.min(...notes) + Math.max(...notes)) / 2;
  rollScroll.scrollTop = ry(mid) - rollScroll.clientHeight / 2;
}

rollScroll.addEventListener('scroll', () => {
  rollKeys.style.transform = `translateY(${-rollScroll.scrollTop}px)`;
});

type RollDrag =
  | { kind: 'move' | 'length'; x0: number; y0: number; was: Map<SongNote, SongNote>; moved: boolean; sounding: number | null }
  | { kind: 'band'; keep: Set<SongNote> };
let rollDrag: RollDrag | null = null;
let band: { x0: number; y0: number; x1: number; y1: number } | null = null;

const rollPoint = (e: { clientX: number; clientY: number }) => {
  const r = roll.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const rollStep = (x: number) => (x - KEYS_PAD) / view.rollZoom;
const rollNote = (y: number) => Math.max(LOWEST, Math.min(HIGHEST, HIGHEST - Math.floor(y / ROW)));

/** A note sounds while it's dragged, on the clip's track */
function sound(note: number | null, was: number | null): number | null {
  if (note === was) return was;
  if (was !== null) keyUp('roll');
  if (note !== null) void keyDown('roll', note);
  return note;
}

roll.addEventListener('pointerdown', (e) => {
  const c = openClip;
  if (!c || e.button !== 0) return;
  focus = 'roll';
  const ti = song().tracks.findIndex((t) => t.clips.includes(c));
  if (ti >= 0) current = ti;
  roll.setPointerCapture(e.pointerId);
  const p = rollPoint(e);
  const hit = (e.target as Element).closest<SVGElement>('[data-note]');
  if (hit) {
    const n = c.notes[Number(hit.dataset.note)];
    if (e.shiftKey) {
      if (selectedNotes.has(n)) selectedNotes.delete(n);
      else selectedNotes.add(n);
    } else if (!selectedNotes.has(n)) {
      selectedNotes.clear();
      selectedNotes.add(n);
    }
    const right = rx(n.start + n.length);
    const kind = p.x > right - Math.min(8, (n.length * view.rollZoom) / 3) ? 'length' : 'move';
    rollDrag = { kind, x0: p.x, y0: p.y, was: new Map([...selectedNotes].map((m) => [m, { ...m }])), moved: false, sounding: sound(n.note, null) };
    renderEditor();
    return;
  }
  if (isDouble(e)) {
    addNote(c, p);
    return;
  }
  const keep = e.shiftKey ? new Set(selectedNotes) : new Set<SongNote>();
  if (!e.shiftKey) selectedNotes.clear();
  rollDrag = { kind: 'band', keep };
  band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  renderEditor();
});

roll.addEventListener('pointermove', (e) => {
  const d = rollDrag;
  const c = openClip;
  const p = rollPoint(e);
  if (!d || !c) {
    const hit = (e.target as Element).closest<SVGElement>('[data-note]');
    const n = hit && c ? c.notes[Number(hit.dataset.note)] : null;
    roll.style.cursor = n && p.x > rx(n.start + n.length) - Math.min(8, (n.length * view.rollZoom) / 3) ? 'ew-resize' : n ? 'grab' : '';
    return;
  }
  if (d.kind === 'band') {
    band!.x1 = p.x;
    band!.y1 = p.y;
    const [s0, s1] = [rollStep(Math.min(band!.x0, p.x)), rollStep(Math.max(band!.x0, p.x))];
    const [n0, n1] = [rollNote(Math.max(band!.y0, p.y)), rollNote(Math.min(band!.y0, p.y))];
    selectedNotes.clear();
    for (const n of d.keep) selectedNotes.add(n);
    for (const n of c.notes) if (n.start < s1 && n.start + n.length > s0 && n.note >= n0 && n.note <= n1) selectedNotes.add(n);
    renderEditor();
    return;
  }
  const by = Math.round((p.x - d.x0) / view.rollZoom);
  const up = Math.round((d.y0 - p.y) / ROW);
  if (!d.moved && by === 0 && up === 0) return;
  if (!d.moved) {
    before();
    d.moved = true;
  }
  const was = [...d.was.values()];
  if (d.kind === 'move') {
    // All together, kept inside the clip's start and the notes there are
    const shift = Math.max(by, -Math.min(...was.map((n) => n.start)));
    const lift = Math.max(LOWEST - Math.min(...was.map((n) => n.note)), Math.min(HIGHEST - Math.max(...was.map((n) => n.note)), up));
    for (const [n, w] of d.was) {
      n.start = w.start + shift;
      n.note = w.note + lift;
    }
    const first = [...d.was.keys()][0];
    d.sounding = sound(first.note, d.sounding);
  } else {
    for (const [n, w] of d.was) n.length = Math.max(1, w.length + by);
    lastLength = [...d.was.keys()][0].length;
  }
  render();
});

const endRollDrag = () => {
  const d = rollDrag;
  rollDrag = null;
  band = null;
  if (d && d.kind !== 'band') sound(null, d.sounding);
  if (d && d.kind !== 'band' && d.moved) changed();
  else renderEditor();
};
roll.addEventListener('pointerup', endRollDrag);
roll.addEventListener('pointercancel', endRollDrag);

/** Double-clicking the editor adds a note there */
function addNote(c: Clip, p: { x: number; y: number }) {
  const start = Math.max(0, Math.floor(rollStep(p.x)));
  const note = rollNote(p.y);
  before();
  const n = { start, length: lastLength, note };
  c.notes.push(n);
  selectedNotes.clear();
  selectedNotes.add(n);
  void keyDown('roll', note);
  setTimeout(() => keyUp('roll'), 250);
  changed();
}

rollScroll.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = rollScroll.getBoundingClientRect();
    const pointer = e.clientX - r.left;
    const step = rollStep(rollScroll.scrollLeft + pointer);
    view.rollZoom = Math.max(6, Math.min(80, view.rollZoom * Math.exp(-e.deltaY * 0.01)));
    renderEditor();
    rollScroll.scrollLeft = rx(step) - pointer;
    persist();
  },
  { passive: false },
);

// Clicking a note name plays it
rollKeys.addEventListener('pointerdown', (e) => {
  const key = (e.target as Element).closest<SVGElement>('[data-key]');
  if (!key) return;
  void keyDown('keys', Number(key.dataset.key));
  const up = () => {
    keyUp('keys');
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointerup', up);
});

function deleteNotes() {
  const c = openClip;
  if (!c || !selectedNotes.size) return;
  before();
  c.notes = c.notes.filter((n) => !selectedNotes.has(n));
  selectedNotes.clear();
  changed();
}

function moveNotes(by: number, up: number) {
  const c = openClip;
  if (!c || !selectedNotes.size) return;
  const notes = [...selectedNotes];
  if (Math.min(...notes.map((n) => n.start)) + by < 0) return;
  if (Math.min(...notes.map((n) => n.note)) + up < LOWEST || Math.max(...notes.map((n) => n.note)) + up > HIGHEST) return;
  before();
  for (const n of notes) {
    n.start += by;
    n.note += up;
  }
  if (up) {
    void keyDown('arrow', notes[0].note);
    setTimeout(() => keyUp('arrow'), 200);
  }
  changed();
}

function deleteClip() {
  const c = openClip;
  const t = c && trackOf(c);
  if (!c || !t) return;
  before();
  t.clips.splice(t.clips.indexOf(c), 1);
  openClip = null;
  selectedNotes.clear();
  changed();
}

function duplicateClip() {
  const c = openClip;
  const t = c && trackOf(c);
  if (!c || !t) return;
  before();
  const copy = { ...JSON.parse(JSON.stringify(c)), start: c.start + c.span } as Clip;
  t.clips.push(copy);
  openClip = copy;
  selectedNotes.clear();
  changed();
}

// --- Transport and the bar at the bottom ------------------------------------------------------

function renderTransport() {
  const s = song();
  const playBtn = $('play');
  playBtn.textContent = transport.playing ? '■' : '▶';
  playBtn.setAttribute('aria-label', transport.playing ? 'Stop' : 'Play');
  playBtn.classList.toggle('on', transport.playing);
  $('record').classList.toggle('on', transport.recording);
  $('cycle').classList.toggle('on', s.cycling);
  $('cycle').setAttribute('aria-pressed', String(s.cycling));
  const name = $<HTMLInputElement>('song-name');
  if (document.activeElement !== name) name.value = s.name;
  const tempo = $<HTMLSelectElement>('tempo');
  if (!tempo.options.length || tempo.dataset.fps !== String(FPS)) {
    tempo.replaceChildren();
    for (let f = 2; f <= 16; f++) {
      const bpm = (60 * FPS) / (f * s.stepsPerBeat);
      tempo.append(new Option(`${Number.isInteger(bpm) ? bpm : bpm.toFixed(1)} BPM`, String(f)));
    }
    tempo.dataset.fps = String(FPS);
  }
  tempo.value = String(s.stepFrames);
}

function renderTrackNow() {
  const t = track();
  const now = $('track-now');
  now.replaceChildren();
  if (!t) return;
  now.style.setProperty('--h', String(hue(t)));
  const name = document.createElement('b');
  name.textContent = instrumentName(t);
  const voice = document.createElement('span');
  voice.textContent = `voice ${t.voice + 1}`;
  now.append(name, voice);
}

$('play').addEventListener('click', () => (transport.playing ? stop() : void play()));
$('record').addEventListener('click', toggleRecord);
$('to-start').addEventListener('click', toStart);
$('cycle').addEventListener('click', toggleCycle);
$<HTMLInputElement>('song-name').addEventListener('change', (e) => {
  before();
  song().name = (e.target as HTMLInputElement).value.trim() || 'Untitled';
  changed();
});
$<HTMLSelectElement>('tempo').addEventListener('change', (e) => {
  before();
  song().stepFrames = Number((e.target as HTMLSelectElement).value);
  changed();
});

function toggleRecord() {
  if (!transport.playing) void play(true);
  else {
    transport.recording = !transport.recording;
    transport.take = null;
    renderTransport();
  }
}

function toggleCycle() {
  before();
  song().cycling = !song().cycling;
  changed();
  if (transport.playing) void play(transport.recording);
}

function toStart() {
  playhead = song().cycling ? song().cycle.start : 0;
  arrScroll.scrollLeft = 0;
  if (transport.playing) void play(transport.recording);
  else movePlayhead();
}

// The computer keys play the selected track, as in the instrument maker
const KEY_LETTERS = [...'AWSEDFTGYHUJKOLP;'];
const KEYS: Record<string, number> = Object.fromEntries(KEY_LETTERS.map((k, i) => [k.toLowerCase(), i]));

function renderKeyboard() {
  const board = $('keyboard');
  const base = keyboard.octave * 12;
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
    let down: number | null = null;
    board.addEventListener('pointerdown', (e) => {
      const key = keyAt(e);
      if (!key) return;
      e.preventDefault();
      board.setPointerCapture(e.pointerId);
      down = keyboard.octave * 12 + Number(key.dataset.offset);
      void keyDown('mouse', down);
    });
    board.addEventListener('pointermove', (e) => {
      if (down === null) return;
      const key = keyAt(e);
      const note = key ? keyboard.octave * 12 + Number(key.dataset.offset) : null;
      if (note !== null && note !== down) {
        keyUp('mouse');
        down = note;
        void keyDown('mouse', note);
      }
    });
    const end = () => {
      down = null;
      keyUp('mouse');
    };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
  }
  const sounding = new Set([...held.values()].map((h) => h.note));
  const labels = $('key-labels');
  labels.replaceChildren();
  for (const key of board.querySelectorAll<HTMLElement>('.key')) {
    const offset = Number(key.dataset.offset);
    const n = base + offset;
    key.classList.toggle('down', sounding.has(n));
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

function octave(by: number) {
  keyboard.octave = Math.max(0, Math.min(6, keyboard.octave + by));
  renderKeyboard();
}
$('octave-down').addEventListener('click', () => octave(-1));
$('octave-up').addEventListener('click', () => octave(1));

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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && !typing(e)) {
    e.preventDefault();
    duplicateClip();
    return;
  }
  if (e.key === 'Escape') {
    if (typing(e)) (e.target as HTMLElement).blur();
    stop();
    selectedNotes.clear();
    renderEditor();
    return;
  }
  if (e.key === 'Enter' && typing(e)) {
    (e.target as HTMLElement).blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (focus === 'roll' && selectedNotes.size) deleteNotes();
    else deleteClip();
    return;
  }
  if (focus === 'roll' && selectedNotes.size && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const oct = e.shiftKey ? 12 : 1;
    if (e.key === 'ArrowUp') moveNotes(0, oct);
    else if (e.key === 'ArrowDown') moveNotes(0, -oct);
    else if (e.key === 'ArrowLeft') moveNotes(-1, 0);
    else moveNotes(1, 0);
    return;
  }
  if (e.repeat) return;
  if (e.key === ' ' && !(e.target as HTMLElement).matches('button, select')) {
    e.preventDefault();
    if (transport.playing) stop();
    else void play();
    return;
  }
  if (e.key === 'Enter' || e.key === 'Home') {
    e.preventDefault();
    toStart();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'r') return toggleRecord();
  if (k === 'c') return toggleCycle();
  if (k === 'z') return octave(-1);
  if (k === 'x') return octave(1);
  const offset = KEYS[k];
  if (offset === undefined) return;
  e.preventDefault();
  void keyDown(k, Math.min(HIGHEST, keyboard.octave * 12 + offset));
});
window.addEventListener('keyup', (e) => keyUp(e.key.toLowerCase()));
window.addEventListener('blur', () => [...held.keys()].forEach(keyUp));
document.addEventListener('visibilitychange', () => document.hidden && stop());

// The clock and chip, shared with the other pages
function renderClock() {
  for (const b of $('clock').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', (b.dataset.ntsc === '1') === ntsc);
}
renderClock();
player.setSettings(settings);
$('clock').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ntsc]');
  if (!b) return;
  stop();
  ntsc = b.dataset.ntsc === '1';
  FPS = ntsc ? 60 : 50;
  settings = { ...settings, ntsc };
  saveNtsc(ntsc);
  player.setSettings(settings);
  renderClock();
  render();
});
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

window.addEventListener('resize', () => render());

// --- Start ---------------------------------------------------------------------------------------

sendSounds();
render();
renderKeyboard();
centreRoll();

let analyzer: Analyzer | null = null;
Analyzer.create()
  .then((a) => (analyzer = a))
  .catch((err) => toast(`Engine failed to start: ${err}`));

// For scripts/browsertest.mjs
Object.assign(window, {
  songMaker: {
    song,
    ready: () => analyzer !== null,
    render: () => changed(),
    /** The chip's registers frame by frame, playing the song from a step (as Play would, with the cycle if on) */
    trace: (frames: number, fromStep = 0) => {
      const { sounds: list, trackSound: numbers } = songSounds(song(), byId);
      const t = soundTables(sounds(list.map((s) => ({ shape: s.shape, voices: 1 << s.voice }))));
      const sf = song().stepFrames;
      const cycle = song().cycling ? { start: song().cycle.start * sf, end: song().cycle.end * sf } : null;
      const seq = songSequence(song(), list, numbers, fromStep * sf, cycle);
      return analyzer!.traceSequence(t.tables, t.instruments, seq, frames, settings).map((r) => Array.from(r));
    },
    instruments: () => instruments,
    playing: () => transport.playing,
    openClip: () => openClip,
  },
});
