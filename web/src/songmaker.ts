// The song maker: tracks of notes along a timeline, each for an instrument
// from the Instrument Maker, played on one of the chip's three voices. Tracks
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
import { addInstruments, loadInstruments, sound as soundOf, sounds, soundTables, STORAGE_KEY as INSTRUMENTS_KEY, type Sound } from './instruments';
import { resumeSound, vibratoStart, type ResumeTraces } from './resume';
import { noteName } from './song';
import { importGoatSong, ROW_TO_NOTE } from './songimport';
import { exportSong } from './songexport';
import { slideSemitones, vibratoCurve, wobbleOf, wobbleRow } from './vibrato';
import { audible, songRows, type ResumedNote, bpmAt, songSpeeds, type NoteEffect, type Speed, clipNotes, frameAt, newId, stepAt as stepOfFrame, songEnd, songFrame, songSequence, songSounds, voiceSegments, VOICES, type Clip, type SongDoc, type SongNote, type Track } from './songdoc';
import type { Shape } from './shape';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

let ntsc = loadNtsc();
let FPS = ntsc ? 60 : 50;
let settings: Settings = { ...DEFAULT_SETTINGS, ntsc };

const SONG_KEY = 'sidkid.song2.v1';
const TEMPO_MIN = 30;
const TEMPO_MAX = 300;
/** Instrument timelines are this long (only for bringing old saves up to date) */
const INSTRUMENT_SECONDS = 32;

/** Arrangement: the ruler (the cycle along its top), then a lane per track */
const RULER_H = 32;
/** How wide the cycle's ends are to grab */
const CYCLE_GRIP = 14;
const CYCLE_H = 12;
const LANE_H = 56;
const EDGE = 7;
/** Editor: a row per semitone, all of GoatTracker's notes */
const ROW = 11;
const LOWEST = 0;
const HIGHEST = 95;
const KEYS_W = 44;

interface Saved {
  songs: SongDoc[];
  /** The song open */
  current: number;
  /** Pixels a step, in the arrangement and in the editor */
  zoom: number;
  rollZoom: number;
  /** Clicks on the beats while playing; a bar of them before recording */
  metronome: boolean;
  countIn: boolean;
  /** The clip open in the editor: its track and place in it */
  open?: ClipRef | null;
}

function defaultSong(): SongDoc {
  return {
    name: 'New song',
    bpm: 125,
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
    const saved = JSON.parse(localStorage.getItem(SONG_KEY) ?? 'null') as (Saved & { song?: SongDoc }) | null;
    // Saved when there was one song
    if (saved?.song && !saved.songs) {
      saved.songs = [saved.song];
      saved.current = 0;
      delete saved.song;
    }
    if (saved?.songs?.length) {
      for (const old of saved.songs as (SongDoc & { stepFrames?: number })[]) {
        // Songs saved with whole frames a step: the tempo that was (on PAL)
        if (old.bpm === undefined) {
          old.bpm = Math.round(((60 * 50) / ((old.stepFrames ?? 6) * old.stepsPerBeat)) * 10) / 10;
          delete old.stepFrames;
        }
      }
      return { ...saved, current: Math.min(saved.current ?? 0, saved.songs.length - 1), zoom: saved.zoom ?? 6, rollZoom: saved.rollZoom ?? 22, metronome: saved.metronome ?? true, countIn: saved.countIn ?? true };
    }
  } catch {
    // Unreadable or blocked storage: start afresh
  }
  return { songs: [defaultSong()], current: 0, zoom: 6, rollZoom: 22, metronome: true, countIn: true };
}

const view = load();
const song = () => view.songs[view.current];
const barSteps = () => song().stepsPerBeat * song().beatsPerBar;
/** Steps to frames and back, at the song's tempo and the machine's clock */
const toFrame = (step: number) => frameAt(song(), step, FPS);
const toStep = (frame: number) => stepOfFrame(song(), frame, FPS);

/** A clip by its track's id (tracks move) and its place in the track, to find it again after a reload or an undo */
type ClipRef = { track: string; clip: number };
function clipRef(c: Clip | null): ClipRef | null {
  if (!c) return null;
  const track = song().tracks.find((t) => t.clips.includes(c));
  return track ? { track: track.id, clip: track.clips.indexOf(c) } : null;
}
const clipAt = (ref: ClipRef | null | undefined): Clip | null => (ref ? (song().tracks.find((t) => t.id === ref.track)?.clips[ref.clip] ?? null) : null);

function persist() {
  view.open = clipRef(openClip);
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

/** A song as it was (its place in the list), or the whole list (when songs come and go) */
type Undo = { at: number; song: string } | { songs: string; current: number };
const undoStack: Undo[] = [];
const redoStack: Undo[] = [];
const now = (like: Undo): Undo => ('song' in like ? { at: like.at, song: JSON.stringify(view.songs[like.at]) } : { songs: JSON.stringify(view.songs), current: view.current });

/** Call before a change to the song open, once per drag or edit */
function before() {
  push({ at: view.current, song: JSON.stringify(song()) });
}

/** Call before songs are added or removed */
function beforeSongs() {
  push({ songs: JSON.stringify(view.songs), current: view.current });
}

function push(u: Undo) {
  undoStack.push(u);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function undo(redo = false) {
  const from = redo ? redoStack : undoStack;
  const to = redo ? undoStack : redoStack;
  const u = from.pop();
  if (!u) return;
  to.push(now(u));
  const ref = clipRef(openClip);
  const switching = 'song' in u ? u.at !== view.current : true;
  if ('song' in u) {
    view.songs[u.at] = JSON.parse(u.song);
    view.current = u.at;
  } else {
    view.songs = JSON.parse(u.songs);
    view.current = Math.min(u.current, view.songs.length - 1);
  }
  // The same clip stays open, if it's still there
  openClip = clipAt(ref);
  selectedNotes.clear();
  current = Math.max(0, Math.min(current, song().tracks.length - 1));
  if (switching) stop();
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

// Instruments edited in the Instrument Maker (another tab) come straight over
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
  /** Whether this play started with a count-in */
  countIn: false,
};

function playRange(): { from: number; cycle: { start: number; end: number } | null } {
  const s = song();
  let from = toFrame(playhead);
  const cycle = s.cycling ? { start: toFrame(s.cycle.start), end: toFrame(s.cycle.end) } : null;
  if (cycle && (from < cycle.start || from >= cycle.end)) from = cycle.start;
  if (!cycle && from >= toFrame(songEnd(s))) from = 0;
  return { from, cycle };
}

/** How long playing goes on past a song's end, with nothing there (a blank song) or recording on past it: till stopped, in effect */
const PLAY_ON_SECONDS = 30 * 60;

function restartSequence(keep: boolean) {
  const on = !transport.cycle && (transport.recording || songEnd(song()) === 0);
  const plan = songPlan(transport.from, transport.cycle, { click: view.metronome, countIn: transport.countIn, ...(on ? { until: transport.from + PLAY_ON_SECONDS * FPS } : {}) });
  trackSound = plan.trackSound;
  player.setTables(plan.tables);
  plan.instruments.forEach((ins, i) => player.setInstrument(i + 1, ins));
  transport.seq = plan.seq;
  player.sequence(plan.seq, keep);
}

/** GoatTracker's limits: instruments 1-63, and tables of 255 rows */
const MAX_INSTRUMENTS = 63;
const TABLE_ROWS = 255;

/**
 * Everything to play the song from a frame: its sounds, then a variant for
 * each note that gets its voice back and picks up where it left off (alike
 * ones shared), as long as they fit GoatTracker's instruments and tables
 * (past that, notes start again instead), and the timed notes.
 */
function songPlan(from: number, cycle: { start: number; end: number } | null, metronome: { click: boolean; countIn: boolean; until?: number }, doc: SongDoc = song(), shapes: Map<string, Shape> = byId, fps = FPS) {
  const { sounds: list, trackSound: numbers } = songSounds(doc, shapes);
  const base = sounds(list.map((s) => ({ shape: s.shape, voices: 1 << s.voice })));
  const all = [...base];
  const made = new Map<string, number | 'silent' | null>();
  const alike = new Map<string, number>();
  const fits = () => all.length <= MAX_INSTRUMENTS && soundTables(all).rows.every((r) => r <= TABLE_ROWS);
  const resume = (n: number, at: number, held: ResumedNote) => {
    const key = `${n}/${at}/${held.step}/${held.note}`;
    if (!made.has(key)) {
      const v = all.length < MAX_INSTRUMENTS ? resumeOf(base[n - 1], 1 << list[n - 1].voice, at, { doc, track: doc.tracks[held.track], held, fps }) : null;
      let r: number | 'silent' | null = v === 'silent' ? 'silent' : null;
      if (v && v !== 'silent') {
        const same = variantKey(n, v);
        if (alike.has(same)) r = alike.get(same)!;
        else {
          all.push(v);
          if (fits()) {
            r = all.length;
            alike.set(same, r);
          } else all.pop();
        }
      }
      made.set(key, r);
    }
    return made.get(key)!;
  };
  // The speeds the notes' slides and effects use, after the instruments' in the speed table
  const speeds = songSpeeds(doc);
  const speedKey = (sp: Speed) => `${sp.left}/${sp.right}`;
  const speedIndex = new Map(speeds.map((sp, i) => [speedKey(sp), i]));
  const at = () => soundTables(all, speeds).extraSpeedsAt;
  let speedsAt = at();
  const speedRow = (sp: Speed | null) => (sp ? speedsAt + (speedIndex.get(speedKey(sp)) ?? 0) : 0);
  let seq = songSequence(doc, list, numbers, from, cycle, fps, metronome, resume, speedRow);
  const t = soundTables(all, speeds);
  // (resumes added while the sequence was made moved the speeds on: make it again with them where they are)
  if (t.extraSpeedsAt !== speedsAt) {
    speedsAt = t.extraSpeedsAt;
    seq = songSequence(doc, list, numbers, from, cycle, fps, metronome, resume, speedRow);
  }
  return { seq, tables: t.tables, instruments: t.instruments, trackSound: numbers, sounds: list, resume, speedRow };
}

/** What a variant plays, to share one between notes picked up at the same point */
function variantKey(n: number, v: Sound): string {
  const prog = (p: { steps: { left: number; right: number }[]; next: { step: number } | null } | null) => (p ? [p.steps.map((x) => [x.left, x.right]), p.next?.step ?? null] : null);
  return JSON.stringify([n, prog(v.wave), prog(v.pulse), prog(v.filter), v.overrides]);
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
  transport.countIn = record && view.countIn;
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
  if (f !== null) playhead = toStep(f);
  renderTransport();
  render();
}

player.onStatus = (status) => {
  if (!transport.playing) return;
  if (status.sequence === null) {
    // Played to the end (statuses from before it started don't count)
    if (transport.at !== null) {
      stop();
      playhead = toStep(transport.from);
      render();
    }
    return;
  }
  transport.at = status.sequence;
  transport.atTime = performance.now();
};

/** The sequence's frame being heard now (negative while counting in) */
function heardSeqFrame(): number {
  const seq = transport.seq;
  if (transport.at === null || !seq) return -(seq?.preroll ?? 0);
  return transport.at + ((performance.now() - transport.atTime) / 1000 - player.latency) * FPS;
}

/** The song frame being heard now, or null before the first note */
function liveFrame(): number | null {
  const seq = transport.seq;
  if (!transport.playing || !seq) return null;
  if (transport.at === null) return transport.from;
  let f = heardSeqFrame();
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
      $('position').classList.remove('counting');
      movePlayhead();
      return;
    }
    if (!scrubbing) {
      playhead = toStep(f);
      movePlayhead(true);
    }
    // Counting in: the beats to go, in place of the position
    const ahead = -heardSeqFrame();
    // (a beat's frames at the tempo where playing starts)
    const beat = toFrame(toStep(transport.from) + song().stepsPerBeat) - transport.from;
    const counting = transport.countIn && ahead > 0;
    $('position').classList.toggle('counting', counting);
    if (counting) $('position').textContent = String(Math.ceil(ahead / beat));
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
  const start = Math.round(toStep(from));
  let length = Math.round(toStep(to)) - start;
  // Let go after coming round the cycle
  if (length < 0 && transport.cycle) length += song().cycle.end - song().cycle.start;
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
/** The tempo lane, under the ruler; the tracks under it */
const TEMPO_H = 34;
const TRACKS_TOP = RULER_H + TEMPO_H;
const laneTop = (i: number) => TRACKS_TOP + i * LANE_H;
/** Steps the arrangement shows: the song and room after it */
const arrSteps = () => {
  const bar = barSteps();
  const end = Math.max(songEnd(song()), song().cycle.end, Math.ceil(playhead));
  return Math.max(Math.ceil(end / bar) + 8, Math.ceil(arrScroll.clientWidth / (bar * view.zoom)) + 1) * bar;
};
/** Clip moves and edges snap to beats, or to steps zoomed in */
const snap = () => (view.zoom >= 14 ? 1 : song().stepsPerBeat);

function render() {
  renderSongs();
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
  const tempoHead = document.createElement('div');
  tempoHead.className = 'heads-tempo';
  tempoHead.textContent = 'Tempo';
  tempoHead.title = 'Drag a point up or down to change the tempo, or sideways to move it. Double-click to add a change, or a point to remove it; ⌥-click a point to ramp to it.';
  heads.append(spacer, tempoHead);
  song().tracks.forEach((t, i) => {
    const head = document.createElement('div');
    head.className = `track-head${i === current ? ' current' : ''}${t.muted ? ' muted' : ''}`;
    head.style.setProperty('--h', String(hue(t)));
    // Selecting it leaves the heads in place, so a click on one of its buttons isn't lost
    // (and puts down any clip picked up: Delete then asks about the track)
    head.addEventListener('pointerdown', () => {
      if (openClip) {
        openClip = null;
        selectedNotes.clear();
        renderEditor();
      }
      if (current === i) return renderArrangement();
      current = i;
      heads.querySelectorAll('.track-head').forEach((h, k) => h.classList.toggle('current', k === i));
      renderArrangement();
      renderTrackNow();
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
    const solo = document.createElement('button');
    solo.className = `mini track-solo${t.solo ? ' set' : ''}`;
    solo.textContent = 'S';
    solo.title = t.solo ? 'Soloed: click to hear the others too' : 'Solo this track (with any others soloed)';
    solo.setAttribute('aria-pressed', String(!!t.solo));
    solo.addEventListener('click', () => {
      before();
      if (t.solo) delete t.solo;
      else t.solo = true;
      changed();
    });
    const row = document.createElement('div');
    row.className = 'track-row';
    const voiceLabel = document.createElement('span');
    voiceLabel.className = 'voice-label';
    voiceLabel.textContent = 'Voice';
    row.append(voiceLabel, voices, mute, solo);
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

// Dragging a track's head (not its menu or buttons) moves the track up or down, its clips with it
const headsEl = $('track-heads');
let trackDrag: { from: number; y0: number; moved: boolean } | null = null;
headsEl.addEventListener('pointerdown', (e) => {
  const head = (e.target as HTMLElement).closest<HTMLElement>('.track-head');
  if (!head || e.button !== 0 || (e.target as HTMLElement).closest('button, select')) return;
  trackDrag = { from: [...headsEl.querySelectorAll('.track-head')].indexOf(head), y0: e.clientY, moved: false };
  headsEl.setPointerCapture(e.pointerId);
});
headsEl.addEventListener('pointermove', (e) => {
  const d = trackDrag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientY - d.y0) < 4) return;
  if (!d.moved) {
    before();
    d.moved = true;
    dragCursor('grabbing');
  }
  const tracks = song().tracks;
  const top = headsEl.getBoundingClientRect().top + TRACKS_TOP;
  const to = Math.max(0, Math.min(tracks.length - 1, Math.floor((e.clientY - top) / LANE_H)));
  if (to === d.from) return;
  const [moving] = tracks.splice(d.from, 1);
  tracks.splice(to, 0, moving);
  current = to;
  d.from = to;
  render();
});
const endTrackDrag = () => {
  const d = trackDrag;
  trackDrag = null;
  if (!d?.moved) return;
  dragCursor(null);
  changed();
};
headsEl.addEventListener('pointerup', endTrackDrag);
headsEl.addEventListener('pointercancel', endTrackDrag);

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
  // Its ends, to drag (drawn over the middle, which moves it)
  // (the ruler's full height while cycling, where they show as grips)
  for (const end of ['start', 'end'] as const) {
    const at = ax(end === 'start' ? c.start : c.end);
    const h = s.cycling ? RULER_H : CYCLE_H;
    const g = el('g', { class: 'arr-cycle-end', 'data-cycle-end': end }, arr);
    el('rect', { x: at - CYCLE_GRIP / 2, y: 0, width: CYCLE_GRIP, height: h, class: 'arr-cycle-hit' }, g);
    if (s.cycling) el('rect', { x: at - (end === 'start' ? 0 : 3), y: 2, width: 3, height: h - 4, rx: 1.5, class: 'arr-cycle-grip' }, g);
    g.append(title(end === 'start' ? 'Drag to move where the cycle starts' : 'Drag to move where the cycle ends'));
  }
  if (s.cycling) el('rect', { x: ax(c.start), y: RULER_H, width: ax(c.end - c.start), height: height - RULER_H, class: 'arr-cycle-band' }, arr);
  drawTempo(steps);
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
    const heard = voiceSegments(s, t.voice, FPS).filter((g) => g.track === i);
    t.clips.forEach((clip, k) => drawClip(t, i, clip, k, heard));
  });
  playheadLine.setAttribute('y2', String(height));
  arr.append(playheadLine);
  renderZoom();
  movePlayhead();
}

function drawClip(t: Track, ti: number, clip: Clip, k: number, heard: { start: number; end: number }[]) {
  const s = song();
  const top = laneTop(ti) + 3;
  const h = LANE_H - 6;
  const g = el('g', { class: `clip2${clip === openClip ? ' open' : ''}${audible(s, t) ? '' : ' muted'}`, 'data-track': ti, 'data-clip': k }, arr);
  g.style.setProperty('--h', String(hue(t)));
  const x0 = ax(clip.start);
  const w = Math.max(4, ax(clip.span));
  // One outline round the piece and its repeats, notched where each repeat
  // starts (no line down: it's all one clip); the piece itself darker
  const piece = Math.max(4, ax(Math.min(clip.length, clip.span)));
  const repeats: number[] = [];
  for (let at = clip.length; at < clip.span; at += clip.length) repeats.push(x0 + ax(at));
  const outline = clipOutline(x0 + 0.5, top + 0.5, w - 1, h - 1, repeats);
  g.dataset.repeats = String(repeats.length);
  if (repeats.length) el('path', { d: outline, class: 'clip2-repeat' }, g);
  el('rect', { x: x0 + 0.5, y: top + 0.5, width: piece - 1, height: h - 1, rx: CLIP_R, class: 'clip2-body' }, g);
  el('path', { d: outline, class: 'clip2-outline' }, g);
  // Its notes, scaled to the clip's range of pitch
  const notes = clipNotes(clip);
  if (notes.length) {
    const lo = Math.min(...notes.map((n) => n.note));
    const hi = Math.max(...notes.map((n) => n.note));
    const range = Math.max(12, hi - lo);
    const ny = (n: number) => top + 6 + (1 - (n - lo + (range - (hi - lo)) / 2) / range) * (h - 14);
    for (const n of notes) {
      const from = toFrame(n.start);
      const to = toFrame(n.start + n.length);
      const stolen = !heard.some((g) => g.start <= from && g.end >= to);
      el('rect', { x: ax(n.start) + 0.5, y: ny(n.note) - 1.5, width: Math.max(1.5, ax(n.length) - 1), height: 3, rx: 1, class: `clip2-note${n.start >= clip.start + clip.length ? ' again' : ''}${stolen ? ' stolen' : ''}` }, g);
    }
  }
  // Pull handles: the piece's length (its lower right) and the repeat (the clip's upper right)
  const right = x0 + piece;
  const extend = el('g', { class: 'clip2-extend', 'data-edge': 'length' }, g);
  el('rect', { x: right - EDGE * 2, y: top + h / 2, width: EDGE * 2, height: h / 2, class: 'clip2-edge' }, extend);
  const ey = top + h - 9;
  el('path', { d: `M${right - 12},${ey}h7m-2.6,-2.6l2.6,2.6l-2.6,2.6M${right - 3.5},${ey - 4}v8`, class: 'clip2-icon' }, extend);
  extend.append(title(clip.span > clip.length ? 'Drag to change the length of the piece that repeats' : 'Drag to change the length'));
  const loop = el('g', { class: 'clip2-loop', 'data-edge': 'span' }, g);
  el('rect', { x: x0 + w - EDGE * 2, y: top, width: EDGE * 2, height: h / 2, class: 'clip2-edge' }, loop);
  el('path', { d: `M${x0 + w - 11},${top + 9}a4,4 0 1 1 1.5,3.1m-1.5,-3.1l-1.4,-2.6m1.4,2.6l2.6,-1.3`, class: 'clip2-icon' }, loop);
  loop.append(title('Drag to repeat'));
}

/** While dragging, the cursor stays what the drag is (a closed hand, or arrows), wherever the pointer goes */
function dragCursor(cursor: string | null) {
  document.documentElement.classList.toggle('drag-cursor', cursor !== null);
  if (cursor) document.documentElement.style.setProperty('--drag-cursor', cursor);
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

const CLIP_R = 5;

/**
 * A clip's outline: a rounded box, with a notch in its top and bottom edges
 * at each repeat (the corners of the pieces either side, meeting).
 */
function clipOutline(x: number, y: number, w: number, h: number, notches: number[]): string {
  const r = Math.min(CLIP_R, w / 2, h / 2);
  // A notch is two corners, so no wider than the room either side of it
  const cuts = notches.map((at, i) => ({ at, r: Math.max(0, Math.min(r, (at - (notches[i - 1] ?? x)) / 2, ((notches[i + 1] ?? x + w) - at) / 2)) }));
  const arc = (rr: number, toX: number, toY: number) => `A${rr},${rr} 0 0 1 ${toX},${toY}`;
  let d = `M${x},${y + r}${arc(r, x + r, y)}`;
  for (const c of cuts) d += `L${c.at - c.r},${y}${arc(c.r, c.at, y + c.r)}${arc(c.r, c.at + c.r, y)}`;
  d += `L${x + w - r},${y}${arc(r, x + w, y + r)}L${x + w},${y + h - r}${arc(r, x + w - r, y + h)}`;
  for (const c of [...cuts].reverse()) d += `L${c.at + c.r},${y + h}${arc(c.r, c.at, y + h - c.r)}${arc(c.r, c.at - c.r, y + h)}`;
  return `${d}L${x + r},${y + h}${arc(r, x, y + h - r)}Z`;
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
  const tempoBox = $<HTMLInputElement>('tempo');
  if (document.activeElement !== tempoBox) tempoBox.value = bpmText(bpmAt(song(), Math.floor(playhead)));
  if (follow) {
    const left = arrScroll.scrollLeft;
    const w = arrScroll.clientWidth;
    if (x > left + w - 40 || x < left) arrScroll.scrollLeft = Math.max(0, x - 40);
  }
  // In the editor, where the open clip is up to (with none open, the song from its start)
  const c = openClip;
  const inClip = !c || (playhead >= c.start && playhead < c.start + c.span);
  rollPlayhead.style.display = inClip ? '' : 'none';
  if (inClip) {
    const rx = KEYS_PAD + (c ? (playhead - c.start) % c.length : playhead) * view.rollZoom + 0.5;
    rollPlayhead.setAttribute('x1', String(rx));
    rollPlayhead.setAttribute('x2', String(rx));
  }
}

// Arrangement pointer: ruler (cycle along its top), clips (moved, lengthened, repeated), lanes
type ArrDrag =
  | { kind: 'seek' }
  | { kind: 'tempo'; at: number; x0: number; y0: number; step: number; bpm: number; scale: { lo: number; hi: number }; moved: boolean }
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
    const end = target.closest<SVGElement>('[data-cycle-end]')?.dataset.cycleEnd as 'start' | 'end' | undefined;
    if (end || target.closest('[data-cycle]')) {
      const c = s.cycle;
      arrDrag = { kind: 'cycle', what: end ?? 'move', x0: p.x, start: c.start, end: c.end };
      dragCursor(end ? 'ew-resize' : 'grabbing');
      before();
    } else if (p.y < CYCLE_H) {
      before();
      const at = Math.round(stepAt(p.x) / snap()) * snap();
      arrDrag = { kind: 'cycle-new', from: at };
      dragCursor('ew-resize');
    } else {
      arrDrag = { kind: 'seek' };
      scrubTo(stepAt(p.x));
    }
    return;
  }
  if (p.y < TRACKS_TOP) {
    tempoDown(e, p, target);
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
    dragCursor(edge ? 'ew-resize' : e.altKey ? 'copy' : 'grabbing');
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
  if (!d) return;
  const by = Math.round((p.x - ('x0' in d ? d.x0 : p.x)) / view.zoom / snap()) * snap();
  if (d.kind === 'tempo') tempoMove(d, p, e);
  else if (d.kind === 'seek') scrubTo(stepAt(p.x));
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
      const lane = Math.max(0, Math.min(s.tracks.length - 1, Math.floor((p.y - TRACKS_TOP) / LANE_H)));
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
  tempoScale = null;
  dragCursor(null);
  if (!d) return;
  if (d.kind === 'seek') endScrub();
  if (d.kind === 'tempo' && d.moved) changed();
  if (d.kind === 'clip' && d.moved) changed();
  else if (d.kind === 'cycle' || d.kind === 'cycle-new') changed();
};
arr.addEventListener('pointerup', endArrDrag);
arr.addEventListener('pointercancel', endArrDrag);

// --- The tempo lane: the song's tempo from the start, and where it changes ---------------------------

const TEMPO_MIN_SPAN = 20;
/** The tempos the lane shows, top to bottom (held while a point is dragged, so it doesn't move under the pointer) */
let tempoScale: { lo: number; hi: number } | null = null;
function tempoRange(): { lo: number; hi: number } {
  if (tempoScale) return tempoScale;
  const s = song();
  const all = [s.bpm, ...(s.tempo ?? []).map((c) => c.bpm)];
  const mid = (Math.min(...all) + Math.max(...all)) / 2;
  const half = Math.max(TEMPO_MIN_SPAN, Math.max(...all) - Math.min(...all)) / 2 + 4;
  return { lo: mid - half, hi: mid + half };
}
const tempoY = (bpm: number, r = tempoRange()) => RULER_H + 5 + (1 - (bpm - r.lo) / (r.hi - r.lo)) * (TEMPO_H - 10);
const bpmOfY = (y: number, r: { lo: number; hi: number }) => r.lo + (1 - (y - RULER_H - 5) / (TEMPO_H - 10)) * (r.hi - r.lo);
const bpmText = (bpm: number) => (Number.isInteger(Math.round(bpm * 10) / 10) ? String(Math.round(bpm)) : (Math.round(bpm * 10) / 10).toFixed(1));

/** The points: the start (index 0, the song's own tempo) and each change */
function tempoPoints(): { step: number; bpm: number; ramp: boolean }[] {
  const s = song();
  return [{ step: 0, bpm: s.bpm, ramp: false }, ...(s.tempo ?? []).map((c) => ({ step: c.step, bpm: c.bpm, ramp: !!c.ramp }))];
}

function drawTempo(steps: number) {
  const width = ax(steps);
  el('rect', { x: 0, y: RULER_H, width, height: TEMPO_H, class: 'arr-tempo', 'data-tempo-lane': '' }, arr);
  el('line', { x1: 0, x2: width, y1: TRACKS_TOP - 0.5, y2: TRACKS_TOP - 0.5, class: 'arr-lane-line' }, arr);
  const pts = tempoPoints();
  // Held from each point to the next, or ramped into the next
  let d = `M0,${tempoY(pts[0].bpm)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    d += p.ramp ? `L${ax(p.step)},${tempoY(p.bpm)}` : `H${ax(p.step)}V${tempoY(p.bpm)}`;
  }
  d += `H${width}`;
  el('path', { d, class: 'arr-tempo-line' }, arr);
  pts.forEach((p, i) => {
    const g = el('g', { class: 'arr-tempo-point', 'data-tempo': i }, arr);
    el('circle', { cx: ax(p.step), cy: tempoY(p.bpm), r: 8, class: 'hit' }, g);
    el('circle', { cx: ax(p.step), cy: tempoY(p.bpm), r: 3.5, class: 'dot' }, g);
    const label = el('text', { x: ax(p.step) + 6, y: tempoY(p.bpm) < RULER_H + TEMPO_H / 2 ? tempoY(p.bpm) + 11 : tempoY(p.bpm) - 4, class: 'arr-tempo-label' }, g);
    label.textContent = bpmText(p.bpm);
    g.append(title(i ? `${bpmText(p.bpm)} BPM from here${p.ramp ? ', ramping to it' : ''}. Drag to change; double-click to remove; ⌥-click to ${p.ramp ? 'hold' : 'ramp'}.` : `${bpmText(p.bpm)} BPM from the start. Drag up or down to change.`));
  });
}

/** The tempo changes, as points (the start dropped back to the song's own tempo) */
function setTempoPoints(pts: { step: number; bpm: number; ramp: boolean }[]) {
  const s = song();
  s.bpm = pts[0].bpm;
  const rest = pts.slice(1).map((p) => ({ step: p.step, bpm: p.bpm, ...(p.ramp ? { ramp: true } : {}) }));
  if (rest.length) s.tempo = rest;
  else delete s.tempo;
}

function tempoDown(e: PointerEvent, p: { x: number; y: number }, target: Element) {
  const hit = target.closest<SVGElement>('[data-tempo]');
  const pts = tempoPoints();
  if (hit) {
    const at = Number(hit.dataset.tempo);
    if (isDouble(e) && at > 0) {
      before();
      pts.splice(at, 1);
      setTempoPoints(pts);
      changed();
      return;
    }
    if (e.altKey && at > 0) {
      before();
      pts[at].ramp = !pts[at].ramp;
      setTempoPoints(pts);
      changed();
      return;
    }
    tempoScale = tempoRange();
    arrDrag = { kind: 'tempo', at, x0: p.x, y0: p.y, step: pts[at].step, bpm: pts[at].bpm, scale: tempoScale, moved: false };
    dragCursor('grabbing');
    return;
  }
  // Double-clicking the lane adds a change there, at the tempo it already is (drag it to change it)
  if (isDouble(e)) {
    const step = Math.max(snap(), Math.round(stepAt(p.x) / snap()) * snap());
    if (pts.some((q) => q.step === step)) return;
    before();
    pts.push({ step, bpm: Math.round(bpmAt(song(), step) * 10) / 10, ramp: false });
    pts.sort((a, b) => a.step - b.step);
    setTempoPoints(pts);
    changed();
  }
}

function tempoMove(d: Extract<ArrDrag, { kind: 'tempo' }>, p: { x: number; y: number }, e: PointerEvent) {
  if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 3) return;
  if (!d.moved) {
    before();
    d.moved = true;
  }
  const pts = tempoPoints();
  // Up and down: the tempo, to whole beats a minute (tenths with ⇧)
  const raw = d.bpm + bpmOfY(p.y, d.scale) - bpmOfY(d.y0, d.scale);
  const bpm = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, e.shiftKey ? Math.round(raw * 10) / 10 : Math.round(raw)));
  pts[d.at].bpm = bpm;
  // Sideways (not the start): between its neighbours
  if (d.at > 0) {
    const step = Math.round((d.step + (p.x - d.x0) / view.zoom) / snap()) * snap();
    const lo = pts[d.at - 1].step + 1;
    const hi = (pts[d.at + 1]?.step ?? Infinity) - 1;
    pts[d.at].step = Math.max(lo, Math.min(hi, step));
  }
  setTempoPoints(pts);
  renderArrangement();
  renderTransport();
}

/** Double-clicking in a lane makes a clip a bar long there */
function addClip(p: { x: number; y: number }) {
  const ti = Math.floor((p.y - TRACKS_TOP) / LANE_H);
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

const MIN_ZOOM = 1.5;
const MAX_ZOOM = 40;

/** Where the song's clips are, in steps (null: none yet) */
function contentRange(): { from: number; to: number } | null {
  const clips = song().tracks.flatMap((t) => t.clips);
  if (!clips.length) return null;
  return { from: Math.min(...clips.map((c) => c.start)), to: Math.max(...clips.map((c) => c.start + c.span)) };
}

/**
 * Zooms around a point on screen (the pointer, when pinching or scrolling),
 * or else around the song: the part of it nearest the middle of the view
 * stays put, and a song that fits is kept in view.
 */
function zoomTo(z: number, pointer?: number) {
  const width = arrScroll.clientWidth;
  let at: number;
  let step: number;
  if (pointer !== undefined) {
    at = pointer;
    step = (arrScroll.scrollLeft + pointer) / view.zoom;
  } else {
    const mid = (arrScroll.scrollLeft + width / 2) / view.zoom;
    const c = contentRange() ?? { from: playhead, to: playhead };
    step = Math.max(c.from, Math.min(c.to, mid));
    at = ax(step) - arrScroll.scrollLeft;
    if (at < 0 || at > width) at = width / 2;
  }
  view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  renderArrangement();
  arrScroll.scrollLeft = step * view.zoom - at;
  if (pointer === undefined) {
    const c = contentRange();
    // All of a song that fits, else as much of it as the view holds
    if (c && ax(c.to) - ax(c.from) <= width - 16) {
      const left = arrScroll.scrollLeft;
      if (ax(c.from) < left || ax(c.to) > left + width) arrScroll.scrollLeft = Math.max(0, ax(c.from) - 8);
    } else if (c) {
      arrScroll.scrollLeft = Math.max(ax(c.from) - width / 2, Math.min(ax(c.to) - width / 2, arrScroll.scrollLeft));
    }
  }
  persist();
}
$('zoom-in').addEventListener('click', () => zoomTo(view.zoom * 1.5));
$('zoom-out').addEventListener('click', () => zoomTo(view.zoom / 1.5));
// The whole song in view (or the first four bars of an empty one)
$('zoom-fit').addEventListener('click', () => {
  const steps = Math.max(songEnd(song()), barSteps() * 4);
  zoomTo(arrScroll.clientWidth / (steps + song().stepsPerBeat), 0);
  arrScroll.scrollLeft = 0;
  renderZoom();
});

// The slider zooms in even steps of scale
const zoomSlider = $<HTMLInputElement>('zoom-slider');
const SLIDER_STEPS = 1000;
zoomSlider.max = String(SLIDER_STEPS);
zoomSlider.addEventListener('input', () => {
  const lo = Math.log(MIN_ZOOM);
  zoomTo(Math.exp(lo + (Number(zoomSlider.value) / SLIDER_STEPS) * (Math.log(MAX_ZOOM) - lo)));
});

function renderZoom() {
  const lo = Math.log(MIN_ZOOM);
  zoomSlider.value = String(Math.round(((Math.log(view.zoom) - lo) / (Math.log(MAX_ZOOM) - lo)) * SLIDER_STEPS));
  const bars = arrScroll.clientWidth / view.zoom / barSteps();
  $('zoom-label').textContent = `${bars < 10 ? bars.toFixed(1) : Math.round(bars)} bars shown`;
}

/** Dragging along a ruler: the playhead follows, and playing goes on from where it's let go */
let scrubbing = false;
function scrubTo(step: number) {
  scrubbing = true;
  playhead = Math.max(0, step);
  movePlayhead();
}
function endScrub() {
  if (!scrubbing) return;
  scrubbing = false;
  if (transport.playing) void play(transport.recording);
}

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
/** Pixels a note's end handles reach past it */
const NOTE_REACH = 3;

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
      const ng = el('g', { 'data-note': i }, g);
      const w = Math.max(3, n.length * view.rollZoom - 2);
      el('rect', { x: rx(n.start) + 1, y: ry(n.note) + 1, width: w, height: ROW - 2, rx: 3, class: `roll-note${selectedNotes.has(n) ? ' selected' : ''}${n.start >= c.length ? ' past' : ''}` }, ng);
      // Its ends, to drag: reaching a little past it, and a third of it each at most, so the middle is left to move it
      const end = Math.min(7, w / 3);
      el('rect', { x: rx(n.start) + 1 - NOTE_REACH, y: ry(n.note), width: end + NOTE_REACH, height: ROW, class: 'roll-note-end', 'data-note-end': 'start' }, ng);
      el('rect', { x: rx(n.start) + 1 + w - end, y: ry(n.note), width: end + NOTE_REACH, height: ROW, class: 'roll-note-end', 'data-note-end': 'end' }, ng);
      ng.append(title(noteName(n.note)));
    });
    // Slides and effects: the pitch through the note, and a band along it for each effect
    c.notes.forEach((n, i) => drawEffects(c, n, i, g));
  }
  rollPlayhead.setAttribute('y2', String(height));
  roll.append(rollPlayhead);
  if (band) el('rect', { x: Math.min(band.x0, band.x1), y: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0), class: 'roll-band' }, roll);
  renderRollRuler(width, shown);
  placeFxBar();
  drawPiano(height);
  movePlayhead();
}

const rollRuler = $('roll-ruler') as unknown as SVGSVGElement;
const ROLL_RULER_H = 22;

/** Bars and beats along the top of the editor, numbered as in the song */
function renderRollRuler(width: number, shown: number) {
  const s = song();
  const start = openClip?.start ?? 0;
  const bar = barSteps();
  rollRuler.setAttribute('width', String(width));
  rollRuler.setAttribute('height', String(ROLL_RULER_H));
  rollRuler.replaceChildren();
  el('rect', { x: 0, y: 0, width, height: ROLL_RULER_H, class: 'arr-ruler' }, rollRuler);
  const beatPx = s.stepsPerBeat * view.rollZoom;
  for (let st = 0; st <= shown; st++) {
    const at = start + st;
    if (at % s.stepsPerBeat) continue;
    const isBar = at % bar === 0;
    const x = rx(st) + 0.5;
    el('line', { x1: x, x2: x, y1: isBar ? 4 : ROLL_RULER_H - 6, y2: ROLL_RULER_H, class: isBar ? 'arr-grid bar' : 'arr-grid' }, rollRuler);
    // Bar numbers, and beats too when there's room (the clip's first, wherever it starts)
    const label = isBar ? String(at / bar + 1) : beatPx >= 36 || st === 0 ? positionText(at).split('.').slice(0, 2).join('.') : '';
    if (label) el('text', { x: x + 4, y: ROLL_RULER_H - 7, class: `arr-label${isBar ? '' : ' beat'}` }, rollRuler).textContent = label;
  }
}

// The editor's ruler moves the playhead: click, or drag to scrub
const rulerStep = (e: PointerEvent) => {
  const r = rollRuler.getBoundingClientRect();
  return (openClip?.start ?? 0) + Math.max(0, (e.clientX - r.left - KEYS_PAD) / view.rollZoom);
};
let rulerDown = false;
rollRuler.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  rulerDown = true;
  rollRuler.setPointerCapture(e.pointerId);
  dragCursor('ew-resize');
  scrubTo(rulerStep(e));
});
rollRuler.addEventListener('pointermove', (e) => rulerDown && scrubTo(rulerStep(e)));
const rulerUp = () => {
  if (!rulerDown) return;
  rulerDown = false;
  dragCursor(null);
  endScrub();
};
rollRuler.addEventListener('pointerup', rulerUp);
rollRuler.addEventListener('pointercancel', rulerUp);

/**
 * A piano down the editor's left, its keys on the rows of their notes: white
 * keys meet halfway along the black keys between them, as on a real one.
 */
function drawPiano(height: number) {
  rollKeys.setAttribute('width', String(KEYS_W));
  rollKeys.setAttribute('height', String(height));
  rollKeys.replaceChildren();
  el('rect', { x: 0, y: 0, width: KEYS_W, height, class: 'piano-bed' }, rollKeys);
  const black = (n: number) => BLACK.includes(((n % 12) + 12) % 12);
  for (let n = LOWEST; n <= HIGHEST; n++) {
    if (black(n)) continue;
    const top = black(n + 1) ? ry(n + 1) + ROW / 2 : ry(n);
    const bottom = black(n - 1) ? ry(n - 1) + ROW / 2 : ry(n) + ROW;
    el('rect', { x: 0.5, y: top + 0.5, width: KEYS_W - 1, height: bottom - top - 1, rx: 2, class: 'piano-white', 'data-key': n }, rollKeys);
    if (n % 12 === 0) el('text', { x: KEYS_W - 4, y: ry(n) + ROW - 2, class: 'piano-label', 'text-anchor': 'end' }, rollKeys).textContent = noteName(n).replace('-', '');
  }
  for (let n = LOWEST; n <= HIGHEST; n++) {
    if (black(n)) el('rect', { x: 0, y: ry(n) + 1, width: KEYS_W * 0.6, height: ROW - 2, rx: 1.5, class: 'piano-black', 'data-key': n }, rollKeys);
  }
  lightPiano();
}

/** The editor's piano shows the notes the keys are playing */
function lightPiano() {
  const sounding = new Set([...held.values()].map((h) => h.note));
  for (const key of rollKeys.querySelectorAll<SVGElement>('[data-key]')) key.classList.toggle('down', sounding.has(Number(key.dataset.key)));
}

// --- Slides, bends and vibrato, on the notes ---------------------------------------------------

/** New effects' speeds: a slide of half a semitone a frame, bends of an eighth, a gentle vibrato */
const DEFAULT_SPEEDS: Record<NoteEffect['kind'], Speed> = {
  slide: { left: 0x80, right: 1 },
  up: { left: 0x80, right: 3 },
  down: { left: 0x80, right: 3 },
  vibrato: (([left, right]) => ({ left, right }))(wobbleRow({ turn: 3, even: true, depth: 3 })),
};
const FX_NAMES: Record<NoteEffect['kind'], string> = { slide: 'Slide', up: 'Bend up', down: 'Bend down', vibrato: 'Vibrato' };

/** The note before a note in its clip (the one a slide comes from) */
const noteBefore = (c: Clip, n: SongNote) => c.notes.filter((m) => m !== n && m.start < n.start).sort((a, b) => b.start - a.start)[0];

/** The effect on a step of a note (steps from its start), if any */
const effectAt = (n: SongNote, k: number) => n.effects?.find((e) => k >= e.from && k < e.to);

/**
 * The pitch through a note, a point a frame (near enough to draw: as the
 * player moves it, without its rests): sliding in from the note before,
 * bending, sliding on, wobbling. Null for a note that holds its pitch.
 */
function pitchLine(c: Clip, n: SongNote): { x: number; y: number }[] | null {
  if (n.slide === undefined && !n.effects?.length) return null;
  const from = toFrame(c.start + n.start);
  const to = toFrame(c.start + n.start + n.length);
  const before = n.slide !== undefined ? noteBefore(c, n) : undefined;
  let pitch = before ? before.note : n.note;
  const pts: { x: number; y: number }[] = [];
  let wobble: { start: number; curve: Float64Array } | null = null;
  for (let f = from; f <= to; f++) {
    const step = toStep(f) - (c.start + n.start);
    const fx = effectAt(n, Math.floor(step)) ?? (n.slide !== undefined && step < 1 ? { kind: 'slide' as const, speed: n.slide, from: 0, to: 1 } : undefined);
    let wob = 0;
    if (fx?.kind === 'vibrato' && fx.speed) {
      if (!wobble || f < wobble.start) wobble = { start: f, curve: vibratoCurve(wobbleOf(fx.speed.left, fx.speed.right), n.note, 1, to - f + 1) };
      wob = wobble.curve[f - wobble.start];
    } else if (fx && f > from) {
      const rate = fx.speed ? slideSemitones(fx.speed.left, fx.speed.right, Math.round(pitch)) : Infinity;
      if (fx.kind === 'up') pitch += rate;
      else if (fx.kind === 'down') pitch -= rate;
      else pitch = pitch < n.note ? Math.min(n.note, pitch + rate) : Math.max(n.note, pitch - rate);
    }
    pts.push({ x: rx(n.start + step), y: ry(pitch + wob) + ROW / 2 });
  }
  return pts;
}

/** A note's pitch line, and its effects as bands along its foot: their ends dragged, their speed dragged up and down */
function drawEffects(c: Clip, n: SongNote, i: number, parent: Element) {
  const line = pitchLine(c, n);
  if (!line) return;
  el('path', { d: line.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(''), class: 'roll-pitch' }, parent);
  const y = ry(n.note) + ROW - 3;
  (n.effects ?? []).forEach((e, k) => {
    const g = el('g', { class: `roll-fx fx-${e.kind}`, 'data-fx-note': i, 'data-fx': k }, parent);
    const x0 = rx(n.start + e.from) + 1;
    const x1 = rx(n.start + e.to) - 1;
    el('rect', { x: x0, y, width: Math.max(2, x1 - x0), height: 4, rx: 2, class: 'roll-fx-band' }, g);
    for (const end of ['from', 'to'] as const) el('rect', { x: (end === 'from' ? x0 : x1) - 3, y: y - 1, width: 6, height: 6, class: 'roll-fx-end', 'data-fx-end': end }, g);
    g.append(title(`${FX_NAMES[e.kind]}: drag its ends to set where; drag it up or down for ${e.kind === 'vibrato' ? 'deeper or gentler' : 'faster or slower'}`));
  });
}

/** The buttons over the note selected: a slide into it, a bend, vibrato */
const fxBar = document.createElement('div');
fxBar.className = 'fx-bar';
fxBar.hidden = true;
for (const kind of ['slide', 'up', 'down', 'vibrato'] as const) {
  const b = document.createElement('button');
  b.dataset.kind = kind;
  b.textContent = { slide: '⤴', up: '↗', down: '↘', vibrato: '∿' }[kind];
  b.title = { slide: 'Slide into this note from the one before (it goes on rather than starting again)', up: 'Bend the pitch up', down: 'Bend the pitch down', vibrato: 'Vibrato' }[kind];
  b.setAttribute('aria-label', FX_NAMES[kind]);
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', () => toggleEffect(kind));
  fxBar.append(b);
}
$('roll-scroll').append(fxBar);

function placeFxBar() {
  const c = openClip;
  const n = selectedNotes.size === 1 ? [...selectedNotes][0] : null;
  fxBar.hidden = !c || !n || !c.notes.includes(n);
  if (fxBar.hidden || !c || !n) return;
  // Above the note, and above its pitch where that goes higher
  const line = pitchLine(c, n);
  const top = Math.min(ry(n.note), ...(line ?? []).map((q) => q.y - ROW / 2));
  fxBar.style.left = `${rx(n.start)}px`;
  fxBar.style.top = `${Math.max(0, top - 28)}px`;
  for (const b of fxBar.querySelectorAll<HTMLButtonElement>('button')) {
    const kind = b.dataset.kind as NoteEffect['kind'];
    const on = kind === 'slide' ? n.slide !== undefined : !!n.effects?.some((e) => e.kind === kind);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = kind === 'slide' && !noteBefore(c, n);
  }
}

/** Steps a slide takes to get there from the note before, at its speed (at least its first) */
function slideSteps(c: Clip, n: SongNote, speed: Speed | null): number {
  const before = noteBefore(c, n);
  if (!before || !speed) return 1;
  const rate = slideSemitones(speed.left, speed.right, Math.min(before.note, n.note));
  const frames = Math.ceil(Math.abs(n.note - before.note) / Math.max(rate, 1e-6)) + 1;
  return Math.max(1, Math.min(n.length, Math.ceil(stepOfFrame(song(), toFrame(c.start + n.start) + frames, FPS) - (c.start + n.start))));
}

/** Adds an effect to the note selected over the rest of it (or the slide into it), or takes it off */
function toggleEffect(kind: NoteEffect['kind']) {
  const c = openClip;
  const n = selectedNotes.size === 1 ? [...selectedNotes][0] : null;
  if (!c || !n) return;
  // (no room after a slide that takes the whole note)
  if (kind !== 'slide' && !n.effects?.some((e) => e.kind === kind) && (n.effects?.find((e) => e.kind === 'slide')?.to ?? 0) >= n.length) return;
  before();
  const others = (n.effects ?? []).filter((e) => e.kind !== kind && e.kind !== 'slide');
  if (kind === 'slide') {
    if (n.slide !== undefined) {
      delete n.slide;
      n.effects = n.effects?.filter((e) => e.kind !== 'slide');
    } else {
      // It goes on from the note before: that one runs right up to it
      const prev = noteBefore(c, n)!;
      prev.length = n.start - prev.start;
      n.slide = DEFAULT_SPEEDS.slide;
      const steps = slideSteps(c, n, n.slide);
      n.effects = [{ from: 0, to: steps, kind: 'slide', speed: n.slide }, ...others.filter((e) => e.from >= steps)];
    }
  } else if (n.effects?.some((e) => e.kind === kind)) {
    n.effects = n.effects.filter((e) => e.kind !== kind);
  } else {
    // Over the rest of the note, after any slide in
    const from = n.effects?.find((e) => e.kind === 'slide')?.to ?? 0;
    n.effects = [...(n.effects ?? []).filter((e) => e.kind === 'slide'), { from, to: n.length, kind, speed: DEFAULT_SPEEDS[kind] }];
  }
  if (!n.effects?.length) delete n.effects;
  changed();
}

/** A speed made faster (negative) or slower by notches: half or twice as much a notch */
function nudgeSpeed(sp: Speed, notches: number): Speed {
  // Worked out from the note: right is how many times a semitone's step is halved
  if (sp.left & 0x80) return { left: sp.left, right: Math.max(0, Math.min(7, sp.right + notches)) };
  const v = Math.max(1, Math.min(0x7fff, Math.round(((sp.left << 8) | sp.right) * 2 ** -notches)));
  return { left: v >> 8, right: v & 0xff };
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
  rollRuler.style.transform = `translateX(${-rollScroll.scrollLeft}px)`;
});

type RollDrag =
  | { kind: 'move' | 'start' | 'length'; x0: number; y0: number; was: Map<SongNote, SongNote>; moved: boolean; sounding: number | null }
  | { kind: 'band'; keep: Set<SongNote> }
  | { kind: 'fx-end'; note: SongNote; fx: NoteEffect; end: 'from' | 'to'; x0: number; was: number; moved: boolean }
  | { kind: 'fx-speed'; note: SongNote; fx: NoteEffect; y0: number; was: Speed | null; moved: boolean };
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
  // An effect's band: its ends set where it is, the band its speed
  const fxHit = (e.target as Element).closest<SVGElement>('[data-fx]');
  if (fxHit) {
    const n = c.notes[Number(fxHit.dataset.fxNote)];
    const fx = n.effects![Number(fxHit.dataset.fx)];
    const end = (e.target as Element).closest<SVGElement>('[data-fx-end]')?.dataset.fxEnd as 'from' | 'to' | undefined;
    selectedNotes.clear();
    selectedNotes.add(n);
    rollDrag = end ? { kind: 'fx-end', note: n, fx, end, x0: p.x, was: fx[end], moved: false } : { kind: 'fx-speed', note: n, fx, y0: p.y, was: fx.speed, moved: false };
    dragCursor(end ? 'ew-resize' : 'ns-resize');
    renderEditor();
    return;
  }
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
    const end = (e.target as Element).closest<SVGElement>('[data-note-end]')?.dataset.noteEnd;
    const kind = end === 'start' ? 'start' : end === 'end' ? 'length' : 'move';
    dragCursor(kind === 'move' ? 'grabbing' : 'ew-resize');
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
  if (!d || !c) return;
  if (d.kind === 'fx-end' || d.kind === 'fx-speed') {
    if (!d.moved) {
      before();
      d.moved = true;
    }
    const { note: n, fx } = d;
    if (d.kind === 'fx-end') {
      // Within the note, not over its other effects (one a step, as GoatTracker's rows)
      const by = Math.round((p.x - d.x0) / view.rollZoom);
      const others = (n.effects ?? []).filter((x) => x !== fx);
      const lo = d.end === 'from' ? Math.max(0, ...others.filter((x) => x.to <= fx.from).map((x) => x.to)) : fx.from + 1;
      const hi = d.end === 'to' ? Math.min(n.length, ...others.filter((x) => x.from >= fx.to).map((x) => x.from)) : fx.to - 1;
      fx[d.end] = Math.max(lo, Math.min(hi, d.was + by));
    } else if (d.was) {
      // Up: faster (or deeper); down: slower (or gentler); a notch every 12 pixels
      fx.speed = nudgeSpeed(d.was, Math.round((p.y - d.y0) / 12));
      if (fx.kind === 'slide' && fx.from === 0 && n.slide !== undefined) n.slide = fx.speed;
    }
    renderEditor();
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
  } else if (d.kind === 'start') {
    // The start moves, the end stays
    for (const [n, w] of d.was) {
      n.start = Math.max(0, Math.min(w.start + w.length - 1, w.start + by));
      n.length = w.start + w.length - n.start;
    }
    lastLength = [...d.was.keys()][0].length;
  } else {
    for (const [n, w] of d.was) n.length = Math.max(1, w.length + by);
    lastLength = [...d.was.keys()][0].length;
  }
  render();
});

const endRollDrag = () => {
  const d = rollDrag;
  rollDrag = null;
  dragCursor(null);
  band = null;
  if (d && 'sounding' in d) sound(null, d.sounding);
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

/** Notes copied (⌘C), from the first's start: pasted (⌘V) at the playhead */
let copiedNotes: SongNote[] = [];

function copyNotes(cut: boolean) {
  if (!openClip || !selectedNotes.size) return;
  const notes = [...selectedNotes].sort((a, b) => a.start - b.start || a.note - b.note);
  const first = notes[0].start;
  copiedNotes = notes.map((n) => ({ ...(JSON.parse(JSON.stringify(n)) as SongNote), start: n.start - first }));
  if (cut) deleteNotes();
}

/**
 * The notes copied, into the open clip from the playhead (its start if the
 * playhead is before it; in the pass it's in, if the clip repeats). A clip
 * that doesn't repeat grows by bars to hold them; a note already at a pasted
 * one's start and pitch gives way. The pasted notes are selected.
 */
function pasteNotes() {
  const c = openClip;
  if (!c || !copiedNotes.length) return;
  let at = Math.max(0, Math.round(playhead) - c.start);
  if (c.span > c.length) at %= c.length;
  const pasted = copiedNotes.map((n) => ({ ...(JSON.parse(JSON.stringify(n)) as SongNote), start: n.start + at }));
  before();
  const end = Math.max(...pasted.map((n) => n.start + n.length));
  if (c.span === c.length && end > c.length) c.length = c.span = Math.ceil(end / barSteps()) * barSteps();
  c.notes = [...c.notes.filter((o) => !pasted.some((n) => n.start === o.start && n.note === o.note)), ...pasted];
  selectedNotes.clear();
  for (const n of pasted) selectedNotes.add(n);
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
  $('metronome').classList.toggle('on', view.metronome);
  $('metronome').setAttribute('aria-pressed', String(view.metronome));
  $('count-in').classList.toggle('on', view.countIn);
  $('count-in').setAttribute('aria-pressed', String(view.countIn));
  $('cycle').setAttribute('aria-pressed', String(s.cycling));
  const name = $<HTMLInputElement>('song-name');
  if (document.activeElement !== name) name.value = s.name;
  const tempo = $<HTMLInputElement>('tempo');
  if (document.activeElement !== tempo) tempo.value = bpmText(bpmAt(s, Math.floor(playhead)));
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
$('metronome').addEventListener('click', toggleMetronome);
$('count-in').addEventListener('click', () => {
  view.countIn = !view.countIn;
  persist();
  renderTransport();
});

function toggleMetronome() {
  view.metronome = !view.metronome;
  persist();
  renderTransport();
  if (transport.playing) restartSequence(true);
}
$<HTMLInputElement>('song-name').addEventListener('change', (e) => {
  before();
  song().name = (e.target as HTMLInputElement).value.trim() || 'Untitled';
  changed();
});
$<HTMLInputElement>('tempo').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const bpm = Math.round(Number(input.value) * 10) / 10;
  if (!(bpm >= TEMPO_MIN && bpm <= TEMPO_MAX)) {
    input.value = String(song().bpm);
    return;
  }
  // The tempo where the playhead is: the start's, or the change it's under
  before();
  const pts = tempoPoints();
  let at = 0;
  pts.forEach((p, i) => p.step <= playhead && (at = i));
  pts[at].bpm = bpm;
  setTempoPoints(pts);
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
  arrScroll.scrollLeft = Math.max(0, ax(playhead) - 40);
  if (transport.playing) void play(transport.recording);
  else movePlayhead();
}

// --- Songs: several, and imported ones -------------------------------------------------------------

function renderSongs() {
  const pick = $<HTMLSelectElement>('song-pick');
  pick.replaceChildren(...view.songs.map((s, i) => new Option(s.name || `Song ${i + 1}`, String(i))));
  pick.value = String(view.current);
  $<HTMLButtonElement>('delete-song').disabled = view.songs.length < 2;
}

/** After the song open changes: from the start, nothing open, the whole song in view */
function switchedSong() {
  stop();
  openClip = null;
  selectedNotes.clear();
  current = 0;
  playhead = 0;
  persist();
  render();
  $('zoom-fit').click();
  centreRoll();
}

$<HTMLSelectElement>('song-pick').addEventListener('change', (e) => {
  view.current = Number((e.target as HTMLSelectElement).value);
  switchedSong();
});
$('new-song').addEventListener('click', () => {
  beforeSongs();
  view.songs.push({ ...defaultSong(), name: `Song ${view.songs.length + 1}` });
  view.current = view.songs.length - 1;
  switchedSong();
});
$('delete-song').addEventListener('click', () => {
  if (view.songs.length < 2) return;
  askChoice($('delete-song').getBoundingClientRect(), `Delete “${song().name}”?`, [{ label: 'Delete song', danger: true, act: deleteSong }]);
});

function deleteSong() {
  if (view.songs.length < 2) return;
  beforeSongs();
  const [gone] = view.songs.splice(view.current, 1);
  view.current = Math.min(view.current, view.songs.length - 1);
  switchedSong();
  toast(`Deleted ${gone.name} (⌘Z brings it back)`);
}

// Exporting: the song as a GoatTracker song file, downloaded
$('export-song').addEventListener('click', () => {
  const plan = songPlan(0, null, { click: false, countIn: false });
  const { bytes, gaps } = exportSong(song(), plan, FPS);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }));
  link.download = `${(song().name || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'song'}.sng`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast(gaps.length ? `Exported ${link.download}, but GoatTracker can't play all of it as here: ${gaps.join('; ')}` : `Exported ${link.download}`);
});

// --- Asking: a question by what it's about, a button for each answer and one to leave it -------

const ask = document.createElement('div');
ask.className = 'ask';
ask.setAttribute('role', 'dialog');
ask.hidden = true;
document.body.append(ask);

function askChoice(near: DOMRect, text: string, choices: { label: string; danger?: boolean; disabled?: boolean; act: () => void }[]) {
  const q = document.createElement('p');
  q.textContent = text;
  const row = document.createElement('div');
  row.className = 'ask-buttons';
  for (const c of choices) {
    const b = document.createElement('button');
    b.className = `button${c.danger ? ' danger' : ' secondary'}`;
    b.textContent = c.label;
    b.disabled = !!c.disabled;
    b.addEventListener('click', () => {
      closeAsk();
      c.act();
    });
    row.append(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'button secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeAsk);
  row.append(cancel);
  ask.replaceChildren(q, row);
  ask.hidden = false;
  // By what it's about, kept on the screen
  const w = ask.offsetWidth;
  ask.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, near.left))}px`;
  ask.style.top = `${Math.min(window.innerHeight - ask.offsetHeight - 8, near.bottom + 6)}px`;
  cancel.focus();
}

function closeAsk() {
  ask.hidden = true;
}
document.addEventListener('pointerdown', (e) => {
  if (!ask.hidden && !ask.contains(e.target as Node)) closeAsk();
});

/** Delete with no clip picked up: the selected track, cleared of its clips or deleted */
function askTrack() {
  const t = track();
  if (!t) return;
  const head = document.querySelectorAll('.track-head')[current];
  askChoice(head.getBoundingClientRect(), `${instrumentName(t)}: clear its clips, or delete the track?`, [
    {
      label: 'Clear track',
      disabled: !t.clips.length,
      act: () => {
        before();
        t.clips = [];
        openClip = null;
        selectedNotes.clear();
        changed();
      },
    },
    { label: 'Delete track', danger: true, disabled: song().tracks.length < 2, act: () => removeTrack(current) },
  ]);
}

interface Example {
  file: string;
  title: string;
  author: string;
  settings?: Partial<Settings>;
  /** It imports exactly (checked by the tests); else what it needs that Song Maker can't do yet */
  importable?: boolean;
  needs?: string[];
}

const importList = $('import-list');
$('import-song').addEventListener('click', async () => {
  if (!importList.hidden) {
    importList.hidden = true;
    return;
  }
  const index = (await (await fetch('./examples/index.json')).json()) as Example[];
  const list = $('import-songs');
  list.replaceChildren(
    ...[...index]
      .sort((a, b) => Number(!!b.importable) - Number(!!a.importable))
      .map((ex) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.disabled = !ex.importable;
        const title = document.createElement('b');
        title.textContent = ex.title;
        const by = document.createElement('span');
        by.className = 'by';
        by.textContent = ex.importable ? ex.author : `Not yet: ${(ex.needs ?? []).slice(0, 4).join(', ') || 'plays differently'}`;
        b.append(title, by);
        b.addEventListener('click', () => {
          importList.hidden = true;
          void importExample(ex);
        });
        li.append(b);
        return li;
      }),
  );
  importList.hidden = false;
});
$('import-close').addEventListener('click', () => (importList.hidden = true));

/** Imports an example song as a new song, its instruments joining the Instrument Maker's */
async function importExample(ex: Example) {
  if (!analyzer) return;
  const bytes = await (await fetch(`./examples/${ex.file}`)).arrayBuffer();
  const imp = importGoatSong(analyzer, bytes, { ...DEFAULT_SETTINGS, ...ex.settings }, ex.title);
  if (!imp) {
    toast(`${ex.title} couldn't be read`);
    return;
  }
  addInstruments(imp.instruments, INSTRUMENT_SECONDS * FPS);
  instruments = loadInstruments(INSTRUMENT_SECONDS * FPS);
  byId = new Map(instruments.map((s) => [s.id!, s]));
  beforeSongs();
  view.songs.push({ ...imp.song, name: ex.title });
  view.current = view.songs.length - 1;
  switchedSong();
  toast(`Imported ${ex.title}: its ${imp.instruments.length} instruments are in the Instrument Maker too`);
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
  lightPiano();
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
  // A question open: Escape leaves it; other keys are its buttons'
  if (!ask.hidden) {
    if (e.key === 'Escape') closeAsk();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing(e)) {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && ['c', 'x', 'v'].includes(e.key.toLowerCase()) && !typing(e)) {
    const k = e.key.toLowerCase();
    if (k === 'v' ? !openClip || !copiedNotes.length : focus !== 'roll' || !selectedNotes.size) return;
    e.preventDefault();
    if (k === 'v') pasteNotes();
    else copyNotes(k === 'x');
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && !typing(e)) {
    e.preventDefault();
    duplicateClip();
    return;
  }
  if (e.key === 'Escape') {
    importList.hidden = true;
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
    else if (openClip) deleteClip();
    else askTrack();
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
  // Space plays and stops wherever the focus is (not pressing a focused button or opening a menu)
  if (e.key === ' ') {
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
  if (k === 'm') return toggleMetronome();
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

openClip = clipAt(view.open);
if (openClip) current = song().tracks.findIndex((t) => t.clips.includes(openClip!));
sendSounds();
render();
renderKeyboard();
centreRoll();

let analyzer: Analyzer | null = null;

/** Where a resumed note was: its song, its track, the note itself */
interface ResumeContext {
  doc: SongDoc;
  track: Track;
  held: ResumedNote;
  fps: number;
}

/**
 * Traces of a note as the song plays it, for picking it up where it left
 * off: on its own on its voice, from its step, with the song's tempo, rows
 * and pulse rests (on the key, an octave up, and without its vibrato)
 */
const resumeTraceCache = new Map<string, ResumeTraces>();
function resumeTraces(shape: Shape, ctx: ResumeContext, frames: number): ResumeTraces | null {
  if (!analyzer) return null;
  const { doc, track, held, fps } = ctx;
  const k = JSON.stringify([shape, track.voice, held, doc.bpm, doc.tempo, doc.stepsPerBeat, doc.goat?.patterns[track.voice], fps]);
  const cached = resumeTraceCache.get(k);
  if (cached && cached.key.frames >= frames) return cached;
  const n = Math.max(frames, (cached?.key.frames ?? 0) * 2, 256);
  const from = frameAt(doc, held.step, fps);
  const steps = Math.ceil(stepOfFrame(doc, from + n, fps) - held.step) + 2;
  const run = (s: Shape, note: number) => {
    // The song with only this note in it
    const solo: SongDoc = { ...doc, tracks: [{ id: 'resume', instrument: 'resume', voice: track.voice, muted: false, clips: [{ start: held.step, length: steps, span: steps, notes: [{ start: 0, length: steps, note, ...(held.effects ? { effects: held.effects } : {}) }] }] }] };
    const { sounds: list, trackSound: numbers } = songSounds(solo, new Map([['resume', s]]));
    const one = sounds(list.map((x) => ({ shape: x.shape, voices: 1 << x.voice })));
    const speeds = songSpeeds(solo);
    const t = soundTables(one, speeds);
    const index = new Map(speeds.map((sp, i) => [`${sp.left}/${sp.right}`, i]));
    const seq = songSequence(solo, list, numbers, from, null, fps, { click: false, countIn: false }, () => null, (sp) => (sp ? t.extraSpeedsAt + (index.get(`${sp.left}/${sp.right}`) ?? 0) : 0));
    return analyzer!.traceVoice(t.tables, t.instruments, seq, n, track.voice, settings);
  };
  const t: ResumeTraces = { key: run(shape, held.note), octave: run(shape, held.note + 12), plain: shape.vibrato ? run({ ...shape, vibrato: null }, held.note) : null };
  resumeTraceCache.set(k, t);
  return t;
}

/** A sound's variant picking a note up `at` frames in (see resume.ts) */
function resumeOf(base: Sound, voices: number, at: number, ctx: ResumeContext): Sound | 'silent' | null {
  // (far enough on to try vibrato delays against)
  const t = resumeTraces(base.shape, ctx, at + 200);
  if (!t) return null;
  const clock = ntsc ? 1022727 : 985248;
  const variant = resumeSound(base, at, t, FPS, clock, ctx.held.note);
  if (variant && variant !== 'silent' && t.plain) {
    // Tried out on an instrument of its own (the song's has its speed rows elsewhere)
    const alone = soundOf(base.shape, voices);
    const trial = resumeSound(alone, at, t, FPS, clock, ctx.held.note);
    if (trial && trial !== 'silent') variant.overrides!.vibratoDelay = tuneVibrato(alone, trial, t, at, ctx.held.note);
  }
  return variant;
}

/**
 * The vibrato delay that makes a resume's pitch follow the note's best. The
 * player counts the delay down only on frames it runs effects (which depend
 * on its tick as well as the rows), and a resume's first frame sets the
 * pitch, which starts the wobble again from the middle; so a vibrato
 * already going is held back until the note's comes back round to the
 * middle, and one yet to start is started where the note's would. Found by
 * trying: the smallest delay that follows it most closely.
 */
function tuneVibrato(alone: Sound, trial: Sound, t: ResumeTraces, at: number, key: number): number {
  if (!analyzer || !t.plain) return 1;
  const start = vibratoStart(t);
  if (start < 0) return 1;
  const frames = Math.min(t.key.frames - at, Math.max(64, start - at + 32));
  const off = (a: number, b: number) => Math.abs(12 * Math.log2((a || 1) / (b || 1))) > 0.1;
  let best = 1;
  let bestMisses = Infinity;
  for (let d = 1; d <= 96; d++) {
    trial.overrides!.vibratoDelay = d;
    const tt = soundTables([alone, trial]);
    const r = analyzer.trace(tt.tables, tt.instruments[1], key, frames, settings);
    let misses = 0;
    for (let k = 0; k < frames && misses < bestMisses; k++) if (off(r.freq[k], t.key.freq[at + k])) misses++;
    if (misses < bestMisses) {
      best = d;
      bestMisses = misses;
    }
    if (!misses) break;
  }
  return best;
}
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
      const cycle = song().cycling ? { start: toFrame(song().cycle.start), end: toFrame(song().cycle.end) } : null;
      const plan = songPlan(toFrame(fromStep), cycle, { click: false, countIn: false });
      return analyzer!.traceSequence(plan.tables, plan.instruments, plan.seq, frames, settings).map((r) => Array.from(r));
    },
    /**
     * An example song imported, played by the sequencer and by GoatTracker's
     * own player, compared frame by frame: what doesn't come across, and
     * where the playing differs (from the first row to the loop)
     */
    importCheck: async (file: string, near?: string) => {
      const index = await (await fetch('./examples/index.json')).json();
      const meta = (index as { file: string; settings?: Partial<Settings> }[]).find((e) => e.file === file);
      const at: Settings = { ...DEFAULT_SETTINGS, ...meta?.settings };
      const bytes = await (await fetch(`./examples/${file}`)).arrayBuffer();
      const a = analyzer!;
      const imp = importGoatSong(a, bytes.slice(0), at, file);
      if (!imp) return null;
      const fps = at.ntsc ? 60 : 50;
      const shapes = new Map(imp.instruments.map((s) => [s.id!, s]));
      const plan = songPlan(0, null, { click: false, countIn: false }, imp.song, shapes, fps);
      const shift = imp.firstRow + ROW_TO_NOTE;
      const frames = imp.length - shift - 1;
      const mine = a.traceSequence(plan.tables, plan.instruments, plan.seq, frames, at);
      a.load(bytes.slice(0));
      const original = a.traceSong(0, imp.length, at);
      // (for looking into differences: each frame's wave table position on each voice, both ways)
      const positions = near ? { original: a.songPositions(0, imp.length, at), mine: a.sequencePositions(plan.tables, plan.instruments, plan.seq, frames, at) } : null;
      const differ: Record<string, number> = {};
      const first: Record<string, number> = {};
      const mark = (what: string, f: number) => {
        differ[what] = (differ[what] ?? 0) + 1;
        first[what] ??= f;
      };
      const pw = (r: Uint8Array, b: number) => r[b + 2] | ((r[b + 3] & 15) << 8);
      for (let f = 0; f < frames; f++) {
        const o = original[f + shift];
        const m = mine[f];
        for (let v = 0; v < 3; v++) {
          const b = v * 7;
          if (o[b] !== m[b] || o[b + 1] !== m[b + 1]) mark(`pitch ${v + 1}`, f);
          if ((o[b + 4] & 0xf1) !== (m[b + 4] & 0xf1)) mark(`waveform ${v + 1}`, f);
          if (o[b + 4] & 0x40 && Math.abs(pw(o, b) - pw(m, b)) > 2) mark(`pulse ${v + 1}`, f);
          if (o[b + 5] !== m[b + 5] || o[b + 6] !== m[b + 6]) mark(`envelope ${v + 1}`, f);
        }
        if (o[0x16] !== m[0x16] || o[0x17] !== m[0x17] || (o[0x18] & 0x70) !== (m[0x18] & 0x70)) mark('filter', f);
        if ((o[0x18] & 15) !== (m[0x18] & 15)) mark('volume', f);
      }
      const look = near && first[near] !== undefined ? Array.from({ length: 30 }, (_, k) => {
        const f = Math.max(0, first[near] - 10) + k;
        const v = near === 'filter' ? 0 : Number(near.slice(-1)) - 1;
        const skips = plan.seq.events.filter((e) => e.frame === f && e.voice === v).map((e) => (e.kind === 'row' ? `r${e.command}:${e.data}` : e.kind === 'slide' ? `s${e.note}:${e.data}` : e.note)).join(',');
        if (near === 'filter') return `${f}: cut ${original[f + shift][0x16].toString(16)}/${mine[f][0x16].toString(16)} rt ${original[f + shift][0x17].toString(16)}/${mine[f][0x17].toString(16)} md ${original[f + shift][0x18].toString(16)}/${mine[f][0x18].toString(16)}`;
        const posText = positions ? ` p${positions.original[f + shift][v]}/${positions.mine[f][v]}` : '';
        return `${f}:${posText} ${pw(original[f + shift], v * 7).toString(16)} ${pw(mine[f], v * 7).toString(16)} f${(original[f + shift][v * 7] | (original[f + shift][v * 7 + 1] << 8)).toString(16)}/${(mine[f][v * 7] | (mine[f][v * 7 + 1] << 8)).toString(16)} w${original[f + shift][v * 7 + 4].toString(16)}/${mine[f][v * 7 + 4].toString(16)} ${skips}`;
      }) : undefined;
      return { gaps: imp.gaps, frames, differ, first, tracks: imp.song.tracks.length, clips: imp.song.tracks.reduce((n, t) => n + t.clips.length, 0), look };
    },
    /**
     * The song open, exported and played by GoatTracker's own player,
     * compared frame by frame with Song Maker's playing of it: the gaps,
     * and where they differ (from Song Maker's first frame, lined up)
     */
    exportCheck: () => {
      const a = analyzer!;
      const plan = songPlan(0, null, { click: false, countIn: false });
      const { bytes, gaps } = exportSong(song(), plan, FPS);
      const at: Settings = { ...settings, ...(song().goat?.pulseOptimization === false ? { pulseOptimization: false } : {}) };
      const frames = toFrame(Math.max(1, songRows(song()))) - 4;
      const mine = a.traceSequence(plan.tables, plan.instruments, plan.seq, frames, at);
      if (!a.load(bytes.slice().buffer)) return { gaps, error: 'not a song GoatTracker can read' };
      const theirs = a.traceSong(0, frames + 40, at);
      const same = (o: Uint8Array, m: Uint8Array) => [0, 1, 2].every((v) => o[v * 7] === m[v * 7] && o[v * 7 + 1] === m[v * 7 + 1] && (o[v * 7 + 4] & 0xf1) === (m[v * 7 + 4] & 0xf1));
      // Where GoatTracker's playing lines up with Song Maker's (its first row comes a few frames in)
      let shift = 0;
      let best = -1;
      for (let o = 0; o < 30; o++) {
        let n = 0;
        for (let f = 0; f < Math.min(300, frames); f++) if (same(theirs[f + o], mine[f])) n++;
        if (n > best) [best, shift] = [n, o];
      }
      const differ: Record<string, number> = {};
      const first: Record<string, number> = {};
      const mark = (what: string, f: number) => {
        differ[what] = (differ[what] ?? 0) + 1;
        first[what] ??= f;
      };
      const pw = (r: Uint8Array, b: number) => r[b + 2] | ((r[b + 3] & 15) << 8);
      for (let f = 0; f < frames; f++) {
        const o = theirs[f + shift];
        const m = mine[f];
        for (let v = 0; v < 3; v++) {
          const b = v * 7;
          if (o[b] !== m[b] || o[b + 1] !== m[b + 1]) mark(`pitch ${v + 1}`, f);
          if ((o[b + 4] & 0xf1) !== (m[b + 4] & 0xf1)) mark(`waveform ${v + 1}`, f);
          if (o[b + 4] & 0x40 && Math.abs(pw(o, b) - pw(m, b)) > 2) mark(`pulse ${v + 1}`, f);
          if (o[b + 5] !== m[b + 5] || o[b + 6] !== m[b + 6]) mark(`envelope ${v + 1}`, f);
        }
        if (o[0x16] !== m[0x16] || o[0x17] !== m[0x17] || (o[0x18] & 0x70) !== (m[0x18] & 0x70)) mark('filter', f);
      }
      return { gaps, shift, frames, differ, first, bytes: bytes.length };
    },
    /** The metronome's frames playing from a step: beats and bars */
    clicks: (fromStep: number, countIn: boolean) => {
      const { sounds: list, trackSound: numbers } = songSounds(song(), byId);
      const seq = songSequence(song(), list, numbers, toFrame(fromStep), null, FPS, { click: true, countIn });
      return { beats: seq.beats, bars: seq.bars, preroll: seq.preroll };
    },
    /**
     * How closely a resume of an instrument `at` frames in plays the rest of
     * the note: the frames where waveform, pitch, pulse width or cutoff differ
     */
    /**
     * How closely a note picks up where it left off: an instrument's long
     * note, another (the same instrument) taking its voice for a step at
     * `step`, compared after it comes back with the note played alone:
     * the frames where waveform, pitch, pulse width or cutoff differ
     */
    resumeCheck: (which: number | Shape, step: number, frames: number) => {
      const shape = { ...(typeof which === 'number' ? instruments[which] : which), id: 'checked' };
      const shapes = new Map([['checked', shape]]);
      const long = { start: 0, length: 256, span: 256, notes: [{ start: 0, length: 256, note: 48 }] };
      const doc = (stealing: boolean): SongDoc => ({
        ...song(),
        tempo: undefined,
        goat: undefined,
        tracks: [
          { id: 'a', instrument: 'checked', voice: 0, muted: false, clips: [long] },
          { id: 'b', instrument: 'checked', voice: 0, muted: !stealing, clips: [{ start: step, length: 1, span: 1, notes: [{ start: 0, length: 1, note: 60 }] }] },
        ],
      });
      const both = songPlan(0, null, { click: false, countIn: false }, doc(true), shapes);
      if (both.tables[0].left.length >= 255) return 'too big';
      // (no resume made: it had let go by itself, or there's no room for one)
      if (both.instruments.length < 2) return 'silent';
      const alone = songPlan(0, null, { click: false, countIn: false }, doc(false), shapes);
      const back = frameAt(doc(true), step + 1, FPS);
      const a = analyzer!.traceVoice(both.tables, both.instruments, both.seq, back + frames, 0, settings);
      const o = analyzer!.traceVoice(alone.tables, alone.instruments, alone.seq, back + frames, 0, settings);
      if (!(a.control.subarray(back).some((c) => c & 1)) && !(o.control.subarray(back).some((c) => c & 1))) return 'silent';
      const out: string[] = [];
      for (let f = back; f < back + frames; f++) {
        const what = [
          (o.control[f] & 0xf1) !== (a.control[f] & 0xf1) && 'waveform',
          // (within 10 cents: a vibrato or slide caught partway can be a step off)
          Math.abs(12 * Math.log2((o.freq[f] || 1) / (a.freq[f] || 1))) > 0.1 && 'pitch',
          // (within 2 of 4096: the player writes widths without their lowest bit, so a sweep picked up can alternate a little)
          o.control[f] & 0x40 && Math.abs(o.pulse[f] - a.pulse[f]) > 2 && 'pulse',
          o.routing[f] & 7 && o.cutoff[f] !== a.cutoff[f] && 'cutoff',
        ].filter(Boolean);
        if (what.length) out.push(`${f - back}: ${what.join('+')}`);
      }
      return out;
    },
    instruments: () => instruments,
    playing: () => transport.playing,
    /** The song frame being heard */
    liveFrame,
    openClip: () => openClip,
    selectedNotes: () => [...selectedNotes],
    setPlayhead: (step: number) => {
      playhead = step;
      render();
    },
  },
});
