// Song Maker songs as GoatTracker songs (.sng, GTS5): what Song Maker plays,
// written as patterns and order lists for GoatTracker's player.
//
// Each voice's notes are worked out as Song Maker plays them (tracks taking
// turns, notes picking up where they left off), a step a row: a note's row
// has its note and instrument, a row where nothing follows has a key-off,
// and each row carries its effect's command. Tempo changes are tempo
// commands on a row with no effect of its own. The instruments and tables
// are the ones Song Maker plays with. Each voice is cut into patterns where
// Song Maker's playback has them (imported songs' own, else every few
// bars), alike ones written once. The song loops back to its start.
//
// What can't be written as it plays is listed as gaps.

import type { TableData } from './engine/configure';
import type { Instrument } from './song';
import { ENDPATT, FIRSTNOTE, KEYOFF, LOOPSONG, REST } from './song';
import { EFFECT_COMMANDS, frameAt, leadOf, patternStarts, resumeLeadOf, songRows, stepAt, voiceSegments, VOICES, type ResumedNote, type SongDoc, type SongSound, type Speed } from './songdoc';

const CMD_TONEPORTA = 3;
const CMD_SETTEMPO = 15;
/** GoatTracker's tempo when a song starts, and the slowest and fastest its tempo command sets */
const START_TEMPO = 6;
const TEMPO_FASTEST = 3;
const TEMPO_SLOWEST = 0x7f;
const MAX_PATTERNS = 208;
const MAX_ORDER = 254;

export interface ExportPlan {
  tables: TableData[];
  instruments: Instrument[];
  trackSound: number[];
  sounds: SongSound[];
  resume: (sound: number, from: number, note: ResumedNote) => number | 'silent' | null;
  speedRow: (speed: Speed | null) => number;
}

interface Row {
  note: number;
  instrument: number;
  command: number;
  data: number;
}

export function exportSong(song: SongDoc, plan: ExportPlan, fps: number): { bytes: Uint8Array; gaps: string[] } {
  const gaps = new Set<string>();
  const rows = Math.max(1, songRows(song));
  const stepOf = (frame: number) => Math.round(stepAt(song, frame, fps));
  const voices: Row[][] = [];
  for (let voice = 0; voice < VOICES; voice++) {
    const out: Row[] = Array.from({ length: rows }, () => ({ note: REST, instrument: 0, command: 0, data: 0 }));
    const segs = voiceSegments(song, voice, fps).filter((s) => plan.trackSound[s.track] > 0);
    segs.forEach((s, i) => {
      const k = stepOf(s.start);
      if (k >= rows) return;
      const n = plan.trackSound[s.track];
      const shape = plan.sounds[n - 1].shape;
      const before = segs[i - 1];
      const sliding = s.slide !== undefined && !s.from && !!before && before.end >= s.start;
      let instrument = n;
      if (s.from) {
        const r = plan.resume(n, s.from, { track: s.track, step: s.step, note: s.note, ...(s.effects ? { effects: s.effects } : {}) });
        if (r === 'silent') return;
        if (r !== null) instrument = r;
      }
      out[k] = { note: FIRSTNOTE + s.note, instrument, command: sliding ? CMD_TONEPORTA : 0, data: sliding ? plan.speedRow(s.slide ?? null) : 0 };
      // Its steps' effects (a slide's own first row keeps its tone portamento)
      const end = Math.min(rows, stepOf(s.end));
      for (let j = k; j < end; j++) {
        const fx = s.effects?.find((e) => j - s.step >= e.from && j - s.step < e.to);
        if (fx) out[j] = { ...out[j], command: EFFECT_COMMANDS[fx.kind], data: plan.speedRow(fx.speed) };
      }
      // Let go where nothing comes straight after
      const next = segs[i + 1];
      if ((next && next.start <= s.end) || end >= rows) return;
      let off = end;
      // (an instrument that lets go by itself, in Song Maker's own songs: a key-off once it has, at the
      // note's end or its own key up, which changes nothing heard and keeps the note's length on import)
      if (shape.release !== null && !song.goat) {
        const letGo = s.start + Math.max(0, shape.release - (s.from ?? 0));
        const lead = s.from ? resumeLeadOf(shape) : leadOf(shape);
        while (off < rows && frameAt(song, off, fps) - lead < letGo) off++;
        if (off >= rows || (next && stepOf(next.start) <= off)) return;
      }
      if (out[off].note === REST) out[off] = { ...out[off], note: KEYOFF };
    });
    voices.push(out);
  }

  // Tempo: a command wherever a row's length changes, on a voice with no command there
  let tempo = START_TEMPO;
  for (let j = 0; j < rows; j++) {
    const length = frameAt(song, j + 1, fps) - frameAt(song, j, fps);
    if (length === tempo) continue;
    if (length < TEMPO_FASTEST || length > TEMPO_SLOWEST) {
      gaps.add(`steps of ${length} frames (GoatTracker's go from ${TEMPO_FASTEST} to ${TEMPO_SLOWEST})`);
      continue;
    }
    const free = voices.find((v) => !v[j].command);
    if (!free) {
      gaps.add('a tempo change where every voice has an effect');
      continue;
    }
    free[j] = { ...free[j], command: CMD_SETTEMPO, data: length };
    tempo = length;
  }

  // Patterns: each voice cut where its patterns start, alike ones once
  const patterns: Row[][] = [];
  const known = new Map<string, number>();
  const orders = voices.map((v, voice) => {
    const starts = [...new Set([0, ...patternStarts(song, voice).filter((p) => p > 0 && p < rows)])].sort((a, b) => a - b);
    return starts.map((p, i) => {
      const part = v.slice(p, starts[i + 1] ?? rows);
      const key = JSON.stringify(part);
      if (!known.has(key)) {
        known.set(key, patterns.length);
        patterns.push(part);
      }
      return known.get(key)!;
    });
  });
  if (patterns.length > MAX_PATTERNS) gaps.add(`${patterns.length} patterns (GoatTracker holds ${MAX_PATTERNS})`);
  if (orders.some((o) => o.length > MAX_ORDER)) gaps.add(`order lists over ${MAX_ORDER} patterns long`);
  if (patterns.some((p) => p.length > 128)) gaps.add('patterns over 128 rows');

  // The file: texts, order lists, instruments, tables, patterns
  const bytes: number[] = [...'GTS5'].map((c) => c.charCodeAt(0));
  const text = (t: string, n: number) => {
    for (let i = 0; i < n; i++) bytes.push(i < t.length ? t.charCodeAt(i) & 0xff : 0);
  };
  text(song.name, 32);
  text('', 32);
  text('Made with SIDKid', 32);
  bytes.push(1);
  for (const o of orders) {
    const entries = o.slice(0, MAX_ORDER);
    bytes.push(entries.length + 1, ...entries, LOOPSONG, 0);
  }
  const instruments = plan.instruments.slice(0, 63);
  bytes.push(instruments.length);
  for (const ins of instruments) {
    bytes.push(ins.ad, ins.sr, ...ins.tables, ins.vibratoDelay, ins.gateTimer, ins.firstWave);
    text(ins.name, 16);
  }
  for (const t of plan.tables) {
    const n = Math.min(255, t.left.length);
    bytes.push(n, ...t.left.subarray(0, n), ...t.right.subarray(0, n));
  }
  const written = patterns.slice(0, MAX_PATTERNS);
  bytes.push(written.length);
  for (const p of written) {
    const part = p.slice(0, 128);
    bytes.push(part.length + 1);
    for (const r of part) bytes.push(r.note, r.instrument, r.command, r.data);
    bytes.push(ENDPATT, 0, 0, 0);
  }
  return { bytes: Uint8Array.from(bytes, (b) => b & 0xff), gaps: [...gaps] };
}
