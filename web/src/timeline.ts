// Lays a song out in time from the engine's scan of when each voice read
// each pattern row, so the view matches playback exactly, tempo changes and
// all.
//
// GoatTracker has three independent order lists. SIDKid shows them as
// lanes of clips (pattern plays), and finds sections: the points where all
// three voices start a new pattern together. Sections with the same
// patterns in every voice get the same letter, so the song reads like a
// chain of sections, e.g. A A B A C.

import { CMD_TONEPORTA, FIRSTNOTE, KEYOFF, KEYON, LASTNOTE, orderSteps, type Row, type Song } from './song';

export interface Clip {
  voice: number;
  pattern: number;
  transpose: number;
  /** Position of the pattern in the voice's order list. */
  order: number;
  /** Frame the clip's first row is read, and the frame after it ends. */
  start: number;
  end: number;
  /** Frame each row is read, from the clip's first row. */
  rowFrames: number[];
  /** The voice has already looped: this repeats earlier material. */
  repeat: boolean;
}

export interface Note {
  voice: number;
  /** GoatTracker note number with transpose applied (0 = C-0). */
  note: number;
  instrument: number;
  start: number;
  /** When the gate goes off (or the next note starts). */
  end: number;
  /** Slides from the previous note rather than restarting. */
  slide: boolean;
}

export interface Event {
  voice: number;
  frame: number;
  clip: Clip;
  row: number;
  data: Row;
}

export interface Section {
  index: number;
  /** Same letter = same patterns in every voice. */
  letter: string;
  kind: number;
  /** How many sections in the song are this kind. */
  count: number;
  /** Colour slot shared by sections of a kind that repeats, or -1 if it only plays once. */
  color: number;
  start: number;
  end: number;
}

export interface Timeline {
  /** Frames until the song loops (or ends). */
  length: number;
  /** Frame playback continues from after `length`, or -1 if it stops. */
  loopStart: number;
  clips: Clip[][];
  sections: Section[];
  notes: Note[][];
  /** Every row read, per voice, in time order. */
  rows: Event[][];
  /** Lowest and highest note each voice plays, for scaling note views. */
  range: [number, number][];
}

/** sk_scan output: pairs of (frame, voice | row << 8 | pattern << 16). */
export function buildTimeline(song: Song, subsong: number, scan: Uint32Array): Timeline {
  const orderLists = song.subsongs[subsong] ?? song.subsongs[0];
  const clips: Clip[][] = [[], [], []];
  const rows: Event[][] = [[], [], []];
  const loopAt = [-1, -1, -1];
  const loopTarget = [-1, -1, -1];

  for (let v = 0; v < 3; v++) {
    const steps = orderSteps(orderLists[v]);
    let clip: Clip | null = null;
    let lastRow = -1;
    for (let i = 0; i < scan.length; i += 2) {
      const word = scan[i + 1];
      if ((word & 0xff) !== v) continue;
      const frame = scan[i];
      const row = (word >> 8) & 0xff;
      const pattern = word >>> 16;
      if (!clip || row <= lastRow || pattern !== clip.pattern) {
        const step = steps.next().value;
        if (clip) clip.end = frame;
        clip = {
          voice: v,
          pattern,
          transpose: step?.transpose ?? 0,
          order: step?.order ?? -1,
          start: frame,
          end: frame,
          rowFrames: [],
          repeat: loopAt[v] >= 0 || !!step?.looped,
        };
        if (step?.looped && loopAt[v] < 0) {
          loopAt[v] = frame;
          // The first time this order position played
          loopTarget[v] = clips[v].find((c) => c.order === step.order)?.start ?? 0;
        }
        clips[v].push(clip);
      }
      clip.rowFrames.push(frame);
      lastRow = row;
      rows[v].push({ voice: v, frame, clip, row, data: song.patterns[pattern]?.[row] ?? { note: 0, instrument: 0, command: 0, data: 0 } });
    }
  }

  // The song's length is when the last voice loops. Without a loop, run to
  // the end of the last row read.
  const looped = loopAt.every((f) => f >= 0);
  let length = looped ? Math.max(...loopAt) : 0;
  if (!looped) {
    for (const lane of clips) {
      const last = lane[lane.length - 1];
      if (!last) continue;
      const f = last.rowFrames;
      const rowLength = f.length > 1 ? f[f.length - 1] - f[f.length - 2] : 6;
      last.end = f[f.length - 1] + rowLength;
      length = Math.max(length, last.end);
    }
  }
  for (const lane of clips) {
    const last = lane[lane.length - 1];
    if (last && last.end <= last.start) last.end = Math.max(length, last.start + 1);
  }
  const latest = loopAt.indexOf(length);
  const loopStart = looped ? loopTarget[latest] : -1;

  const notes = rows.map((r) => buildNotes(r, length));
  const range = notes.map((list): [number, number] => {
    if (!list.length) return [36, 60];
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of list) {
      lo = Math.min(lo, n.note);
      hi = Math.max(hi, n.note);
    }
    return [lo, hi];
  });

  return { length, loopStart, clips, sections: findSections(clips, length), notes, rows, range };
}

function buildNotes(events: Event[], length: number): Note[] {
  const notes: Note[] = [];
  let current: Note | null = null;
  let instrument = 1;
  for (const e of events) {
    if (e.frame >= length) break;
    const { note, instrument: ins, command } = e.data;
    if (ins) instrument = ins;
    if (note >= FIRSTNOTE && note <= LASTNOTE) {
      const pitch = note - FIRSTNOTE + e.clip.transpose;
      if (current) current.end = e.frame;
      current = { voice: e.voice, note: pitch, instrument, start: e.frame, end: length, slide: command === CMD_TONEPORTA && current !== null };
      notes.push(current);
    } else if (note === KEYOFF && current) {
      current.end = e.frame;
      current = null;
    } else if (note === KEYON && !current) {
      const last = notes[notes.length - 1];
      if (last) {
        current = { ...last, start: e.frame, end: length, slide: false };
        notes.push(current);
      }
    }
  }
  return notes;
}

// Rows are read a frame or two before they sound, depending on the
// instrument, so voices that start together can be a few frames apart.
const SECTION_SLACK = 3;

function findSections(clips: Clip[][], length: number): Section[] {
  const starts = clips.map((lane) => lane.filter((c) => c.start < length).map((c) => c.start));
  const bounds: number[] = [];
  for (const f of starts[0]) {
    if (bounds.length && f - bounds[bounds.length - 1] <= SECTION_SLACK) continue;
    if (starts.slice(1).every((lane) => lane.some((g) => Math.abs(g - f) <= SECTION_SLACK))) bounds.push(f);
  }
  // The first rows are read a few frames in; the first section starts at 0
  if (bounds.length) bounds[0] = 0;
  else bounds.push(0);

  const kinds = new Map<string, number>();
  const sections: Section[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i];
    const end = i + 1 < bounds.length ? bounds[i + 1] : length;
    const signature = clips
      .map((lane) =>
        lane
          .filter((c) => c.start >= start - SECTION_SLACK && c.start < end - SECTION_SLACK)
          .map((c) => `${c.pattern}${c.transpose ? `${c.transpose > 0 ? '+' : ''}${c.transpose}` : ''}`)
          .join(','),
      )
      .join('|');
    if (!kinds.has(signature)) kinds.set(signature, kinds.size);
    const kind = kinds.get(signature)!;
    sections.push({ index: i, letter: letters(kind), kind, count: 0, color: -1, start, end });
  }
  const colors = new Map<number, number>();
  for (const s of sections) {
    s.count = sections.filter((o) => o.kind === s.kind).length;
    if (s.count > 1 && !colors.has(s.kind)) colors.set(s.kind, colors.size);
    s.color = colors.get(s.kind) ?? -1;
  }
  return sections;
}

/** 0 → A, 25 → Z, 26 → AA, like spreadsheet columns. */
function letters(n: number): string {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Maps a frame count from the start of playback to a frame in the timeline, following the loop. */
export function timelineFrame(t: Timeline, frames: number): number {
  if (frames < t.length) return Math.max(0, frames);
  if (t.loopStart < 0 || t.loopStart >= t.length) return t.length;
  return t.loopStart + ((frames - t.length) % (t.length - t.loopStart));
}

/** The item whose [start, end) contains frame, by binary search. */
export function findAt<T extends { start: number; end: number }>(items: T[], frame: number): T | undefined {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].end <= frame) lo = mid + 1;
    else if (items[mid].start > frame) hi = mid - 1;
    else return items[mid];
  }
  return undefined;
}
