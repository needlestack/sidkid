// GoatTracker songs as Song Maker songs. Each voice's notes become tracks,
// one for each instrument it plays (a drum and a bass on one voice become
// two tracks taking turns on it), timed from the engine's scan of the
// song, so they land where GoatTracker's player plays them. Instruments are
// read off traces as the Instrument Maker imports them.
//
// Played by Song Maker's sequencer, a song plays as GoatTracker's player
// played it: a note sounds two frames after its row is read, and lets go
// the instrument's lead before a key-off row, as notes do (see songdoc.ts);
// the player's pulse optimization is kept by the song (`goat`).
//
// What doesn't come across yet is listed as gaps; a song with gaps isn't
// offered for import (loaded things load as they are).

import type { Analyzer } from './engine/analyzer';
import type { Settings } from './engine/protocol';
import { importInstrument, KEY } from './goatimport';
import { sound, soundTables } from './instruments';
import type { Shape } from './shape';
import { parseSong } from './song';
import { newId, type Clip, type NoteEffect, type SongDoc, type SongNote, type Speed, type TempoChange, type Track } from './songdoc';
import { buildTimeline, type Note as GoatNote } from './timeline';

/** Frames after a row is read that its note sounds (its program's first frame) */
export const ROW_TO_NOTE = 2;
/** How long an instrument is played to read its shape */
const INSTRUMENT_FRAMES = 1200;
const STEPS_PER_BEAT = 4;
const BEATS_PER_BAR = 4;

export interface GoatImport {
  song: SongDoc;
  instruments: Shape[];
  /** What doesn't come across yet (none: the song plays as it did) */
  gaps: string[];
  /** The song's first row's frame in GoatTracker's playback, where the imported song's frame 0 falls (less ROW_TO_NOTE) */
  firstRow: number;
  /** Frames GoatTracker plays before looping */
  length: number;
}

/** The pattern commands notes' effects are */
const EFFECTS: Record<number, NoteEffect['kind']> = { 1: 'up', 2: 'down', 3: 'slide', 4: 'vibrato' };
const FUNK_TEMPO = 14;
const TEMPO = 15;

const COMMAND_NAMES: Record<number, string> = {
  1: 'slides up',
  2: 'slides down',
  3: 'slides to notes',
  4: 'vibrato',
  5: 'attack/decay changes',
  6: 'sustain/release changes',
  7: 'waveform changes',
  8: 'wave program changes',
  9: 'pulse program changes',
  10: 'filter program changes',
  11: 'filter changes',
  12: 'cutoff changes',
  13: 'volume changes',
  14: 'funk tempo',
  15: 'tempo changes',
};

export function importGoatSong(a: Analyzer, bytes: ArrayBuffer, settings: Settings, name: string, subsong = 0): GoatImport | null {
  const canon = a.load(bytes);
  if (!canon) return null;
  const goat = parseSong(canon);
  const tl = buildTimeline(goat, subsong, a.scan(subsong, settings));
  const gaps: string[] = [];
  if (settings.multiplier !== 1) gaps.push('more than one player call a frame');

  // One step a row: the rows' frames (all voices read theirs together, the
  // tempo being the song's), and a tempo change wherever a row's length does
  const rows = tl.rows.reduce((a, r) => (r.length > a.length ? r : a), [] as (typeof tl.rows)[number]).map((e) => e.frame);
  const rowSet = new Set(rows);
  if (tl.rows.some((r) => r.some((e) => e.frame < tl.length && !rowSet.has(e.frame)))) gaps.push('voices at different tempos');
  const commands = new Set<number>();
  for (const rows of tl.rows) for (const e of rows) if (e.data.command && e.frame < tl.length) commands.add(e.data.command);
  // (tempo and funk tempo are the rows' lengths, which the tempo changes keep)
  // (tempo and funk tempo are the rows' lengths, kept by the tempo changes; slides, bends and vibrato are the notes' effects)
  for (const c of [...commands].sort((x, y) => x - y)) if (c !== TEMPO && c !== FUNK_TEMPO && !EFFECTS[c]) gaps.push(COMMAND_NAMES[c] ?? `command ${c}`);

  const firstRow = rows[0] ?? 0;
  const lengthAt = (i: number) => (rows[Math.min(i + 1, rows.length - 1)] ?? 6) - (rows[Math.min(i, rows.length - 2)] ?? 0) || 6;
  // The step a frame falls at: a row's own, between rows by how far, and on past the last at its length
  const steps = (frame: number) => {
    let lo = 0;
    let hi = rows.length - 1;
    if (frame >= rows[hi]) return hi + Math.round((frame - rows[hi]) / lengthAt(hi - 1));
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] <= frame) lo = mid;
      else hi = mid;
    }
    return lo + Math.round((frame - rows[lo]) / (rows[lo + 1] - rows[lo]));
  };

  // The instruments the notes play
  const used = [...new Set(tl.notes.flat().map((n) => n.instrument))].sort((x, y) => x - y);
  const instruments = new Map<number, Shape>();
  const tracer = (ins: (typeof goat.instruments)[number], note: number, frames: number) => a.trace(goat.tables, ins, note, frames, settings);
  for (const n of used) {
    const ins = goat.instruments[n];
    if (!ins?.tables[0]) {
      gaps.push(`instrument ${n} without a wave program`);
      continue;
    }
    const { shape, gaps: lost } = importInstrument(ins, goat.tables, tracer, INSTRUMENT_FRAMES);
    for (const g of lost) gaps.push(`${ins.name || `instrument ${n}`}: ${g}`);
    if (shape.vibrato) matchVibrato(a, settings, shape, tracer(ins, KEY, INSTRUMENT_FRAMES), tracer({ ...ins, tables: [ins.tables[0], ins.tables[1], ins.tables[2], 0] }, KEY, INSTRUMENT_FRAMES));
    instruments.set(n, { ...shape, id: newId(), name: `${ins.name || `Instrument ${n}`} (${goat.title || name})` });
  }

  // What each note does to its pitch: its rows' effects (a run of rows with
  // the same command and speed, one range), and whether it slides in
  const speedOf = (data: number): Speed | null => (data ? { left: goat.tables[3].left[data - 1] ?? 0, right: goat.tables[3].right[data - 1] ?? 0 } : null);
  const extras = new Map<GoatNote, Pick<SongNote, 'slide' | 'effects'>>();
  tl.notes.forEach((notes, voice) => {
    const rowsOf = tl.rows[voice];
    for (const n of notes) {
      const first = steps(n.start);
      const effects: NoteEffect[] = [];
      for (const e of rowsOf) {
        if (e.frame < n.start || e.frame >= n.end) continue;
        const kind = EFFECTS[e.data.command];
        if (!kind) continue;
        const at = steps(e.frame) - first;
        const last = effects[effects.length - 1];
        const speed = speedOf(e.data.data);
        if (last && last.kind === kind && last.to === at && JSON.stringify(last.speed) === JSON.stringify(speed)) last.to = at + 1;
        else effects.push({ from: at, to: at + 1, kind, speed });
      }
      const row = rowsOf.find((e) => e.frame === n.start);
      extras.set(n, { ...(n.slide ? { slide: speedOf(row?.data.data ?? 0) } : {}), ...(effects.length ? { effects } : {}) });
    }
  });

  // Tracks: each voice's notes, an instrument a track
  const tracks: Track[] = [];
  tl.notes.forEach((notes, voice) => {
    const patterns = tl.clips[voice].map((c) => steps(c.start));
    for (const n of [...new Set(notes.map((x) => x.instrument))]) {
      const shape = instruments.get(n);
      if (!shape) continue;
      const mine = notes.filter((x) => x.instrument === n && x.start < tl.length);
      if (!mine.length) continue;
      tracks.push({ id: newId(), instrument: shape.id!, voice, muted: false, clips: clipsOf(mine, patterns, steps, steps(tl.length), (x) => extras.get(x)) });
    }
  });

  const fps = settings.ntsc ? 60 : 50;
  const end = steps(tl.length);
  const bpmOf = (frames: number) => (60 * fps) / (frames * STEPS_PER_BEAT);
  const tempo: TempoChange[] = [];
  for (let i = 1; i < rows.length - 1; i++) if (lengthAt(i) !== lengthAt(i - 1)) tempo.push({ step: i, bpm: bpmOf(lengthAt(i)) });
  const song: SongDoc = {
    name: goat.title || name,
    bpm: bpmOf(lengthAt(0)),
    ...(tempo.length ? { tempo } : {}),
    stepsPerBeat: STEPS_PER_BEAT,
    beatsPerBar: BEATS_PER_BAR,
    tracks,
    cycle: tl.loopStart >= 0 && tl.loopStart < tl.length ? { start: Math.max(0, steps(tl.loopStart)), end } : { start: 0, end },
    cycling: false,
    goat: { patterns: tl.clips.map((cs) => cs.map((c) => steps(c.start))), end, ...(settings.pulseOptimization ? {} : { pulseOptimization: false }) },
  };
  return { song, instruments: [...instruments.values()], gaps, firstRow, length: tl.length };
}

/**
 * A track's notes in clips: one for each pattern they're in, joined where
 * a note is held over from one pattern into the next (a clip's notes stop
 * at its end).
 */
function clipsOf(notes: GoatNote[], patterns: number[], steps: (frame: number) => number, songEnd: number, extra: (n: GoatNote) => Pick<SongNote, 'slide' | 'effects'> | undefined): Clip[] {
  const bounds = [...patterns, songEnd];
  // The pattern a step is in, and where it ends
  const patternAt = (s: number) => {
    let i = 0;
    while (i + 2 < bounds.length && bounds[i + 1] <= s) i++;
    return i;
  };
  const clips: Clip[] = [];
  let clip: Clip | null = null;
  for (const n of notes) {
    const start = steps(n.start);
    const end = Math.max(start + 1, steps(n.end));
    if (!clip || start >= clip.start + clip.length) {
      clip = { start: bounds[patternAt(start)], length: 0, span: 0, notes: [] };
      clips.push(clip);
    }
    clip.notes.push({ start: start - clip.start, length: end - start, note: n.note, ...extra(n) });
    clip.length = clip.span = Math.max(clip.length, bounds[patternAt(end - 1) + 1] - clip.start);
  }
  return clips;
}

/**
 * The vibrato delay that starts an imported instrument's vibrato where the
 * original's does (the player counts it only on frames it runs effects, so
 * the same delay can start it elsewhere in the shape).
 */
function matchVibrato(a: Analyzer, settings: Settings, shape: Shape, original: { freq: Uint16Array }, plain: { freq: Uint16Array }) {
  const from = original.freq.findIndex((f, i) => f !== plain.freq[i]);
  if (from < 0 || !shape.vibrato) return;
  const startWith = (delay: number) => {
    const t = soundTables([sound({ ...shape, vibrato: { ...shape.vibrato!, delay } }, 1)]);
    const p = soundTables([sound({ ...shape, vibrato: null }, 1)]);
    const frames = Math.min(INSTRUMENT_FRAMES, delay * 2 + 60);
    const w = a.trace(t.tables, t.instruments[0], KEY, frames, settings);
    const q = a.trace(p.tables, p.instruments[0], KEY, frames, settings);
    const at = w.freq.findIndex((f, i) => f !== q.freq[i]);
    return at < 0 ? Infinity : at;
  };
  let lo = 1;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (startWith(mid) < from) lo = mid + 1;
    else hi = mid;
  }
  shape.vibrato.delay = lo > 1 && from - startWith(lo - 1) < startWith(lo) - from ? lo - 1 : lo;
}
