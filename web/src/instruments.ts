// Instruments as Instrument Maker 2 saves them, shared with the song maker:
// where they are stored, bringing older saves up to date, and turning
// shapes into what the player plays (tables and instrument settings).

import type { TableData } from './engine/configure';
import type { Instrument } from './song';
import { layOut, WAVE_PULSE, type Program, type Step } from './tables';
import { wobbleRow } from './vibrato';
import { defaultFilter, defaultPulse, filterProgram, pulseProgram, waveProgram, type Bar, type Note, type PulseShape, type Shape } from './shape';
import START from './startsong.json';

export const STORAGE_KEY = 'sidkid.maker2.v1';

/** How a new instrument's notes start and run into each other */
export const NOTE_START = { bits: [] as Bar[], legato: false, gateFrames: 2, firstWave: 0x09, pulseFromSong: false };

/** The gate timer's bit that leaves out the hard restart (the gate still goes off the frames before a note) */
const NO_HARD_RESTART = 0x80;
/** The gate timer's bit that keeps the gate on into the next note */
const NO_GATE_OFF = 0x40;

export function defaultInstruments(): Shape[] {
  return [
    {
      id: 'lead',
      name: 'Lead',
      ad: 0x09,
      sr: 0xa9,
      bars: [{ wave: WAVE_PULSE, start: 0, end: 10 }],
      notes: [],
      hold: true,
      vibrato: null,
      filter: defaultFilter(),
      // The classic sweep: narrow to wide and back, over and over
      pulse: {
        points: [
          { t: 0, w: 0x300 },
          { t: 25, w: 0xc00 },
          { t: 50, w: 0x300 },
        ],
        loop: 0,
      },
      waveLoop: null,
      fixedNote: null,
      release: null,
      hardRestart: true,
      ...NOTE_START,
    },
    // The starting song's (startsong.json)
    ...(structuredClone(START.instruments) as Shape[]),
  ];
}

/** Brings instruments saved by older versions up to date, in place. `total` is the timeline's length in frames. */
export function migrate(instruments: Shape[], total: number) {
  // Bars from before drawing stopped at 0 could start before the note did
  for (const ins of instruments as Shape[]) {
    ins.bars = ins.bars.filter((b) => b.end === null || b.end > 0).map((b) => ({ ...b, start: Math.max(0, b.start) }));
    // Saved before pulse width had a shape: a square, as they played
    ins.pulse ??= defaultPulse();
    ins.waveLoop ??= null;
    // Notes had ends, which the player never heard (a pitch holds): now just their starts
    ins.notes = (ins.notes ?? []).map(({ end: _end, ...n }: Note & { end?: number }) => n);
    ins.vibrato ??= null;
    ins.fixedNote ??= null;
    ins.release ??= null;
    ins.hardRestart ??= true;
    ins.bits ??= [];
    ins.legato ??= false;
    ins.gateFrames ??= 2;
    ins.firstWave ??= 0x09;
    ins.pulseFromSong ??= false;
    // Filters saved before they came in chunks: a type from the start, as one chunk to the end
    const old = ins.filter as unknown as { passband?: number; resonance: number | PulseShape; cutoff: PulseShape; types?: { start: number; end?: number; passband: number }[] } | null;
    if (!old) ins.filter = defaultFilter();
    else if (old.passband !== undefined && typeof old.resonance === 'number') {
      ins.filter = { cutoff: old.cutoff, resonance: { points: [{ t: 0, w: old.resonance }], loop: null }, types: [{ start: 0, end: total, passband: old.passband }] };
    } else if (old.types?.some((c) => c.end === undefined)) {
      ins.filter.types = old.types.map((c, k) => ({ start: c.start, end: old.types![k + 1]?.start ?? total, passband: c.passband }));
    }
    // Bars that kept going until the note ended: now the waveform holds after its last bar
    const open = ins.bars.some((b) => b.end === null);
    if (ins.hold === undefined) ins.hold = open;
    if (open) {
      const end = Math.max(0, ...ins.bars.map((b) => b.end ?? b.start + 10));
      ins.bars = ins.bars.map((b) => (b.end === null ? { ...b, end: Math.max(end, b.start + 1) } : b));
    }
  }
  giveIds(instruments);
}

/** Gives each instrument an id of its own (songs refer to instruments by it); a copy gets a new one */
export function giveIds(instruments: Shape[]) {
  const seen = new Set<string>();
  for (const s of instruments) {
    if (!s.id || seen.has(s.id)) s.id = Math.random().toString(36).slice(2, 10);
    seen.add(s.id);
  }
}

/**
 * Gives saved instruments that have no id one, and saves it, so it's the
 * same the next time either page loads them (songs refer to instruments by
 * id). Only the ids are added: the rest is left as it was saved.
 */
export function saveIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = JSON.parse(raw ?? 'null') as { instruments?: Shape[] } | null;
    if (!saved?.instruments?.length) return;
    const ids = saved.instruments.map((s) => s.id);
    giveIds(saved.instruments);
    if (saved.instruments.some((s, i) => s.id !== ids[i])) localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Unreadable or blocked storage: nothing to keep
  }
}

/** Adds instruments to the Instrument Maker's list (after its starting ones, if it has none saved yet) */
export function addInstruments(added: Shape[], total: number) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { instruments?: Shape[] } | null;
    const state = saved?.instruments?.length ? saved : { ...saved, instruments: loadInstruments(total), current: 0 };
    state.instruments!.push(...added);
    giveIds(state.instruments!);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: they play in the song all the same, till the page closes
  }
}

/** The instruments Instrument Maker 2 saved, or its starting ones */
export function loadInstruments(total: number): Shape[] {
  saveIds();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.instruments?.length) {
      migrate(saved.instruments, total);
      return saved.instruments;
    }
  } catch {
    // Unreadable or blocked storage: the starting ones
  }
  const fresh = defaultInstruments();
  giveIds(fresh);
  return fresh;
}

/** What one instrument needs in the player's tables, playing on the voices in `voices` (a bit each, for the filter) */
export interface Sound {
  name: string;
  shape: Shape;
  wave: Program;
  pulse: Program | null;
  filter: Program | null;
  /** Speed table rows: vibrato's first, if any, then the glides' */
  speeds: Step[];
  vibrato: boolean;
  /**
   * A variant of another sound (a note picking up where it left off): its
   * programs join the other's, it uses the other's speed rows, and these
   * settings replace the instrument's own.
   */
  base?: Sound;
  overrides?: Partial<Pick<Instrument, 'ad' | 'gateTimer' | 'firstWave' | 'vibratoDelay'>>;
}

/** `ownVoice`: filter the voices it plays on, even where an imported instrument filters others (for trying it out) */
export function sound(s: Shape, voices: number, speedBase = 1, ownVoice = false): Sound {
  // Vibrato reads its speed from a row of the speed table, and glides from the rows after it
  const v = s.vibrato;
  const wobble = v ? wobbleRow(v) : null;
  const { program: wave, speeds } = waveProgram(s, s.name, speedBase + (wobble ? 1 : 0));
  return {
    name: s.name,
    shape: s,
    wave,
    pulse: s.pulseFromSong ? null : pulseProgram(s.bars, s.pulse, s.name),
    filter: s.filter.types.length ? filterProgram(s.filter, s.name, voices, ownVoice) : null,
    speeds: [...(wobble ? [{ left: wobble[0], right: wobble[1] }] : []), ...speeds],
    vibrato: !!v,
  };
}

/**
 * Several sounds laid out into one set of tables, with an instrument for
 * each (in order). Sounds must be made with `speedBase` where their speed
 * rows land: use `sounds()`.
 */
export function soundTables(list: Sound[], extraSpeeds: Step[] = []): { tables: TableData[]; instruments: Instrument[]; rows: number[]; extraSpeedsAt: number } {
  const waves = layOut(list.map((s) => s.wave));
  const pulses = list.filter((s) => s.pulse).map((s) => s.pulse!);
  const filters = list.filter((s) => s.filter).map((s) => s.filter!);
  const pulseLayout = layOut(pulses);
  const filterLayout = layOut(filters);
  const rows = [...list.flatMap((s) => s.speeds), ...extraSpeeds];
  const table = (steps: Step[]) => ({ left: Uint8Array.from(steps, (r) => r.left), right: Uint8Array.from(steps, (r) => r.right) });
  // Where each sound's speed rows start (a variant uses its base's)
  const speedStart = new Map<Sound, number>();
  let speedAt = 1;
  for (const snd of list) {
    speedStart.set(snd, speedAt);
    speedAt += snd.speeds.length;
  }
  const instruments = list.map((snd, i): Instrument => {
    const s = snd.shape;
    const vib = snd.vibrato ? (speedStart.get(snd.base ?? snd) ?? 0) : 0;
    return {
      name: s.name,
      ad: s.ad,
      sr: s.sr,
      tables: [waves.starts[i], snd.pulse ? pulseLayout.starts[pulses.indexOf(snd.pulse)] : 0, snd.filter ? filterLayout.starts[filters.indexOf(snd.filter)] : 0, vib],
      vibratoDelay: s.vibrato ? s.vibrato.delay : 0,
      gateTimer: (s.gateFrames & 0x3f) | (s.hardRestart ? 0 : NO_HARD_RESTART) | (s.legato ? NO_GATE_OFF : 0),
      firstWave: s.firstWave,
      ...snd.overrides,
    };
  });
  const tables = [waves.table, pulseLayout.table, filterLayout.table, table(rows.slice(0, 255))];
  // Rows each table needs (over 255 doesn't fit)
  // (and where the extra speed rows start: after the sounds')
  return { tables, instruments, rows: [waves.length, pulseLayout.length, filterLayout.length, rows.length], extraSpeedsAt: rows.length - extraSpeeds.length + 1 };
}

/** Sounds for instruments on voices (a voice bit mask each), with their speed rows numbered to follow on */
export function sounds(list: { shape: Shape; voices: number }[]): Sound[] {
  let at = 1;
  return list.map(({ shape, voices }) => {
    const snd = sound(shape, voices, at);
    at += snd.speeds.length;
    return snd;
  });
}
