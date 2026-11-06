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
}

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
  goat?: { patterns: number[][]; end: number };
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
      out.push({ start: c.start + at + n.start, length, note: n.note });
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
}

interface Held {
  start: number;
  end: number;
  note: number;
  track: number;
  order: number;
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
        held.push({ start: frameAt(song, n.start, fps), end: frameAt(song, n.start + n.length, fps), note: n.note, track: ti, order: order++ });
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
    else if (top) out.push({ start: t, end: times[i + 1], note: top.note, track: top.track, from: t - top.start });
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
  const preroll = Math.max(1, ...sounds.map((s) => Math.max(leadOf(s.shape), resumeLeadOf(s.shape))), metronome.countIn ? Math.ceil(bar) + 1 : 0);
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
    const lead = (s: (typeof segs)[number]) => (s.resumed ? resumeLeadOf(sound(s)) : leadOf(sound(s)));
    // The pass coming round again, for the notes ending the cycle
    const again = round.length ? { ...round[0], start: round[0].start + (cycle!.end - cycle!.start), end: round[0].end } : null;
    segs.forEach((s, i) => {
      const shape = sound(s);
      const on = s.start - lead(s);
      events.push({ frame: on, voice, note: s.note, instrument: s.instrument, ...(loopFrom !== null && s.start >= loopFrom && on < loopFrom ? { lead: true } : {}) });
      // Let go at the end, unless the next note on the voice starts first
      // (starting a note lets go of the last), or the instrument lets go itself
      const next = segs[i + 1] ?? (cycle ? again : null);
      if (shape.release !== null) return;
      // (it lets go the lead before its end, as the player looks ahead to a key-off row as to a note)
      const off = s.end - lead(s);
      if (next && next.start - lead(next) <= off) return;
      events.push({ frame: Math.min(off, length - 1), voice, note: LET_GO, instrument: 0 });
    });
  }
  if (song.goat) {
    const skips = goatPulseSkips(song, sounds, trackSound, fps);
    skips.forEach((frames, voice) => {
      const add = (a: number, b: number, shift: number) => {
        for (const f of frames) if (f >= a && f < b) events.push({ frame: f + shift, voice, note: SKIP_PULSE, instrument: 0 });
      };
      add(from, end, -from);
      if (cycle) add(cycle.start, cycle.end, firstLength - cycle.start);
    });
  }
  events.sort((a, b) => a.frame - b.frame || (a.note < 0 ? 0 : 1) - (b.note < 0 ? 0 : 1));
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
      out.push(at - lead);
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
