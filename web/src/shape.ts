// Instruments as shapes on a timeline, for the second instrument maker:
// waveforms are bars in time, one row per oscillator, and bars that overlap
// in time play together as a combined waveform; pitch is a line of steps.
// Both go into one GoatTracker wave program (each of its rows sets a
// waveform and a pitch), and pulse width into a pulse program.

import { FASTEST_DOWN, FASTEST_UP, fastestSweep, filterStep, pitchRight, pulseStep, sweepRows, waveLeft, WAVE_GATE, WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI, type Program, type Step } from './tables';

/** The waveform rows, top to bottom: pulse last, so its width row sits under everything */
export const LANES = [WAVE_TRI, WAVE_SAW, WAVE_NOISE, WAVE_PULSE];

/** A waveform playing for a while: frames from the start of the note. */
export interface Bar {
  wave: number;
  start: number;
  /** The first frame after it (null, from before holding was a setting of its own: until the note ends) */
  end: number | null;
}

/**
 * A change of pitch, in semitones from the note played. A pitch has no end
 * in the player: it holds until the next change.
 */
export interface Note {
  start: number;
  semis: number;
  /** Frames it slides over from the pitch before, arriving at start + glide (none: it jumps) */
  glide?: number;
  /** Always this pitch, whatever key is played: its semitones are then from C-4 (FIXED_BASE) */
  fixed?: boolean;
}

/** The note a fixed step's semitones are from: C-4 */
export const FIXED_BASE = 48;

/** Where a change of pitch arrives: after its glide */
export const arrival = (n: Note) => n.start + (n.glide ?? 0);

/** The range of the notes, in semitones from the note played */
export const NOTE_LOW = -32;
export const NOTE_HIGH = 48;

/** A pulse width (0-4095) at a time, in frames from the start of the note. */
export interface PulsePoint {
  t: number;
  w: number;
}

/**
 * Pulse width over the note: a line through points, holding after the
 * last one, or repeating from the `loop` point: from the last point it
 * goes straight back to the loop point's width and on again, so a repeat
 * can rise and fall back smoothly or jump.
 */
export interface PulseShape {
  points: PulsePoint[];
  loop: number | null;
  /**
   * Starts from the width the voice already had (no width set first), the
   * line's widths counted from 0 (its first point is the first frame's
   * move, within a sweep's 127 a frame); imported, no UI
   */
  inherit?: boolean;
}

/** A square wave: half the 12-bit range */
export const SQUARE = 0x800;
export const PULSE_MAX = 0xfff;

export function defaultPulse(): PulseShape {
  return { points: [{ t: 0, w: SQUARE }], loop: null };
}

export interface Shape {
  /** Its own id, which songs refer to it by */
  id?: string;
  name: string;
  ad: number;
  sr: number;
  bars: Bar[];
  pulse: PulseShape;
  notes: Note[];
  /** Where the waveform and notes repeat from (a frame where either changes), or null to play through once */
  waveLoop: number | null;
  /** After the last bar or note, without a repeat: hold where it got to (true) or fall silent */
  hold: boolean;
  /**
   * Vibrato on every note: how it wobbles (a speed table row), and the
   * player's delay before it starts (counted on the frames it runs
   * effects, so not quite frames)
   */
  vibrato: { delay: number; turn: number; even: boolean; depth: number } | null;
  /** The filter: used where its type has chunks (none: the instrument leaves the filter alone) */
  filter: FilterShape;
  /** The note its pitches are from: null for the key played, else always this note (GoatTracker's numbering) */
  fixedNote: number | null;
  /** Where the instrument lets go of the key itself (a frame), however long the note; null: when the key goes up */
  release: number | null;
  /** Each note silences the one before for a moment first (GoatTracker's hard restart), for a clean attack */
  hardRestart: boolean;
  /**
   * The waveform register's other bits over time: test, ring modulation and
   * sync (bars like the waveforms', each one bit). Ring and sync on for the
   * whole note are a bar from 0 with no end.
   */
  bits: Bar[];
  /** Notes run into each other without letting go (GoatTracker's gate timer bit $40) */
  legato: boolean;
  /** Frames before the next note that this one lets go (GoatTracker's gate timer, 2 by default) */
  gateFrames: number;
  /** The waveform for the frame before the program starts ($09 by default: test bit and gate) */
  firstWave: number;
  /** Leaves pulse width to the song (or whatever played before): no pulse program */
  pulseFromSong: boolean;
  /** Leaves the pitch as the note before set it until the first pitch step (none at all: the whole note); imported, no UI */
  pitchFromSong?: boolean;
}

/** The waveform register's bits that aren't oscillators */
export const TEST_BIT = 0x08;
export const RING_BIT = 0x04;
export const SYNC_BIT = 0x02;

/**
 * The filter as an instrument sets it, over time: its type (low, band, high
 * bits) in chunks, like waveform bars, filtering the voice while one lasts;
 * its cutoff (0-255) a line like pulse width; its resonance (0-15) a line
 * too (played as steps: the chip has 16 levels and no sweep for them). They
 * make one program, so the cutoff's repeat is theirs too.
 */
export interface FilterShape {
  types: FilterChunk[];
  cutoff: PulseShape;
  resonance: PulseShape;
}

/** A stretch of filtering of one type */
export interface FilterChunk {
  start: number;
  end: number;
  passband: number;
  /** The voices it filters (bits 0-2), as an imported instrument's do whichever voice plays it; without, the instrument's own; no UI */
  voices?: number;
}

export function defaultFilter(): FilterShape {
  return {
    types: [],
    cutoff: { points: [{ t: 0, w: 0xc0 }, { t: 25, w: 0x40 }], loop: null },
    resonance: { points: [{ t: 0, w: 8 }], loop: null },
  };
}

/** Puts a chunk of filtering in place: chunks it lands on are cut back or removed. */
export function placeChunk(chunks: FilterChunk[], chunk: FilterChunk): FilterChunk[] {
  const out: FilterChunk[] = [];
  for (const c of chunks) {
    if (c === chunk) continue;
    if (c.end <= chunk.start || c.start >= chunk.end) {
      out.push(c);
      continue;
    }
    if (c.start < chunk.start) out.push({ ...c, end: chunk.start });
    if (c.end > chunk.end) out.push({ ...c, start: chunk.end });
  }
  out.push(chunk);
  return out.sort((a, b) => a.start - b.start);
}

export const CUTOFF_MAX = 0xff;
export const RESONANCE_MAX = 15;

/** The chunk of filtering at a frame, if any */
export function chunkAt(types: FilterChunk[], t: number): FilterChunk | null {
  return types.find((c) => c.start <= t && t < c.end) ?? null;
}

/** A line's value at a frame (unrounded), holding after its last point, repeating from its loop */
export function lineAt(line: PulseShape, t: number): number {
  return widthOn(pulseLine(line, Math.max(t + 1, line.points[line.points.length - 1].t + 1)), t);
}

/** The parts of a shape that make its wave program */
export type WaveParts = Pick<Shape, 'bars' | 'notes' | 'waveLoop' | 'hold'> & Partial<Pick<Shape, 'fixedNote' | 'release' | 'bits' | 'pitchFromSong'>>;

/** Where the wave program's bars and notes end, or null if there are none. */
export function programEnd(s: Pick<Shape, 'bars' | 'notes'> & Partial<Pick<Shape, 'bits'>>): number | null {
  // (a bit on for the whole note, with no end, doesn't make the program longer)
  const bits = (s.bits ?? []).filter((b) => b.end !== null);
  const ends = [...s.bars.map((b) => b.end ?? b.start + 1), ...bits.map((b) => b.end!), ...s.notes.map((n) => arrival(n) + 1)];
  return ends.length ? Math.max(...ends) : null;
}

/** Whether the waveform and notes repeat: from the loop point to their end. */
export function waveLooping(s: WaveParts): boolean {
  const end = programEnd(s);
  return s.waveLoop !== null && end !== null && s.waveLoop < end;
}

/** The times the waveform or pitch changes before the end, where a repeat can start. */
export function waveChanges(s: WaveParts): number[] {
  return stretches(s).map((st) => st.start);
}

/** The pitch at a time: the last change at or before it, or the note played. */
export function pitchAt(notes: Note[], t: number): number {
  let pitch = 0;
  let from = -1;
  for (const n of notes) {
    if (n.start <= t && n.start > from) {
      pitch = n.semis;
      from = n.start;
    }
  }
  return pitch;
}

/** The pitch heard at a frame: the last change's, or part way along a glide to it */
export function glidePitchAt(notes: Note[], t: number): number {
  let before = 0;
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    if (n.start > t) break;
    const g = n.glide ?? 0;
    if (t < n.start + g) return before + ((n.semis - before) * (t - n.start + 1)) / (g + 1);
    before = n.semis;
  }
  return before;
}

/** A stretch of time with one waveform and one pitch: a row of the wave program. */
export interface Stretch {
  start: number;
  end: number | null;
  wave: number;
  pitch: number;
}

/** The stretches from the start of the note to the end of the last bar or note. */
export function stretches(s: Pick<Shape, 'bars' | 'notes'>): Stretch[] {
  const end = programEnd(s);
  if (end === null) return [];
  const cuts = new Set([0, end]);
  for (const b of s.bars) {
    cuts.add(Math.max(0, b.start));
    if (b.end !== null) cuts.add(b.end);
  }
  for (const n of s.notes) cuts.add(Math.max(0, n.start));
  const times = [...cuts].filter((t) => t <= end).sort((a, b) => a - b);
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const t = times[i];
    let wave = 0;
    for (const b of s.bars) if (b.start <= t && t < endOf(b)) wave |= b.wave;
    const pitch = pitchAt(s.notes, t);
    const last = out[out.length - 1];
    if (last && last.wave === wave && last.pitch === pitch) last.end = times[i + 1];
    else out.push({ start: t, end: times[i + 1], wave, pitch });
  }
  return out;
}

/** A stretch of time with one waveform (oscillator bits, 0 for none). */
export interface Span {
  start: number;
  end: number | null;
  wave: number;
}

const endOf = (b: { end: number | null }) => b.end ?? Infinity;

/** What plays when, from the start of the note: consecutive spans, the last one open. */
export function spans(bars: Bar[]): Span[] {
  // Time starts with the note: nothing plays before 0
  const cuts = new Set([0]);
  for (const b of bars) {
    cuts.add(Math.max(0, b.start));
    if (b.end !== null && b.end > 0) cuts.add(b.end);
  }
  const times = [...cuts].sort((a, b) => a - b);
  const out: Span[] = [];
  times.forEach((t, i) => {
    let wave = 0;
    for (const b of bars) if (b.start <= t && t < endOf(b)) wave |= b.wave;
    const end = i + 1 < times.length ? times[i + 1] : null;
    const last = out[out.length - 1];
    if (last && last.wave === wave) last.end = end;
    else out.push({ start: t, end, wave });
  });
  return out;
}

/** Whether a shape can be stored: noise with both saw and pulse collides with the table's commands. */
export function storable(bars: Bar[]): boolean {
  return spans(bars).every((s) => (s.wave & 0xf0) < 0xe0);
}

/** Frames a wave table delay row of 1-15 lasts, counting the frame it moves on. */
export const DELAY_FRAMES = (left: number) => left + 1;
const LONGEST_DELAY = 15;
const PITCH_KEEP = 0x80;
const WAVE_KEEP = 0;
/** Wave program commands that slide the pitch, by a speed table row */
const CMD_PORTA_UP = 1;
const CMD_PORTA_DOWN = 2;
/** A speed row worked out from the note: the semitone above it, halved by the right byte's count */
const CALCULATED = 0x80;
/** How much nearer a row must bring a glide to the line than waiting does (semitones) */
const NEAR = 0.005;

/**
 * The wave program for a shape: a row for each stretch, setting what
 * changes (the waveform, with the gate on, and the pitch), then waiting out
 * its time. After the last: with a repeat, a jump back to the stretch it
 * repeats from (which sets both outright, as anything may have changed
 * since); holding, the program just stops, leaving the pitch free for
 * effects; or a silent waveform, then stop.
 */
export function waveProgram(s: WaveParts, name: string, speedBase = 1): { program: Program; speeds: Step[] } {
  const end = programEnd(s);
  const fixed = s.fixedNote ?? null;
  const release = s.release ?? null;
  const pitchByte = (semis: number, step: boolean) =>
    pitchRight(fixed !== null ? { type: 'fixed', note: fixed + semis } : step ? { type: 'fixed', note: FIXED_BASE + semis } : { type: 'relative', semitones: semis });
  // Letting go of the key itself: the waveform written without its gate from then on
  const gate = (f: number) => (release !== null && f >= release ? 0 : WAVE_GATE);
  const steps: Step[] = [];
  const speeds: Step[] = [];
  if (end === null) {
    steps.push({ left: waveLeft({ type: 'wave', wave: gate(0) }), right: pitchByte(0, false) });
    return { program: { name, steps, next: null }, speeds };
  }
  const looping = waveLooping(s);
  const loop = looping ? s.waveLoop! : null;
  const period = end - (loop ?? 0);
  // Where the program jumps back to, and the frames it plays first
  let target = loop;
  let frames = end;
  if (looping && release !== null && release > loop!) {
    // Letting go during the repeats: they play on to there, then a copy of
    // the repeat without the key goes round instead
    target = loop! + Math.ceil((release - loop!) / period) * period;
    frames = target + period;
  } else if (!looping) frames = Math.max(end + (s.hold ? 0 : 1), release !== null ? release + 1 : 0);
  const notes = [...s.notes].sort((a, b) => a.start - b.start);
  const waveAt = (t: number) => {
    let w = 0;
    for (const b of [...s.bars, ...(s.bits ?? [])]) if (b.start <= t && t < (b.end ?? Infinity)) w |= b.wave;
    return w;
  };
  // Whether the step heard at a frame is fixed (gliding, the one it glides to)
  const fixedAt = (t: number) => {
    let at: Note | null = null;
    for (const n of notes) if (n.start <= t) at = n;
    return !!at?.fixed;
  };
  const gliding = (t: number) => notes.some((n) => n.start <= t && t < arrival(n));
  // Before the first pitch step, the pitch the note before left (if the instrument leaves it)
  const leftAlone = (t: number) => !!s.pitchFromSong && (!notes.length || t < notes[0].start);
  // Where a pitch is set: even the one it is already on (that starts vibrato's wobble again)
  const sets = new Set(notes.map(arrival));
  // Frames without a row of their own wait, after the last row
  let idle = 0;
  const flush = () => {
    let rest = idle;
    idle = 0;
    while (rest > 0) {
      if (rest === 1) {
        // A row that changes nothing takes a single frame
        steps.push({ left: WAVE_KEEP, right: PITCH_KEEP });
        rest = 0;
      } else {
        const left = Math.min(LONGEST_DELAY, rest - 1);
        steps.push({ left, right: PITCH_KEEP });
        rest -= DELAY_FRAMES(left);
      }
    }
  };
  const speedRow = (shift: number) => {
    let i = speeds.findIndex((r) => r.right === shift);
    if (i < 0) i = speeds.push({ left: CALCULATED, right: shift }) - 1;
    return speedBase + i;
  };
  // The pitch now (between semitones while gliding), and the semitone last set (glides go in fractions of the one above it)
  let wave = -1;
  let cur = 0;
  let curFixed = false;
  let last = 0;
  let back = 0;
  for (let f = 0; f < frames; f++) {
    const t = looping && f >= end ? loop! + ((f - loop!) % period) : f;
    const past = !looping && t >= end;
    const w = (past ? (s.hold ? waveAt(end - 1) : 0) : waveAt(t)) | gate(f);
    const want = glidePitchAt(notes, past ? end - 1 : t);
    const wantFixed = fixedAt(past ? end - 1 : t);
    // The first row sets both (the player sets the pitch only from the
    // program), and so does the one the repeat comes back to
    const all = (f === 0 && !leftAlone(t)) || f === target;
    if (f === 0 || all || w !== wave) {
      const n = Math.round(want);
      const set = !leftAlone(t) && (all || (gliding(t) ? Math.abs(n - want) < Math.abs(cur - want) : want !== cur || wantFixed !== curFixed || (!past && sets.has(t))));
      flush();
      if (f === target) back = steps.length;
      steps.push({ left: waveLeft({ type: 'wave', wave: w }), right: set ? pitchByte(n, wantFixed) : PITCH_KEEP });
      wave = w;
      if (set) {
        cur = last = n;
        curFixed = wantFixed;
      }
      continue;
    }
    if (leftAlone(t)) {
      idle++;
      continue;
    }
    if (past || !gliding(t)) {
      if (want !== cur || wantFixed !== curFixed || (!past && sets.has(t))) {
        flush();
        steps.push({ left: WAVE_KEEP, right: pitchByte(want, wantFixed) });
        cur = last = want;
        curFixed = wantFixed;
      } else idle++;
      continue;
    }
    // Gliding: whichever comes nearest the line: staying, a semitone, or a
    // slide up or down by a fraction of the semitone above the last one set
    // (a speed the player works out from the note, so the glide covers the
    // same interval on any key)
    const n = Math.round(want);
    let best: { err: number; to: number; step: Step | null; shift: number } = { err: Math.abs(cur - want), to: cur, step: null, shift: -1 };
    if (Math.abs(n - want) < best.err - NEAR) best = { err: Math.abs(n - want), to: n, step: { left: WAVE_KEEP, right: pitchByte(n, wantFixed) }, shift: -1 };
    const semitone = 2 ** (last / 12) * (2 ** (1 / 12) - 1);
    for (let shift = 0; shift < 8; shift++) {
      for (const dir of [1, -1]) {
        const freq = 2 ** (cur / 12) + (dir * semitone) / 2 ** shift;
        if (freq <= 0) continue;
        const to = 12 * Math.log2(freq);
        if (Math.abs(to - want) < best.err - NEAR) best = { err: Math.abs(to - want), to, step: { left: waveLeft({ type: 'command', command: dir > 0 ? CMD_PORTA_UP : CMD_PORTA_DOWN }), right: 0 }, shift };
      }
    }
    if (!best.step) {
      idle++;
      continue;
    }
    if (best.shift >= 0) best.step.right = speedRow(best.shift);
    flush();
    steps.push(best.step);
    cur = best.to;
    if (best.shift < 0) {
      last = n;
      curFixed = wantFixed;
    }
  }
  // Waits before going round again (a jump takes no frame); otherwise the last row holds
  if (looping) flush();
  const program: Program = { name, steps, next: null };
  if (looping) program.next = { program, step: back };
  return { program, speeds };
}

/**
 * The pulse program for a shape that uses pulse: set the first width, then
 * sweep to each point in turn over the time to it; then stop (holding the
 * width), or jump back to the rows that leave the loop point. Setting the
 * width takes the first frame and each sweep a frame per frame of it, so
 * each point's width is reached exactly at its time.
 *
 * The player's sweeps move at most 127 up or 128 down a frame (the speed is
 * one signed byte); the chip itself takes any width any frame. So a steeper
 * stretch sets the width on each of its frames instead, along the line:
 * exact, at a row a frame.
 */
export function pulseProgram(bars: Bar[], pulse: PulseShape, name: string): Program | null {
  if (!bars.some((b) => b.wave & WAVE_PULSE)) return null;
  // Carrying on from the voice's width: the first frame moves it by its own (from 0), as a one-frame sweep
  const w0 = pulse.points[0].w;
  const first = pulse.inherit ? pulseStep({ type: 'sweep', frames: 1, speed: w0 > 0x7ff ? w0 - 0x1000 : w0 }) : pulseStep({ type: 'width', width: w0 });
  return lineProgram(pulse, name, [first], (width) => pulseStep({ type: 'width', width }), (sw) =>
    pulseStep({ type: 'sweep', ...sw }),
  );
}

/**
 * The filter program: the cutoff line as pulse width's, with the filter set
 * up (type, resonance, the voice it filters) on its first frame and again
 * wherever the type or resonance level changes. A setup row and a cutoff row
 * share a frame, so each setup lands on its frame with the cutoff where the
 * line has it, and the line goes on undisturbed. The cutoff's repeat sets
 * everything up again as it comes round.
 */
export function filterProgram(filter: FilterShape, name: string, voices = 1): Program {
  // A chunk ending on the repeat's end covers that frame too: it is the
  // repeat's last, so the chunk stays on all the way round
  const loopEnd = filter.cutoff.loop !== null && filter.cutoff.loop < filter.cutoff.points.length - 1 ? filter.cutoff.points[filter.cutoff.points.length - 1].t : null;
  filter = { ...filter, types: filter.types.map((c) => (c.end === loopEnd ? { ...c, end: c.end + 1 } : c)) };
  const res = (t: number) => Math.max(0, Math.min(RESONANCE_MAX, Math.round(lineAt(filter.resonance, t))));
  // Outside the chunks the voice goes past the filter (keeping the last type, which is then unheard)
  const typeFor = (t: number) => chunkAt(filter.types, t)?.passband ?? [...filter.types].reverse().find((c) => c.start <= t)?.passband ?? filter.types[0]?.passband ?? 0;
  const route = (t: number) => {
    const c = chunkAt(filter.types, t);
    return c ? (c.voices ?? voices) : 0;
  };
  const setup = (t: number) => filterStep({ type: 'setup', passband: typeFor(t), resonance: res(t), voices: route(t) });
  const cut = filter.cutoff;
  const last = cut.points[cut.points.length - 1].t;
  const looping = cut.loop !== null && cut.loop < cut.points.length - 1;
  // Frames where the setup changes: type changes, and resonance level steps
  const changes = new Set<number>();
  for (const c of filter.types) {
    if (c.start > 0) changes.add(c.start);
    changes.add(c.end);
  }
  const resEnd = Math.max(last, filter.resonance.points[filter.resonance.points.length - 1].t);
  for (let t = 1; t <= resEnd + 1; t++) if (res(t) !== res(t - 1)) changes.add(t);
  // Within a repeat they play each time round; without, the cutoff holds while later ones come
  const end = looping ? last : Math.max(last, ...changes);
  const times = [...changes].filter((t) => t <= end).sort((a, b) => a - b);
  // The cutoff's corners, with a point at each setup change (on the line there)
  const corners = cut.points.map((p) => ({ t: p.t, w: p.w, setup: false, loop: false }));
  if (looping) corners[cut.loop!].loop = true;
  if (!looping && end > last) corners.push({ t: end, w: cut.points[cut.points.length - 1].w, setup: false, loop: false });
  for (const t of times) {
    const at = corners.findIndex((c) => c.t >= t);
    if (at >= 0 && corners[at].t === t) corners[at].setup = true;
    else corners.splice(at < 0 ? corners.length : at, 0, { t, w: Math.round(lineAt(cut, t)), setup: true, loop: false });
  }
  const set = (cutoff: number) => filterStep({ type: 'cutoff', cutoff });
  const steps: Step[] = [setup(0), set(corners[0].w)];
  let back = 0;
  const along = (i: number, f: number, frames: number) => corners[i].w + Math.round(((corners[i + 1].w - corners[i].w) * f) / frames);
  for (let i = 0; i + 1 < corners.length; i++) {
    const frames = Math.max(1, corners[i + 1].t - corners[i].t);
    // Coming round again: everything set again on the stretch's first frame
    const first = corners[i].loop ? 1 : 0;
    if (first) {
      back = steps.length;
      steps.push(setup(corners[i].t + 1), set(along(i, 1, frames)));
    }
    // A setup change at the far end takes the last frame, with the cutoff set
    // (unless that is the frame a repeat's first already set up)
    const last = corners[i + 1].setup && !(first && frames === 1) ? 1 : 0;
    const from = first ? along(i, 1, frames) : corners[i].w;
    const rest = frames - first - last;
    const to = last ? along(i, frames - 1, frames) : corners[i + 1].w;
    if (rest > 0) {
      const change = to - from;
      if (fastestSweep(change) <= rest) for (const sw of sweepRows(change, rest)) steps.push(filterStep({ type: 'sweep', ...sw }));
      else for (let f = first + 1; f <= frames - last; f++) steps.push(set(along(i, f, frames)));
    }
    if (last) steps.push(setup(corners[i + 1].t), set(corners[i + 1].w));
  }
  const program: Program = { name, steps, next: null };
  if (looping) program.next = { program, step: back };
  return program;
}

/** A line of points as program rows: `first` sets the start, then a set or sweep rows for each stretch. */
function lineProgram(line: PulseShape, name: string, first: Step[], set: (v: number) => Step, sweep: (sw: { frames: number; speed: number }) => Step): Program {
  const pts = line.points;
  const steps: Step[] = [...first];
  const leaving: number[] = [];
  const along = (i: number, f: number, frames: number) => pts[i].w + Math.round(((pts[i + 1].w - pts[i].w) * f) / frames);
  for (let i = 0; i + 1 < pts.length; i++) {
    leaving.push(steps.length);
    const frames = Math.max(1, pts[i + 1].t - pts[i].t);
    // The repeat jumps back here, wherever the line has got to, so this
    // stretch starts by setting its first frame's value outright
    const first = i === line.loop ? 1 : 0;
    if (first) steps.push(set(along(i, 1, frames)));
    const from = first ? along(i, 1, frames) : pts[i].w;
    let change = pts[i + 1].w - from;
    const rest = frames - first;
    // A hair steeper than the fastest sweep, by no more than the lowest bit
    // a traced width loses each end: the fastest sweep
    const most = rest * (change >= 0 ? FASTEST_UP : FASTEST_DOWN);
    if (rest > 0 && Math.abs(change) > most && Math.abs(change) - most <= 2) change = Math.sign(change) * most;
    if (rest > 0 && fastestSweep(change) <= rest) for (const sw of sweepRows(change, rest)) steps.push(sweep(sw));
    else for (let f = first + 1; f <= frames; f++) steps.push(set(along(i, f, frames)));
  }
  const program: Program = { name, steps, next: null };
  if (line.loop !== null && line.loop < pts.length - 1) program.next = { program, step: leaving[line.loop] };
  return program;
}

/** The corners of the pulse width line up to `frames`, with a loop repeated to fill it. */
export function pulseLine(pulse: PulseShape, frames: number): PulsePoint[] {
  const pts = pulse.points;
  const last = pts[pts.length - 1];
  const out = pts.map((p) => ({ ...p }));
  if (pulse.loop !== null && pulse.loop < pts.length - 1) {
    // Each time round starts at the loop point's width (a jump if the last point isn't there)
    const body = pts.slice(pulse.loop);
    const period = last.t - pts[pulse.loop].t;
    for (let n = 1; last.t + (n - 1) * period < frames; n++) for (const p of body) out.push({ t: p.t + n * period, w: p.w });
  } else out.push({ t: frames, w: last.w });
  return out;
}

/**
 * Puts a bar in place: bars it lands on in its own row are cut back or
 * removed, the way a clip dropped on another overwrites it.
 */
export function place(bars: Bar[], bar: Bar): Bar[] {
  const out: Bar[] = [];
  const s = bar.start;
  const e = endOf(bar);
  for (const b of bars) {
    if (b === bar) continue;
    if (b.wave !== bar.wave || endOf(b) <= s || b.start >= e) {
      out.push(b);
      continue;
    }
    if (b.start < s) out.push({ ...b, end: s });
    if (endOf(b) > e) out.push({ ...b, start: e });
  }
  out.push(bar);
  return out.sort((a, b) => a.start - b.start || LANES.indexOf(a.wave) - LANES.indexOf(b.wave));
}

/** The pulse width (0-4095) at a time, from the line's corners (as pulseLine gives them). */
export function widthOn(line: PulsePoint[], t: number): number {
  for (let i = line.length - 1; i > 0; i--) {
    const a = line[i - 1];
    const b = line[i];
    if (t < a.t) continue;
    if (t >= b.t) return b.w;
    return a.w + ((b.w - a.w) * (t - a.t)) / (b.t - a.t);
  }
  return line[0].w;
}

/** A stretch of what is heard; `again` marks a repeat's copies, `from` where each began first time round. */
export interface HeardSpan extends Stretch {
  again?: boolean;
  from: number;
}

/**
 * What is heard up to `frames`: the stretches, then a repeat's copied on
 * after the end, the last held on, or silence (at the last pitch).
 */
export function heardSpans(s: WaveParts, frames: number): HeardSpan[] {
  const out: HeardSpan[] = stretches(s).map((st) => ({ ...st, from: st.start }));
  const end = programEnd(s);
  if (end === null) return out;
  if (waveLooping(s)) {
    const loop = s.waveLoop!;
    const body = out.filter((st) => st.end! > loop).map((st) => ({ ...st, start: Math.max(st.start, loop) }));
    const period = end - loop;
    for (let n = 1; end + (n - 1) * period < frames; n++) {
      for (const st of body) out.push({ ...st, start: st.start + n * period, end: st.end! + n * period, again: true });
    }
  } else if (s.hold) out[out.length - 1].end = null;
  else out.push({ start: end, end: null, wave: 0, pitch: out[out.length - 1].pitch, from: end });
  return out;
}

/** Puts a change of pitch in place: one at a time, so it replaces any already there. */
export function placeNote(notes: Note[], note: Note): Note[] {
  return [...notes.filter((n) => n !== note && n.start !== note.start), note].sort((a, b) => a.start - b.start);
}
