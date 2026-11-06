// SIDKid's own songs: any number of tracks, each a run of clips of notes for
// one instrument, played on a voice of the chip. Tracks sharing a voice take
// turns: the newest note takes the voice, and when it ends, a note still
// held on another track comes back. This file turns a song into the timed
// notes the player plays (a Sequence).

import { LET_GO, SKIP_PULSE, type SeqEvent, type Sequence } from './engine/sequencer';
import type { Shape } from './shape';

export const VOICES = 3;

/** A note in a clip, in steps from the clip's start */
export interface SongNote {
  start: number;
  length: number;
  /** 0 = C-0, as GoatTracker counts */
  note: number;
  /** Slides here from the note before (which goes on, not starting again), at this speed; null: at once */
  slide?: Speed | null;
  /** What it does to its pitch, over steps of it (one thing a step, as GoatTracker's rows) */
  effects?: NoteEffect[];
}

/** A speed, as a row of GoatTracker's speed table: a 16-bit amount a frame, or (left $80 up) a fraction of a semitone */
export interface Speed {
  left: number;
  right: number;
}

/** Bending up or down, sliding on toward the note, or vibrato, over steps [from, to) of a note */
export interface NoteEffect {
  from: number;
  to: number;
  kind: 'up' | 'down' | 'slide' | 'vibrato';
  /** null: none (a slide: there at once) */
  speed: Speed | null;
}

/** Frames before a step's note sounds that its row starts (tick 0) */
export const ROW_EARLY = 1;
/**
 * In songs imported from GoatTracker, timed as its player does: frames
 * before a step's frame that the row is read (a note's gate goes off and
 * it starts, a key-off lets go, the pulse rests); the row's tick 0 comes
 * the instrument's gate frames after, and its note a frame after that.
 */
export const GOAT_READ = 3;
const gateOf = (s: Shape) => s.gateFrames & 0x3f;

/** The speeds a song's slides and effects use, each once */
export function songSpeeds(song: SongDoc): Speed[] {
  const seen = new Map<string, Speed>();
  for (const t of song.tracks)
    for (const c of t.clips)
      for (const n of c.notes) for (const sp of [n.slide, ...(n.effects ?? []).map((e) => e.speed)]) if (sp) seen.set(`${sp.left}/${sp.right}`, sp);
  return [...seen.values()];
}

/** GoatTracker's pattern commands for the effects */
export const EFFECT_COMMANDS: Record<NoteEffect['kind'], number> = { up: 1, down: 2, slide: 3, vibrato: 4 };

/** A stretch of a track: its notes, played for `span` steps, repeating every `length` */
export interface Clip {
  start: number;
  length: number;
  span: number;
  notes: SongNote[];
}

export interface Track {
  id: string;
  /** The instrument (its id in Instrument Maker 2) */
  instrument: string;
  /** 0-2 */
  voice: number;
  muted: boolean;
  clips: Clip[];
}

/** A change of tempo at a step: held from there, or reached by a ramp from the change before */
export interface TempoChange {
  step: number;
  bpm: number;
  ramp?: boolean;
}

export interface SongDoc {
  name: string;
  /** Beats a minute from the start (each step starts on the frame nearest its time, so any tempo works) */
  bpm: number;
  /** Where the tempo changes after that, in step order */
  tempo?: TempoChange[];
  stepsPerBeat: number;
  beatsPerBar: number;
  tracks: Track[];
  /** The stretch Play repeats while cycling, in steps */
  cycle: { start: number; end: number };
  cycling: boolean;
  /**
   * Imported from GoatTracker: plays as its song player did, which holds
   * each voice's pulse program still a frame on every row, and again after
   * each pattern's last row (its pulse optimization). Where each voice's
   * patterns start, and the steps the rows run to.
   */
  goat?: { patterns: number[][]; end: number; /** false: the song was played without it */ pulseOptimization?: boolean };
}

/** Frames a step lasts at the song's starting tempo, not a whole number in general */
export const framesPerStep = (song: SongDoc, fps: number) => (60 * fps) / (song.bpm * song.stepsPerBeat);

/** The tempo during a step: the change it's in (or on its way to, on a ramp) */
export function bpmAt(song: SongDoc, step: number): number {
  let bpm = song.bpm;
  let from = 0;
  for (const c of song.tempo ?? []) {
    if (c.step > step) {
      // On a ramp: the way along it from the change before
      if (c.ramp && c.step > from) return bpm + ((c.bpm - bpm) * (step - from)) / (c.step - from);
      return bpm;
    }
    bpm = c.bpm;
    from = c.step;
  }
  return bpm;
}

/** Frames each step from 0 starts at, for songs whose tempo changes (worked out as far as asked for) */
const starts = new WeakMap<SongDoc, { key: string; at: number[] }>();
function stepStarts(song: SongDoc, fps: number, upTo: number): number[] {
  const key = JSON.stringify([song.bpm, song.stepsPerBeat, song.tempo, fps]);
  let c = starts.get(song);
  if (!c || c.key !== key) {
    c = { key, at: [0] };
    starts.set(song, c);
  }
  const at = c.at;
  while (at.length <= upTo) {
    const k = at.length - 1;
    at.push(at[k] + (60 * fps) / (bpmAt(song, k) * song.stepsPerBeat));
  }
  return at;
}

/** Where a step (or part of one) starts, in frames, exactly */
export function exactFrame(song: SongDoc, step: number, fps: number): number {
  if (!song.tempo?.length || step <= 0) return step * framesPerStep(song, fps);
  const k = Math.floor(step);
  const at = stepStarts(song, fps, k + 1);
  return at[k] + (step - k) * (at[k + 1] - at[k]);
}

/** The frame a step (or part of one) starts on: the nearest */
export const frameAt = (song: SongDoc, step: number, fps: number) => Math.round(exactFrame(song, step, fps));

/** The step (with how far into it) at a frame */
export function stepAt(song: SongDoc, frame: number, fps: number): number {
  if (!song.tempo?.length || frame <= 0) return frame / framesPerStep(song, fps);
  // Past the last change it's steady: count on from there
  const lastChange = song.tempo[song.tempo.length - 1].step;
  let at = stepStarts(song, fps, lastChange + 1);
  if (frame >= at[lastChange]) return lastChange + (frame - at[lastChange]) / (at[lastChange + 1] - at[lastChange]);
  let lo = 0;
  let hi = lastChange;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= frame) lo = mid;
    else hi = mid;
  }
  at = stepStarts(song, fps, lo + 1);
  return lo + (frame - at[lo]) / (at[lo + 1] - at[lo]);
}

export const newId = () => Math.random().toString(36).slice(2, 10);

/** Where a song's clips end, in steps */
export function songEnd(song: SongDoc): number {
  return Math.max(0, ...song.tracks.flatMap((t) => t.clips.map((c) => c.start + c.span)));
}

/** A clip's notes as heard, repeats and all, in steps from the song's start */
export function clipNotes(c: Clip): SongNote[] {
  const out: SongNote[] = [];
  for (let at = 0; at < c.span; at += c.length) {
    for (const n of c.notes) {
      if (n.start >= c.length || at + n.start >= c.span) continue;
      // A note runs to the end of its pass at most
      const length = Math.min(n.length, c.length - n.start, c.span - at - n.start);
      out.push({ ...n, start: c.start + at + n.start, length });
    }
  }
  return out;
}

/** What plays on a voice for a while: a note from a track, possibly cut short or come back to */
export interface Segment {
  start: number;
  end: number;
  note: number;
  track: number;
  /** Frames into the note it starts at: 0 for a note starting, more for one getting its voice back */
  from: number;
  /** The note's step, and what it does */
  step: number;
  slide?: Speed | null;
  effects?: NoteEffect[];
}

interface Held {
  start: number;
  end: number;
  note: number;
  track: number;
  order: number;
  step: number;
  slide?: Speed | null;
  effects?: NoteEffect[];
}

/**
 * The notes on one voice, in frames, after tracks take turns: at each moment
 * the voice plays the held note that started last (on the same frame, the
 * track higher up wins). A note that gets the voice back starts again.
 */
export function voiceSegments(song: SongDoc, voice: number, fps: number): Segment[] {
  const held: Held[] = [];
  let order = 0;
  song.tracks.forEach((t, ti) => {
    if (t.voice !== voice || t.muted) return;
    for (const c of t.clips) {
      for (const n of clipNotes(c)) {
        held.push({ start: frameAt(song, n.start, fps), end: frameAt(song, n.start + n.length, fps), note: n.note, track: ti, order: order++, step: n.start, slide: n.slide, effects: n.effects });
      }
    }
  });
  const times = [...new Set(held.flatMap((h) => [h.start, h.end]))].sort((a, b) => a - b);
  const out: Segment[] = [];
  let last: Held | null = null;
  for (let i = 0; i < times.length - 1; i++) {
    const t = times[i];
    let top: Held | null = null;
    for (const h of held) {
      if (h.start > t || h.end <= t) continue;
      if (!top || h.start > top.start || (h.start === top.start && h.track < top.track)) top = h;
    }
    const prev = out[out.length - 1];
    if (top && top === last && prev && prev.end === t) prev.end = times[i + 1];
    else if (top) out.push({ start: t, end: times[i + 1], note: top.note, track: top.track, from: t - top.start, step: top.step, ...(top.slide !== undefined ? { slide: top.slide } : {}), ...(top.effects ? { effects: top.effects } : {}) });
    last = top;
  }
  return out;
}

/** Instruments a song plays, one for each instrument on each voice (the filter is told which voice it filters) */
export interface SongSound {
  shape: Shape;
  voice: number;
}

/**
 * The sounds a song needs (every track's, whether it has notes yet or not,
 * so a key can play it) and the number of each track's sound (1-based).
 */
export function songSounds(song: SongDoc, instruments: Map<string, Shape>): { sounds: SongSound[]; trackSound: number[] } {
  const sounds: SongSound[] = [];
  const key = new Map<string, number>();
  const trackSound = song.tracks.map((t) => {
    const shape = instruments.get(t.instrument);
    if (!shape) return 0;
    const k = `${t.instrument}/${t.voice}`;
    if (!key.has(k)) {
      sounds.push({ shape, voice: t.voice });
      key.set(k, sounds.length);
    }
    return key.get(k)!;
  });
  return { sounds, trackSound };
}

/** Frames before its frame a note has to be started: the player waits the gate timer, and a frame more */
export const leadOf = (s: Shape) => (s.gateFrames & 0x3f) + 1;
/** The same for a note picking up where it left off (its gate goes off for a frame at least, see resume.ts) */
export const resumeLeadOf = (s: Shape) => Math.max(1, s.gateFrames & 0x3f) + 1;

/**
 * Picks a note up where it left off: the number of an instrument that does
 * (a variant of the sound, `from` frames in), 'silent' when there's nothing
 * left to pick up, or null to start the note again instead.
 */
export type Resumer = (sound: number, from: number) => number | 'silent' | null;

/**
 * The timed notes for playing a song from `from` (a frame): through to its
 * end, or with a cycle (frames), on to the cycle's end and then round it.
 * Frame 0 of the sequence is `from`; songFrame() maps back.
 */
export function songSequence(
  song: SongDoc,
  sounds: SongSound[],
  trackSound: number[],
  from: number,
  cycle: { start: number; end: number } | null,
  fps: number,
  /** Clicks on the beats, and a bar of them first (count-in) */
  metronome: { click: boolean; countIn: boolean } = { click: false, countIn: false },
  resume: Resumer = () => null,
  /** The speed table row a speed is in (0 for none) */
  speedRow: (speed: Speed | null) => number = () => 0,
): Sequence {
  const end = cycle ? cycle.end : frameAt(song, songEnd(song), fps);
  // The first pass, from where playing starts; then the cycle, round and round
  const firstLength = Math.max(0, end - from);
  const loopFrom = cycle ? firstLength : null;
  const length = cycle ? firstLength + (cycle.end - cycle.start) : firstLength + 1;
  // A bar's frames, at the tempo where playing starts (for the count-in)
  const barSteps = song.stepsPerBeat * song.beatsPerBar;
  const fromStep = stepAt(song, from, fps);
  const bar = exactFrame(song, fromStep, fps) - exactFrame(song, fromStep - barSteps, fps);
  const preroll = Math.max(1, song.goat ? GOAT_READ : 0, ...sounds.map((s) => Math.max(leadOf(s.shape), resumeLeadOf(s.shape))), metronome.countIn ? Math.ceil(bar) + 1 : 0);
  const events: SeqEvent[] = [];
  for (let voice = 0; voice < VOICES; voice++) {
    const all = voiceSegments(song, voice, fps).filter((s) => trackSound[s.track] > 0);
    // (a note getting its voice back that's cut by where playing starts picks up further in)
    const clip = (a: number, b: number, shift: number) =>
      all
        .filter((s) => s.end > a && s.start < b)
        .map((s) => ({ ...s, from: s.from && s.start < a ? s.from + a - s.start : s.from, start: Math.max(a, s.start) + shift, end: Math.min(b, s.end) + shift }));
    // Each note getting its voice back: the instrument that picks it up (dropped when there's nothing to pick up)
    const placed = (list: Segment[]) =>
      list.flatMap((s) => {
        if (!s.from) return [{ ...s, instrument: trackSound[s.track], resumed: false }];
        const r = resume(trackSound[s.track], s.from);
        if (r === 'silent') return [];
        return [{ ...s, instrument: r ?? trackSound[s.track], resumed: r !== null }];
      });
    const first = placed(clip(from, end, -from));
    const round = cycle ? placed(clip(cycle.start, cycle.end, firstLength - cycle.start)) : [];
    const segs = [...first, ...round];
    const sound = (s: Segment) => sounds[trackSound[s.track] - 1].shape;
    // A note sliding from the one before goes on from it: no start of its own, nor a let-go before it
    const slides = (s: (typeof segs)[number], before: (typeof segs)[number] | undefined) => s.slide !== undefined && !s.from && !!before && before.end >= s.start;
    const lead = (s: (typeof segs)[number]) => (song.goat ? GOAT_READ : s.resumed ? resumeLeadOf(sound(s)) : leadOf(sound(s)));
    // Where a row starts (tick 0) for a step at frame f, its voice playing an instrument
    const rowFrame = (f: number, shape: Shape) => (song.goat ? f - GOAT_READ + gateOf(shape) : f - ROW_EARLY);
    // The pass coming round again, for the notes ending the cycle
    const again = round.length ? { ...round[0], start: round[0].start + (cycle!.end - cycle!.start), end: round[0].end } : null;
    segs.forEach((s, i) => {
      const shape = sound(s);
      const sliding = slides(s, segs[i - 1]);
      // (a slide is a row's note: the frame before the note's own, as rows are)
      const on = sliding ? rowFrame(s.start, shape) : s.start - lead(s);
      const early = loopFrom !== null && s.start >= loopFrom && on < loopFrom ? { lead: true } : {};
      if (sliding) events.push({ frame: on, voice, note: s.note, instrument: 0, kind: 'slide', data: speedRow(s.slide ?? null), ...early });
      else events.push({ frame: on, voice, note: s.note, instrument: s.instrument, ...early });
      // Let go at the end, unless the next note on the voice starts first
      // (starting a note lets go of the last), or the instrument lets go itself
      const next = segs[i + 1] ?? (cycle ? again : null);
      // (an instrument that lets go by itself is left to, but GoatTracker's key-offs cut it short in songs imported from it)
      if (shape.release !== null && !song.goat) return;
      if (next && slides(next, s)) return;
      // (it lets go the lead before its end, as the player looks ahead to a key-off row as to a note)
      const off = s.end - lead(s);
      if (next && next.start - lead(next) <= off) return;
      events.push({ frame: Math.min(off, length - 1), voice, note: LET_GO, instrument: 0 });
    });
  }
  // Every step a row on each voice, as a song's player reads them: its first
  // frame is tick 0 (effects rest), and it carries the effect of the note
  // playing then (GoatTracker's command for that row)
  for (let voice = 0; voice < VOICES; voice++) {
    const all = voiceSegments(song, voice, fps);
    const shapeOf = (sg: Segment) => sounds[(trackSound[sg.track] || 1) - 1]?.shape;
    const add = (a: number, b: number, shift: number) => {
      const lo = Math.max(0, Math.floor(stepAt(song, a, fps)) - 1);
      const hi = Math.ceil(stepAt(song, b, fps)) + 1;
      let k = 0;
      // The instrument the voice last started a note with (its gate frames time imported songs' rows)
      let last = all[0];
      let j = 0;
      for (let step = lo; step <= hi; step++) {
        const f = frameAt(song, step, fps);
        if (f < a || f >= b) continue;
        while (k < all.length && all[k].end <= f) k++;
        for (; j < all.length && all[j].start <= f; j++) if (!all[j].from) last = all[j];
        const seg = all[k] && all[k].start <= f ? all[k] : null;
        const fx = seg?.effects?.find((e) => step - seg.step >= e.from && step - seg.step < e.to);
        const playing = last && shapeOf(last);
        const frame = (playing ? (song.goat ? f - GOAT_READ + gateOf(playing) : f - ROW_EARLY) : f - ROW_EARLY) + shift;
        events.push({
          frame,
          voice,
          note: 0,
          instrument: 0,
          kind: 'row',
          frames: frameAt(song, step + 1, fps) - f,
          command: fx ? EFFECT_COMMANDS[fx.kind] : 0,
          data: fx ? speedRow(fx.speed) : 0,
          ...(loopFrom !== null && f + shift >= loopFrom && frame < loopFrom ? { lead: true } : {}),
        });
      }
    };
    add(from, end, -from);
    if (cycle) add(cycle.start, cycle.end, firstLength - cycle.start);
  }
  if (song.goat && song.goat.pulseOptimization !== false) {
    const skips = goatPulseSkips(song, sounds, trackSound, fps);
    skips.forEach((frames, voice) => {
      const add = (a: number, b: number, shift: number) => {
        for (const f of frames) if (f >= a && f < b) events.push({ frame: f + shift, voice, note: SKIP_PULSE, instrument: 0 });
      };
      add(from, end, -from);
      if (cycle) add(cycle.start, cycle.end, firstLength - cycle.start);
    });
  }
  // Within a frame: letting go first, then the row, then notes and slides (a slide's command is its row's)
  const order = (e: SeqEvent) => (e.kind === 'row' ? 1 : e.kind === 'slide' || e.note >= 0 ? 2 : 0);
  events.sort((a, b) => a.frame - b.frame || order(a) - order(b));
  // The metronome on the song's beats: the count-in's bar before `from`, the first pass, the cycle
  const beats: number[] = [];
  const bars: number[] = [];
  const clicks = (a: number, b: number, shift: number) => {
    for (let k = Math.floor(stepAt(song, a, fps) / song.stepsPerBeat) - 1; k <= Math.ceil(stepAt(song, b, fps) / song.stepsPerBeat) + 1; k++) {
      const t = frameAt(song, k * song.stepsPerBeat, fps);
      if (t >= a && t < b) (k % song.beatsPerBar === 0 ? bars : beats).push(t + shift);
    }
  };
  // A bar of the song's beats before playing starts
  if (metronome.countIn) clicks(from - bar, from, -from);
  if (metronome.click) {
    clicks(from, end, -from);
    if (cycle) clicks(cycle.start, cycle.end, firstLength - cycle.start);
  }
  return { events, length, loopFrom, preroll, beats, bars };
}

/**
 * The frames of each voice where GoatTracker's player holds its pulse
 * still (see SongDoc.goat): on every row, the instrument's lead before it
 * (when the player looks ahead to the next row; the instrument is the one
 * the voice last started a note with), and the frame after each pattern's
 * last row.
 */
function goatPulseSkips(song: SongDoc, sounds: SongSound[], trackSound: number[], fps: number): number[][] {
  const goat = song.goat!;
  return [0, 1, 2].map((voice) => {
    const starts = voiceSegments(song, voice, fps)
      .filter((s) => !s.from && trackSound[s.track])
      .map((s) => ({ frame: s.start, lead: leadOf(sounds[trackSound[s.track] - 1].shape) }));
    const out: number[] = [];
    let k = 0;
    let lead = starts[0]?.lead ?? 3;
    for (let step = 0; step < goat.end; step++) {
      const at = frameAt(song, step, fps);
      while (k < starts.length && starts[k].frame <= at) lead = starts[k++].lead;
      out.push(song.goat ? at - GOAT_READ : at - lead);
    }
    // (a pattern's last row is read a step before the next starts, which sounds two frames later: so the frame before that)
    for (const p of goat.patterns[voice] ?? []) if (p > 0) out.push(frameAt(song, p - 1, fps) - 1);
    return out;
  });
}

/** The song frame a sequence made by songSequence() has got to */
export function songFrame(seqFrame: number, from: number, cycle: { start: number; end: number } | null, seq: Sequence): number {
  if (seq.loopFrom !== null && cycle && seqFrame >= seq.loopFrom) return cycle.start + (seqFrame - seq.loopFrom);
  return from + seqFrame;
}
