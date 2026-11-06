// Plays a song as timed notes on the engine's voices, a frame at a time:
// the same notes a key would play, started early by each instrument's lead
// (the gate timer frames the player waits before a note), so they sound on
// their frame. Runs in the audio worklet, and in the analyzer for tests.

import type { SidKidModule } from '@engine/sidkid.js';

export interface SeqEvent {
  frame: number;
  voice: number;
  /** The note to start (0 = C-0), or -1 to let go */
  note: number;
  instrument: number;
  /** A note's start for the repeat's first frames: on each repeat it plays this early, before the jump back */
  lead?: boolean;
}

export interface Sequence {
  /** In frame order, lets go before starts within a frame. Frames from -preroll. */
  events: SeqEvent[];
  /** Frames from 0 to here, then it stops, or jumps back to loopFrom */
  length: number;
  loopFrom: number | null;
  /** Frames before 0 it starts at, for notes that start on 0 to get their lead (and for a count-in) */
  preroll: number;
  /** Metronome clicks: frames of beats, and of the first beats of bars */
  beats?: number[];
  bars?: number[];
}

/** What a frame's metronome does */
export const NO_CLICK = 0;
export const BEAT = 1;
export const BAR = 2;

export class Sequencer {
  private seq: Sequence | null = null;
  private byFrame = new Map<number, SeqEvent[]>();
  private clicks = new Map<number, number>();
  /** The frame about to play; meaningful while playing */
  frame = 0;

  get playing(): boolean {
    return this.seq !== null;
  }

  /** Starts a sequence, or (keep) swaps in an edited one where playing has got to */
  load(seq: Sequence, keep = false) {
    const playing = this.seq !== null;
    this.seq = seq;
    this.byFrame.clear();
    for (const e of seq.events) {
      const list = this.byFrame.get(e.frame);
      if (list) list.push(e);
      else this.byFrame.set(e.frame, [e]);
    }
    this.clicks.clear();
    for (const f of seq.beats ?? []) this.clicks.set(f, BEAT);
    for (const f of seq.bars ?? []) this.clicks.set(f, BAR);
    if (!keep || !playing) this.frame = -seq.preroll;
    else if (this.frame >= seq.length) this.frame = seq.loopFrom ?? seq.length;
  }

  stop() {
    this.seq = null;
  }

  /** Call before each frame the engine plays. Returns the metronome's click for the frame. */
  tick(sk: SidKidModule): number {
    const seq = this.seq;
    if (!seq) return NO_CLICK;
    const f = this.frame;
    const click = this.clicks.get(f) ?? NO_CLICK;
    for (const e of this.byFrame.get(f) ?? []) play(sk, e);
    // Coming up to the jump back: the repeat's first notes start now
    if (seq.loopFrom !== null && f >= seq.length - seq.preroll) {
      for (const e of this.byFrame.get(f - (seq.length - seq.loopFrom)) ?? []) if (e.lead) play(sk, e);
    }
    this.frame++;
    if (this.frame >= seq.length) {
      if (seq.loopFrom !== null) this.frame = seq.loopFrom;
      else this.seq = null;
    }
    return click;
  }
}

function play(sk: SidKidModule, e: SeqEvent) {
  if (e.note < 0) sk._sk_note_off(e.voice);
  else sk._sk_note_on(e.voice, e.note, e.instrument);
}
