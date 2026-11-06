// SIDKid's own songs: any number of tracks, each a run of clips of notes for
// one instrument, played on a voice of the chip. Tracks sharing a voice take
// turns: the newest note takes the voice, and when it ends, a note still
// held on another track comes back. This file turns a song into the timed
// notes the player plays (a Sequence).

import type { SeqEvent, Sequence } from './engine/sequencer';
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

export interface SongDoc {
  name: string;
  /** Frames a step lasts: the tempo */
  stepFrames: number;
  stepsPerBeat: number;
  beatsPerBar: number;
  tracks: Track[];
  /** The stretch Play repeats while cycling, in steps */
  cycle: { start: number; end: number };
  cycling: boolean;
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
export function voiceSegments(song: SongDoc, voice: number): Segment[] {
  const held: Held[] = [];
  let order = 0;
  song.tracks.forEach((t, ti) => {
    if (t.voice !== voice || t.muted) return;
    for (const c of t.clips) {
      for (const n of clipNotes(c)) {
        held.push({ start: n.start * song.stepFrames, end: (n.start + n.length) * song.stepFrames, note: n.note, track: ti, order: order++ });
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
    else if (top) out.push({ start: t, end: times[i + 1], note: top.note, track: top.track });
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

/**
 * The timed notes for playing a song from `from` (a frame): through to its
 * end, or with a cycle (frames), on to the cycle's end and then round it.
 * Frame 0 of the sequence is `from`; songFrame() maps back.
 */
export function songSequence(song: SongDoc, sounds: SongSound[], trackSound: number[], from: number, cycle: { start: number; end: number } | null): Sequence {
  const end = cycle ? cycle.end : songEnd(song) * song.stepFrames;
  // The first pass, from where playing starts; then the cycle, round and round
  const firstLength = Math.max(0, end - from);
  const loopFrom = cycle ? firstLength : null;
  const length = cycle ? firstLength + (cycle.end - cycle.start) : firstLength + 1;
  const preroll = Math.max(1, ...sounds.map((s) => leadOf(s.shape)));
  const events: SeqEvent[] = [];
  for (let voice = 0; voice < VOICES; voice++) {
    const all = voiceSegments(song, voice).filter((s) => trackSound[s.track] > 0);
    const clip = (a: number, b: number, shift: number) =>
      all.filter((s) => s.end > a && s.start < b).map((s) => ({ ...s, start: Math.max(a, s.start) + shift, end: Math.min(b, s.end) + shift }));
    const first = clip(from, end, -from);
    const round = cycle ? clip(cycle.start, cycle.end, firstLength - cycle.start) : [];
    const segs = [...first, ...round];
    const sound = (s: Segment) => sounds[trackSound[s.track] - 1].shape;
    // The pass coming round again, for the notes ending the cycle
    const again = round.length ? { ...round[0], start: round[0].start + (cycle!.end - cycle!.start), end: round[0].end } : null;
    segs.forEach((s, i) => {
      const shape = sound(s);
      const on = s.start - leadOf(shape);
      events.push({ frame: on, voice, note: s.note, instrument: trackSound[s.track], ...(loopFrom !== null && s.start >= loopFrom && on < loopFrom ? { lead: true } : {}) });
      // Let go at the end, unless the next note on the voice starts first
      // (starting a note lets go of the last), or the instrument lets go itself
      const next = segs[i + 1] ?? (cycle ? again : null);
      if (shape.release !== null) return;
      if (next && next.start - leadOf(sound(next)) <= s.end) return;
      events.push({ frame: Math.min(s.end, length - 1), voice, note: -1, instrument: 0 });
    });
  }
  events.sort((a, b) => a.frame - b.frame || (a.note < 0 ? 0 : 1) - (b.note < 0 ? 0 : 1));
  return { events, length, loopFrom, preroll };
}

/** The song frame a sequence made by songSequence() has got to */
export function songFrame(seqFrame: number, from: number, cycle: { start: number; end: number } | null, seq: Sequence): number {
  if (seq.loopFrom !== null && cycle && seqFrame >= seq.loopFrom) return cycle.start + (seqFrame - seq.loopFrom);
  return from + seqFrame;
}
