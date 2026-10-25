// The instrument maker: an instrument's volume envelope and its wave, pulse
// and filter programs, what they do frame by frame, and a keyboard to play
// it on. Programs are made along the way and can be shared.

import './style.css';
import './instrumentmaker.css';
import { Analyzer, type Trace } from './engine/analyzer';
import type { TableData } from './engine/configure';
import { loadModel, Player, saveModel } from './engine/player';
import { adsrEditor, type Env } from './adsr';
import { envelope } from './envelope';
import { filterCurve, modeIcon } from './filtercurve';
import { waveIcon, waveTone } from './waveicon';
import { DEFAULT_SETTINGS, type Status } from './engine/protocol';
import { noteName, parseSong, type Instrument } from './song';
import {
  defaultStep,
  describeStep,
  FILTER,
  FILTER_BAND,
  FILTER_HIGH,
  FILTER_LOW,
  filterAction,
  filterStep,
  KIND_NAMES,
  layOut,
  locate,
  passbandName,
  percent,
  pitchOf,
  pitchRight,
  PRESETS,
  programFromPreset,
  PULSE,
  pulseAction,
  pulseStep,
  splitTable,
  TABLE_LENGTH,
  WAVE,
  WAVE_GATE,
  WAVE_NOISE,
  WAVE_PULSE,
  WAVE_RING,
  WAVE_SAW,
  WAVE_SYNC,
  WAVE_TEST,
  WAVE_TRI,
  waveAction,
  waveLeft,
  waveName,
  type Layout,
  type Pitch,
  type Program,
  type Step,
  type Table,
  type Target,
  type WaveAction,
} from './tables';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FPS = 50;
const KINDS = [WAVE, PULSE, FILTER];
const STORAGE_KEY = 'sidkid.instruments.v1';
const TEST_INSTRUMENT = 1;

// --- State ----------------------------------------------------------------

/** An instrument: its envelope and settings, and where its programs start. */
interface InstrumentDef {
  /** Its number in the song (1-63) */
  num: number;
  name: string;
  ad: number;
  sr: number;
  vibratoDelay: number;
  gateTimer: number;
  firstWave: number;
  /** Speed table position (that table isn't edited here). */
  speed: number;
  /** Where its wave, pulse and filter programs start. */
  targets: (Target | null)[];
}

interface State {
  programs: Program[][];
  /** The speed table isn't edited here, but wave programs' commands use it. */
  speed: Table;
  instruments: InstrumentDef[];
  source: string;
  /** The program tab being edited */
  kind: number;
  /** The instrument being edited, an index into instruments */
  current: number;
}

const test = {
  octave: 3,
  note: 48,
  frames: [50, 200, 200],
};

function insName(i: InstrumentDef) {
  return i.name || `Instrument ${i.num}`;
}

let state: State = initialState();

function newInstrument(num: number, name: string, ad: number, sr: number, targets: (Program | null)[]): InstrumentDef {
  return {
    num,
    name,
    ad,
    sr,
    vibratoDelay: 0,
    gateTimer: 2,
    firstWave: 0x09,
    speed: 0,
    targets: targets.map((p) => (p ? { program: p, step: 0 } : null)),
  };
}

function initialState(): State {
  const pick = (kind: number, name: string) => programFromPreset(PRESETS[kind].find((p) => p.name === name)!);
  const [pulseWave, chord, saw] = [pick(WAVE, 'Pulse'), pick(WAVE, 'Major arpeggio'), pick(WAVE, 'Saw')];
  const [sweep, square] = [pick(PULSE, 'Slow sweep'), pick(PULSE, 'Square')];
  const low = pick(FILTER, 'Low pass');
  return {
    programs: [
      [pulseWave, chord, saw],
      [sweep, square],
      [low],
    ],
    speed: { left: new Uint8Array(0), right: new Uint8Array(0) },
    instruments: [
      newInstrument(1, 'Sweep lead', 0x09, 0xc8, [pulseWave, sweep, null]),
      newInstrument(2, 'Chord', 0x05, 0xa8, [chord, square, null]),
      newInstrument(3, 'Bass', 0x08, 0x88, [saw, null, low]),
    ],
    source: '',
    kind: WAVE,
    current: 0,
  };
}

const programs = () => state.programs[state.kind];
const usersOf = (p: Program, kind = state.kind) => state.instruments.filter((i) => i.targets[kind]?.program === p);
const instrument = (): InstrumentDef | undefined => state.instruments[state.current];
const target = (kind = state.kind): Target | null => instrument()?.targets[kind] ?? null;
const current = (): Program | undefined => target()?.program;

// --- Saving, undo ---------------------------------------------------------

interface Saved {
  programs: { name: string; steps: [number, number][]; next: [number, number] | null }[][];
  speed: [number[], number[]];
  instruments: (Omit<InstrumentDef, 'targets'> & { targets: ([number, number] | null)[] })[];
  source: string;
  kind: number;
  current: number;
  frames?: number[];
}

function save(s: State): Saved {
  return {
    programs: s.programs.map((list) =>
      list.map((p) => ({
        name: p.name,
        steps: p.steps.map((st): [number, number] => [st.left, st.right]),
        next: p.next && list.includes(p.next.program) ? [list.indexOf(p.next.program), p.next.step] : null,
      })),
    ),
    speed: [Array.from(s.speed.left), Array.from(s.speed.right)],
    instruments: s.instruments.map((i) => ({
      ...i,
      targets: i.targets.map((t, k): [number, number] | null => (t && s.programs[k].includes(t.program) ? [s.programs[k].indexOf(t.program), t.step] : null)),
    })),
    source: s.source,
    kind: s.kind,
    current: s.current,
    frames: [...test.frames],
  };
}

function restore(d: Saved): State {
  const lists = d.programs.map((list) => list.map((p): Program => ({ name: p.name, steps: p.steps.map(([left, right]) => ({ left, right })), next: null })));
  d.programs.forEach((list, k) =>
    list.forEach((p, i) => {
      if (p.next && lists[k][p.next[0]]) lists[k][i].next = { program: lists[k][p.next[0]], step: p.next[1] };
    }),
  );
  const instruments = (d.instruments ?? []).map((i) => ({
    ...i,
    targets: i.targets.map((t, k) => (t && lists[k][t[0]] ? { program: lists[k][t[0]], step: t[1] } : null)),
  }));
  return {
    programs: lists,
    speed: { left: Uint8Array.from(d.speed[0]), right: Uint8Array.from(d.speed[1]) },
    instruments,
    source: d.source,
    kind: d.kind,
    current: Math.max(0, Math.min(instruments.length - 1, d.current ?? 0)),
  };
}

const undoStack: string[] = [];
const redoStack: string[] = [];
let lastBefore = 0;

/** Call before changing state. Rapid changes (dragging a slider) undo as one. */
function before() {
  const now = performance.now();
  if (now - lastBefore > 600) {
    undoStack.push(JSON.stringify(save(state)));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  lastBefore = now;
}

function undo(redo = false) {
  const from = redo ? redoStack : undoStack;
  const to = redo ? undoStack : redoStack;
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(JSON.stringify(save(state)));
  state = restore(JSON.parse(snapshot));
  lastBefore = 0;
  renderAll();
  schedulePreview();
  persist();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save(state)));
  } catch {
    // Storage can be unavailable (private windows); the page works without it
  }
}

function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const d: Saved = JSON.parse(saved);
      state = restore(d);
      if (d.frames?.length === 3) test.frames = d.frames;
    }
  } catch {
    state = initialState();
  }
}

// --- Changing programs ----------------------------------------------------

/** Moves references after a program's steps change; map gives each old step's new index, or -1 if it went. */
function remap(kind: number, program: Program, map: (step: number) => number) {
  for (const p of state.programs[kind]) {
    if (p.next?.program !== program) continue;
    const step = map(p.next.step);
    p.next = step >= 0 && step <= program.steps.length ? { program, step } : null;
  }
  for (const ins of state.instruments) {
    const t = ins.targets[kind];
    if (t?.program !== program) continue;
    const step = map(t.step);
    ins.targets[kind] = { program, step: Math.max(0, Math.min(program.steps.length - 1, step < 0 ? t.step : step)) };
  }
}

function insertSteps(at: number, steps: Step[]) {
  const p = current()!;
  before();
  p.steps.splice(at, 0, ...steps);
  remap(state.kind, p, (i) => (i >= at ? i + steps.length : i));
  changed(true);
}

function insertStep(at: number, step: Step) {
  insertSteps(at, [step]);
}

function removeSteps(at: number, count: number) {
  const p = current()!;
  before();
  p.steps.splice(at, count);
  // References to removed steps move on to the one after them
  remap(state.kind, p, (i) => (i >= at + count ? i - count : i >= at ? at : i));
  changed(true);
}

/** Swaps the shown step u with the one before (by -1) or after (by 1), with all their rows. */
function moveUnit(u: number, by: -1 | 1) {
  const p = current()!;
  const units = unitsOf(p);
  const other = u + by;
  if (other < 0 || other >= units.length) return;
  before();
  const order = units.flatMap((_, i) => units[i === u ? other : i === other ? u : i]);
  const where = new Map(order.map((old, i) => [old, i]));
  p.steps = order.map((old) => p.steps[old]);
  remap(state.kind, p, (i) => where.get(i) ?? i);
  changed(true);
}

/**
 * The steps as shown: rows, except that a filter's set-up row and the cutoff
 * row after it run in the same frame, so they show as one step (unless
 * something jumps straight to the cutoff row).
 */
function unitsOf(p: Program, kind = state.kind): number[][] {
  const out: number[][] = [];
  const targeted = (row: number) => (p.next?.program === p && p.next.step === row) || state.instruments.some((i) => i.targets[kind]?.program === p && i.targets[kind]!.step === row);
  for (let i = 0; i < p.steps.length; i++) {
    const pair = kind === FILTER && i + 1 < p.steps.length && filterAction(p.steps[i]).type === 'setup' && filterAction(p.steps[i + 1]).type === 'cutoff' && !targeted(i + 1);
    out.push(pair ? [i, ++i] : [i]);
  }
  return out;
}

/** The shown step a row of the edited program belongs to. */
function unitOf(row: number): number {
  const p = current();
  if (!p) return row;
  const u = unitsOf(p).findIndex((rows) => rows.includes(row));
  return u < 0 ? row : u;
}

/** The first row of the shown step a row belongs to. */
function unitStart(row: number): number {
  const p = current();
  if (!p) return row;
  return unitsOf(p).find((rows) => rows.includes(row))?.[0] ?? row;
}

/** Points the instrument being edited at a program (or none) for the tab's kind. */
function useProgram(p: Program | null) {
  const ins = instrument();
  if (!ins) return;
  before();
  ins.targets[state.kind] = p ? { program: p, step: 0 } : null;
  changed(true);
}

/** Adds a new program to the song and uses it for this instrument. */
function addProgram(p: Program) {
  before();
  programs().push(p);
  const ins = instrument();
  if (ins) ins.targets[state.kind] = { program: p, step: 0 };
  changed(true);
}

function deleteProgram() {
  const p = current();
  if (!p) return;
  const others = usersOf(p).filter((i) => i !== instrument());
  if (others.length && !confirm(`“${p.name}” is also used by ${others.map(insName).join(', ')}. Delete it from them too?`)) return;
  before();
  const list = programs();
  list.splice(list.indexOf(p), 1);
  for (const o of list) if (o.next?.program === p) o.next = null;
  for (const ins of usersOf(p)) ins.targets[state.kind] = null;
  changed(true);
}

/** Gives this instrument its own copy of the program, leaving other users with the original. */
function copyProgram() {
  const p = current();
  const t = target();
  if (!p || !t) return;
  const copy: Program = { name: `${p.name} copy`, steps: p.steps.map((s) => ({ ...s })), next: null };
  if (p.next) copy.next = p.next.program === p ? { program: copy, step: p.next.step } : { ...p.next };
  before();
  programs().push(copy);
  instrument()!.targets[state.kind] = { program: copy, step: t.step };
  changed(true);
}

// --- Changing instruments -------------------------------------------------

function freeNumber(): number {
  for (let n = 1; n < 64; n++) if (!state.instruments.some((i) => i.num === n)) return n;
  return 0;
}

function addInstrument() {
  const num = freeNumber();
  if (!num) {
    toast('A song can have at most 63 instruments');
    return;
  }
  before();
  const name = `Instrument ${num}`;
  // A new instrument starts with its own plain wave program
  const wave = { ...programFromPreset(PRESETS[WAVE].find((p) => p.name === 'Pulse')!), name };
  state.programs[WAVE].push(wave);
  const square = state.programs[PULSE].find((p) => p.name === 'Square') ?? null;
  state.instruments.push(newInstrument(num, name, 0x09, 0xc8, [wave, square, null]));
  state.current = state.instruments.length - 1;
  state.kind = WAVE;
  changed(true);
  $('rename-instrument').click();
}

function duplicateInstrument() {
  const ins = instrument();
  const num = freeNumber();
  if (!ins || !num) return;
  before();
  state.instruments.push({ ...ins, num, name: `${insName(ins)} copy`, targets: ins.targets.map((t) => (t ? { ...t } : null)) });
  state.current = state.instruments.length - 1;
  changed(true);
}

function deleteInstrument() {
  const ins = instrument();
  if (!ins || !confirm(`Delete “${insName(ins)}”? Its programs stay, for other instruments to use.`)) return;
  before();
  state.instruments.splice(state.current, 1);
  state.current = Math.max(0, Math.min(state.current, state.instruments.length - 1));
  changed(true);
}

/** After any change: redraw, save, and give the player the new tables. */
function changed(structure: boolean) {
  if (structure) renderAll();
  else {
    renderPrograms();
    renderNext();
  }
  schedulePreview();
  persist();
}

// --- Laying out for the player --------------------------------------------

interface Audition {
  lists: Program[][];
  layouts: Layout[];
  tables: TableData[];
  instrument: Instrument;
}

/** The song's tables as the player sees them, and the instrument being edited. */
function audition(): Audition {
  const lists = state.programs;
  const layouts = lists.map(layOut);
  const ins = instrument();
  const at = (k: number) => {
    const t = ins?.targets[k];
    const i = t ? lists[k].indexOf(t.program) : -1;
    return t && i >= 0 && t.step < t.program.steps.length ? layouts[k].starts[i] + t.step : 0;
  };
  return {
    lists,
    layouts,
    tables: [...layouts.map((l) => l.table), state.speed],
    instrument: ins
      ? { ...ins, tables: [at(WAVE), at(PULSE), at(FILTER), ins.speed] }
      : { name: '', ad: 0, sr: 0, tables: [0, 0, 0, 0], vibratoDelay: 0, gateTimer: 2, firstWave: 0 },
  };
}

// --- Rendering: tabs and program list -------------------------------------

function renderAll() {
  for (const b of $('span').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.frames) === test.frames[state.kind]);
  renderKinds();
  renderPrograms();
  renderEditor();
  renderInstrument();
}

function renderKinds() {
  for (const b of $('kinds').querySelectorAll<HTMLButtonElement>('button')) {
    const k = Number(b.dataset.kind);
    b.classList.toggle('on', k === state.kind);
    b.setAttribute('aria-selected', String(k === state.kind));
    b.querySelector('.count')!.textContent = String(state.programs[k].length);
  }
  const select = $<HTMLSelectElement>('new-program');
  select.replaceChildren(new Option('+ New program…', ''), new Option('Empty program', 'empty'));
  const group = document.createElement('optgroup');
  group.label = 'Start from';
  PRESETS[state.kind].forEach((p, i) => {
    const o = new Option(p.name, String(i));
    o.title = p.hint;
    group.append(o);
  });
  select.append(group);
}

/** "None": the instrument goes without a program of this kind. */
function noneItem(): HTMLLIElement {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.className = 'program-item none';
  button.classList.toggle('on', !current());
  const name = document.createElement('span');
  name.className = 'program-name';
  name.textContent = `No ${KIND_NAMES[state.kind].toLowerCase()} program`;
  const meta = document.createElement('span');
  meta.className = 'program-meta';
  meta.textContent = state.kind === WAVE ? 'just the first waveform' : state.kind === PULSE ? 'the width stays put' : 'leaves the filter alone';
  button.append(name, meta);
  button.addEventListener('click', () => {
    if (current()) {
      useProgram(null);
      blip();
    }
  });
  li.append(button);
  return li;
}

function renderPrograms() {
  const list = $('program-list');
  list.replaceChildren(
    noneItem(),
    ...programs().map((p) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'program-item';
      button.classList.toggle('on', p === current());
      button.title = `Use “${p.name}” in ${instrument() ? insName(instrument()!) : 'the instrument'}`;
      const name = document.createElement('span');
      name.className = 'program-name';
      name.textContent = p.name || 'Untitled';
      const meta = document.createElement('span');
      meta.className = 'program-meta';
      const users = usersOf(p);
      meta.textContent = [`${p.steps.length} step${p.steps.length === 1 ? '' : 's'}`, p.next ? (p.next.program === p ? 'loops' : 'jumps') : '', users.length ? `in ${users.map(insName).join(', ')}` : 'unused']
        .filter(Boolean)
        .join(' · ');
      button.append(name, meta);
      button.addEventListener('click', () => {
        if (p !== current()) {
          useProgram(p);
          blip();
        }
      });
      li.append(button);
      return li;
    }),
  );
  const layout = layOut(programs());
  const used = $('rows-used');
  used.textContent = `${layout.length} of ${TABLE_LENGTH} rows`;
  used.classList.toggle('over', layout.length > TABLE_LENGTH);
  used.title = layout.length > TABLE_LENGTH ? 'Too many steps: GoatTracker tables hold 255 rows, counting one end row per program' : 'Table rows used, counting one end row per program';
  $('source').textContent = state.source;
}

// --- Rendering: the program editor ----------------------------------------

function renderEditor() {
  const p = current();
  const ins = instrument();
  $('program-card').hidden = !p;
  $('steps-card').hidden = !p;
  const empty = $('no-program');
  empty.hidden = !!p;
  if (!p) {
    const kind = KIND_NAMES[state.kind].toLowerCase();
    empty.textContent = ins
      ? `${insName(ins)} has no ${kind} program${state.kind === PULSE ? ', so its pulse width stays put' : state.kind === FILTER ? ', so it leaves the filter alone' : ''}. Pick one on the left to use it, or make a new one.`
      : 'Make an instrument below to start.';
    return;
  }
  const name = $<HTMLInputElement>('program-name');
  if (document.activeElement !== name) name.value = p.name;
  const t = target()!;
  const others = usersOf(p).filter((i) => i !== ins);
  const uses = $('uses');
  const parts: string[] = [];
  if (t.step) parts.push(`${insName(ins!)} starts at step ${unitOf(t.step) + 1}.`);
  if (others.length) parts.push(`Also used by ${others.map(insName).join(', ')}: changes here change ${others.length === 1 ? 'it' : 'them'} too. Duplicate it to change it just for ${insName(ins!)}.`);
  uses.hidden = !parts.length;
  uses.textContent = parts.join(' ');
  renderNote();
  renderSteps();
  renderNext();
}

/** Explains how this tab's program depends on the rest of the instrument. */
function renderNote() {
  const note = $('kind-note');
  const ins = instrument();
  let text = '';
  if (state.kind === PULSE && ins) {
    const wave = ins.targets[WAVE]?.program;
    const usesPulse = wave
      ? wave.steps.some((s) => {
          const a = waveAction(s);
          return a.type === 'wave' && a.wave & WAVE_PULSE;
        })
      : (ins.firstWave & WAVE_PULSE) !== 0;
    if (!usesPulse) text = `${insName(ins)}’s wave program never picks the Pulse waveform, so the pulse width has no effect on how it sounds.`;
  } else if (state.kind === FILTER) {
    text = 'The SID has one filter, shared by all three voices. While this instrument plays, its filter program takes over that filter for every voice routed through it.';
  }
  note.textContent = text;
  note.hidden = !text;
}

function renderNext() {
  const p = current();
  if (!p) return;
  const select = $<HTMLSelectElement>('next');
  select.replaceChildren(new Option('Stop, keeping the sound as it is', 'stop'));
  unitsOf(p).forEach(([i], u) => select.append(new Option(u === 0 ? 'Loop back to the start' : `Loop back to step ${u + 1}`, `loop:${i}`)));
  if (p.next?.program === p && p.next.step === p.steps.length) {
    select.append(new Option('Jump onto its own end row (a GoatTracker quirk)', `loop:${p.steps.length}`));
  }
  if (p.next && p.next.program !== p) {
    const end = p.next.step === p.next.program.steps.length;
    select.append(new Option(`Go on to “${p.next.program.name}”, ${end ? 'its end row' : `step ${p.next.step + 1}`}`, 'other'));
  }
  select.value = !p.next ? 'stop' : p.next.program === p ? `loop:${p.next.step}` : 'other';
}

// --- Rendering: the instrument --------------------------------------------

function renderInstrument() {
  const ins = instrument();
  const select = $<HTMLSelectElement>('instrument');
  select.replaceChildren(...state.instruments.map((i, n) => new Option(insName(i), String(n))));
  select.value = String(state.current);
  for (const id of ['rename-instrument', 'duplicate-instrument', 'delete-instrument']) ($(id) as HTMLButtonElement).disabled = !ins;
  drawAdsr();
}

let hoverStep = -1;
let liveStep = -1;

function renderSteps() {
  const p = current()!;
  const list = $('steps');
  list.replaceChildren(...unitsOf(p).map((rows, u) => stepRow(p, rows, u)));
  if (!p.steps.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No steps yet: add one below.';
    list.append(empty);
  }
}

function stepHue(i: number) {
  return (i * 67 + 250) % 360;
}

const STEP_TYPES: Record<number, [string, string][]> = {
  [WAVE]: [
    ['wave', 'Set waveform'],
    ['keep', 'Change pitch'],
    ['wait', 'Wait'],
    ['command', 'Run command'],
  ],
  [PULSE]: [
    ['width', 'Set width'],
    ['sweep', 'Sweep width'],
    ['hold', 'Hold'],
  ],
  [FILTER]: [
    ['setup', 'Set filter'],
    ['cutoff', 'Set cutoff'],
    ['sweep', 'Sweep cutoff'],
  ],
};

function stepType(kind: number, s: Step): string {
  if (kind === WAVE) return waveAction(s).type;
  if (kind === PULSE) return pulseAction(s).type;
  return filterAction(s).type;
}

/** A step of a new type, keeping what it can (the pitch, for wave steps). */
function convertStep(kind: number, s: Step, type: string): Step {
  if (kind === WAVE) {
    const actions: Record<string, WaveAction> = { wave: { type: 'wave', wave: 0x41 }, keep: { type: 'keep' }, wait: { type: 'wait', frames: 2 }, command: { type: 'command', command: 4 } };
    const keepsPitch = waveAction(s).type !== 'command';
    return { left: waveLeft(actions[type]), right: type === 'command' ? 0 : keepsPitch ? s.right : 0 };
  }
  if (kind === PULSE) {
    if (type === 'width') return pulseStep({ type: 'width', width: 0x800 });
    if (type === 'sweep') return pulseStep({ type: 'sweep', frames: 32, speed: 32 });
    return pulseStep({ type: 'hold' });
  }
  if (type === 'setup') return filterStep({ type: 'setup', passband: FILTER_LOW, resonance: 8, voices: 1 });
  if (type === 'cutoff') return filterStep({ type: 'cutoff', cutoff: 0x80 });
  return filterStep({ type: 'sweep', frames: 32, speed: 2 });
}

function stepRow(p: Program, rows: number[], u: number): HTMLLIElement {
  const kind = state.kind;
  const i = rows[0];
  const s = p.steps[i];
  const li = document.createElement('li');
  li.className = 'step';
  li.dataset.step = String(i);
  li.style.setProperty('--hue', String(stepHue(u)));
  li.classList.toggle('live', i === liveStep);

  const lead = document.createElement('span');
  lead.className = 'step-lead';
  const num = document.createElement('span');
  num.className = 'step-num';
  num.textContent = String(u + 1);
  lead.append(num);
  const loopsHere = p.next?.program === p && p.next.step === i;
  if (loopsHere) {
    num.classList.add('loop-target');
    num.title = 'The program loops back to here';
  }

  const type = document.createElement('select');
  type.className = 'step-type';
  type.setAttribute('aria-label', `Step ${u + 1} type`);
  for (const [value, label] of STEP_TYPES[kind]) type.append(new Option(label, value));
  type.value = stepType(kind, s);
  type.addEventListener('change', () => {
    before();
    const next = convertStep(kind, s, type.value);
    p.steps[i] = next;
    // A filter set-up shows with its cutoff: add one, or drop it for other types
    if (kind === FILTER && rows.length === 2 && type.value !== 'setup') {
      p.steps.splice(i + 1, 1);
      remap(kind, p, (r) => (r > i + 1 ? r - 1 : r > i ? i : r));
    } else if (kind === FILTER && rows.length === 1 && type.value === 'setup') {
      p.steps.splice(i + 1, 0, filterStep({ type: 'cutoff', cutoff: 0x80 }));
      remap(kind, p, (r) => (r > i ? r + 1 : r));
    }
    changed(true);
  });

  const fields = document.createElement('div');
  fields.className = 'step-fields';

  const text = document.createElement('span');
  text.className = 'step-text';
  const raw = document.createElement('code');
  raw.className = 'step-raw';
  raw.title = 'The GoatTracker table rows: left and right bytes';
  const refresh = () => {
    text.textContent = describeUnit(kind, p, rows) + warning(kind, p, i);
    raw.textContent = rows.map((r) => `${hex(p.steps[r].left)} ${hex(p.steps[r].right)}`).join(' · ');
  };
  // Field edits change the step in place, so a slider being dragged stays put
  const update = (next: Step, row = i) => {
    before();
    p.steps[row] = next;
    refresh();
    changed(false);
  };
  if (kind === FILTER) filterFields(p, rows, fields, update);
  else stepFields(kind, s, fields, update, () => p.steps[i]);
  refresh();

  const n = rows.length;
  const units = unitsOf(p);
  const tools = document.createElement('div');
  tools.className = 'step-tools';
  tools.append(
    toolButton('↑', 'Move up', () => moveUnit(u, -1), u === 0),
    toolButton('↓', 'Move down', () => moveUnit(u, 1), u === units.length - 1),
    toolButton('⧉', 'Duplicate step', () => insertSteps(i + n, rows.map((r) => ({ ...p.steps[r] })))),
    toolButton('×', 'Delete step', () => removeSteps(i, n)),
  );

  const typeField = document.createElement('label');
  typeField.className = 'step-type-field';
  const typeLabel = document.createElement('span');
  typeLabel.textContent = 'Step type';
  typeField.append(typeLabel, type);

  const main = document.createElement('div');
  main.className = 'step-main';
  main.append(typeField, fields);
  const info = document.createElement('div');
  info.className = 'step-info';
  info.append(text, raw);
  li.append(lead, main, info, tools);
  li.addEventListener('pointerenter', () => setHoverStep(i));
  li.addEventListener('pointerleave', () => setHoverStep(-1));
  return li;
}

/** Describes a shown step, which may be a filter set-up with its cutoff. */
function describeUnit(kind: number, p: Program, rows: number[]): string {
  if (rows.length === 2) {
    const setup = filterAction(p.steps[rows[0]]) as { type: 'setup'; passband: number; resonance: number; voices: number };
    const cutoff = filterAction(p.steps[rows[1]]) as { type: 'cutoff'; cutoff: number };
    return `${passbandName(setup.passband)}, cutoff ${cutoff.cutoff}, resonance ${setup.resonance}${routingText(setup.voices)}`;
  }
  return describeStep(kind, p.steps[rows[0]]);
}

function routingText(voices: number): string {
  if (voices === 1) return '';
  if (!voices) return ' · no voice filtered';
  return ` · filters voice${voices & (voices - 1) ? 's' : ''} ${[1, 2, 3].filter((v) => voices & (1 << (v - 1))).join(', ')}`;
}

function warning(kind: number, p: Program, i: number): string {
  if (kind === WAVE && i === 0) {
    const t = waveAction(p.steps[0]).type;
    if (t === 'keep' || t === 'wait') return ' — as a first step this can make notes go missing; start with Set waveform';
  }
  if (kind === FILTER && filterAction(p.steps[i]).type !== 'setup' && !setupBefore(p, i)) {
    return ' — no filter set-up before this step: on its own it only moves the cutoff of whatever filter setting is already playing (none at the start of a song, so you won’t hear it)';
  }
  return '';
}

function toolButton(label: string, title: string, action: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = disabled;
  b.addEventListener('click', action);
  return b;
}

function hex(n: number) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

// --- Step fields ----------------------------------------------------------

// Pattern commands a wave table can run: not 0 (nothing), 8 (wave program)
// or E (swing tempo)
const WAVE_COMMANDS: [number, string][] = [
  [1, 'Slide up'],
  [2, 'Slide down'],
  [3, 'Slide to note'],
  [4, 'Vibrato'],
  [5, 'Set attack/decay'],
  [6, 'Set sustain/release'],
  [7, 'Set waveform'],
  [9, 'Pulse program'],
  [10, 'Filter program'],
  [11, 'Filter routing'],
  [12, 'Filter cutoff'],
  [13, 'Volume'],
  [15, 'Tempo'],
];

type Update = (s: Step) => void;

function stepFields(kind: number, s: Step, box: HTMLElement, update: Update, get: () => Step) {
  if (kind === WAVE) waveFields(s, box, update, get);
  else pulseFields(s, box, update, get);
}

function waveFields(s: Step, box: HTMLElement, update: Update, get: () => Step) {
  const a = waveAction(s);
  if (a.type === 'wave') {
    const setWave = (wave: number) => {
      update({ ...get(), left: waveLeft({ type: 'wave', wave }) });
      renderSteps();
      blip();
    };
    const control = () => {
      const cur = waveAction(get());
      return cur.type === 'wave' ? cur.wave & 0x0f : WAVE_GATE;
    };
    box.append(wavePicker(a.wave, (osc) => setWave(osc | control())));

    const gate = segmented(
      [
        [WAVE_GATE, 'Sound on', 'The note sounds: attack, decay, then sustain'],
        [0, 'Release', 'Lets go of the note here: it fades out with the release time, even while the key is held'],
      ],
      a.wave & WAVE_GATE,
      (bit) => setWave((a.wave & ~WAVE_GATE) | bit),
    );
    box.append(gate);

    // Sync, ring modulation and the test bit are for special effects
    const extras = WAVE_SYNC | WAVE_RING | WAVE_TEST;
    const more = toggles(
      [
        [WAVE_SYNC, 'Sync', 'Syncs to another voice (voice 3 for voice 1): needs that voice playing', ''],
        [WAVE_RING, 'Ring', 'Ring modulation by another voice (voice 3 for voice 1): needs that voice playing, best with triangle', ''],
        [WAVE_TEST, 'Test', 'Test bit: silences and resets the oscillator', ''],
      ],
      a.wave,
      (bits) => (setWave((a.wave & ~extras) | bits), true),
      extras,
    );
    more.classList.add('minor');
    more.hidden = !(a.wave & extras);
    const reveal = document.createElement('button');
    reveal.className = 'reveal';
    reveal.textContent = '⋯';
    reveal.title = 'Sync, ring modulation and test bit';
    reveal.setAttribute('aria-label', reveal.title);
    reveal.hidden = !more.hidden;
    reveal.addEventListener('click', () => {
      more.hidden = false;
      reveal.hidden = true;
    });
    box.append(pitchField(s, update, get), reveal, more);
  } else if (a.type === 'keep') {
    box.append(pitchField(s, update, get));
  } else if (a.type === 'wait') {
    box.append(
      numberField('for', a.frames, 1, 15, 'frames', (n) => update({ ...get(), left: waveLeft({ type: 'wait', frames: n }) }), 'Extra frames before this step’s pitch change'),
      label('then'),
      pitchField(s, update, get),
    );
  } else {
    const cmd = document.createElement('select');
    cmd.setAttribute('aria-label', 'Command');
    for (const [c, name] of WAVE_COMMANDS) cmd.append(new Option(name, String(c)));
    cmd.value = String(a.command);
    cmd.addEventListener('change', () => update({ ...get(), left: waveLeft({ type: 'command', command: Number(cmd.value) }) }));
    box.append(cmd, hexField(s.right, (v) => update({ ...get(), right: v }), 'Command value, as in a pattern (hex). Slides and vibrato point at the speed table.'));
  }
}

function pitchField(s: Step, update: Update, get: () => Step): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'pitch';
  const p = pitchOf(s.right);
  const mode = document.createElement('select');
  mode.setAttribute('aria-label', 'Pitch');
  mode.append(new Option('Note played', 'relative'), new Option('Fixed note', 'fixed'), new Option('Pitch unchanged', 'keep'));
  mode.title = 'Note played: relative to the key you play. Fixed note: always the same pitch (drums). Unchanged: leaves the pitch free for slides and vibrato.';
  mode.value = p.type;
  wrap.append(mode);
  if (p.type === 'relative') {
    wrap.append(numberField('', p.semitones, -32, 95, 'semitones', (n) => update({ ...get(), right: pitchRight({ type: 'relative', semitones: n }) }), 'Semitones up (or down, negative) from the note played'));
  } else if (p.type === 'fixed') {
    const note = document.createElement('select');
    note.setAttribute('aria-label', 'Fixed note');
    for (let n = 1; n <= 0x5f; n++) note.append(new Option(noteName(n), String(n)));
    note.value = String(p.note);
    note.addEventListener('change', () => update({ ...get(), right: pitchRight({ type: 'fixed', note: Number(note.value) }) }));
    wrap.append(note);
  }
  mode.addEventListener('change', () => {
    const was = pitchOf(get().right);
    const next: Pitch =
      mode.value === 'fixed' ? { type: 'fixed', note: was.type === 'relative' ? test.note + was.semitones : test.note } : mode.value === 'keep' ? { type: 'keep' } : { type: 'relative', semitones: 0 };
    update({ ...get(), right: pitchRight(next) });
    // The value field depends on the mode
    renderSteps();
  });
  return wrap;
}

function pulseFields(s: Step, box: HTMLElement, update: Update, get: () => Step) {
  const a = pulseAction(s);
  if (a.type === 'width') {
    box.append(
      slider(a.width, 0, 0xfff, (n) => percent(n / 4096), (n) => update(pulseStep({ type: 'width', width: n })), 'Pulse width: 50% is a square wave; near 0% or 100% it gets thin and quiet'),
    );
  } else if (a.type === 'sweep') {
    box.append(
      numberField('for', a.frames, 1, 127, 'frames', (n) => update(pulseStep({ ...(pulseAction(get()) as { type: 'sweep'; frames: number; speed: number }), frames: n })), 'How long the sweep lasts'),
      numberField('by', a.speed, -128, 127, 'a frame', (n) => update(pulseStep({ ...(pulseAction(get()) as { type: 'sweep'; frames: number; speed: number }), speed: n })), 'Change in width each frame, out of 4096. Negative narrows it.'),
    );
  }
}

type FilterSetup = { type: 'setup'; passband: number; resonance: number; voices: number };

// Filter modes: one filter, whose low, band and high pass outputs can be mixed
const BASIC_MODES: [number, string, string][] = [
  [FILTER_LOW, 'Low', 'Low pass: lets the bass through, muffles the highs'],
  [FILTER_BAND, 'Band', 'Band pass: keeps a band around the cutoff, nasal and thin'],
  [FILTER_HIGH, 'High', 'High pass: cuts the bass, keeps the fizz'],
  [FILTER_LOW | FILTER_HIGH, 'Notch', 'Low and high pass together: everything but a dip at the cutoff'],
];
const MIXED_MODES: [number, string][] = [
  [FILTER_LOW | FILTER_BAND, 'Low + Band: low pass with a bump at the cutoff'],
  [FILTER_BAND | FILTER_HIGH, 'Band + High: high pass with a bump at the cutoff'],
  [FILTER_LOW | FILTER_BAND | FILTER_HIGH, 'All three: nearly unfiltered, with resonance'],
  [0, 'None: filtered voices go silent'],
];

/** The most recent filter set-up before a row, which a cutoff step works with. */
function setupBefore(p: Program, row: number): FilterSetup | null {
  for (let r = row - 1; r >= 0; r--) {
    const a = filterAction(p.steps[r]);
    if (a.type === 'setup') return a;
  }
  return null;
}

function filterFields(p: Program, rows: number[], box: HTMLElement, update: (s: Step, row?: number) => void) {
  const i = rows[0];
  const a = filterAction(p.steps[i]);
  if (a.type === 'setup') {
    const setup = () => filterAction(p.steps[i]) as FilterSetup;
    const cutoffRow = rows[1];
    const curve = filterCurve({
      get: () => ({ ...setup(), cutoff: cutoffRow !== undefined ? filterAction(p.steps[cutoffRow]).type === 'cutoff' ? p.steps[cutoffRow].right : null : null }),
      change: ({ cutoff, resonance }) => {
        if (resonance !== undefined) update(filterStep({ ...setup(), resonance }), i);
        if (cutoff === undefined) return;
        if (cutoffRow !== undefined) update(filterStep({ type: 'cutoff', cutoff }), cutoffRow);
        // A set-up without its own cutoff gets one
        else insertStep(i + 1, filterStep({ type: 'cutoff', cutoff }));
      },
      done: () => blip(),
      resonance: true,
    });
    const modes = modePicker(a.passband, (bits) => {
      update(filterStep({ ...setup(), passband: bits }), i);
      renderSteps();
      blip();
    });
    const controls = document.createElement('div');
    controls.className = 'filter-controls';
    controls.append(modes, routingField(a.voices, (voices) => {
      update(filterStep({ ...setup(), voices }), i);
      renderSteps();
      blip();
    }));
    box.append(curve, controls);
  } else if (a.type === 'cutoff') {
    const shape = setupBefore(p, i);
    box.append(
      filterCurve({
        // With no set-up before it there is no filter shape to show
        get: () => ({ passband: shape?.passband ?? 0, resonance: shape?.resonance ?? 0, cutoff: p.steps[i].right }),
        change: ({ cutoff }) => cutoff !== undefined && update(filterStep({ type: 'cutoff', cutoff }), i),
        done: () => blip(),
        resonance: false,
        borrowed: true,
      }),
    );
  } else {
    type Sweep = { type: 'sweep'; frames: number; speed: number };
    const get = () => filterAction(p.steps[i]) as Sweep;
    box.append(
      numberField('for', a.frames, 1, 127, 'frames', (n) => update(filterStep({ ...get(), frames: n })), 'How long the sweep lasts'),
      numberField('by', a.speed, -128, 127, 'a frame', (n) => update(filterStep({ ...get(), speed: n })), 'Change in cutoff each frame, out of 255. Negative closes the filter (darker), positive opens it (brighter).'),
    );
  }
}

/** Filter mode buttons with pictures of their curves, and a list of the other mixes. */
function modePicker(passband: number, change: (bits: number) => void): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'wave-picker';
  const buttons = document.createElement('span');
  buttons.className = 'toggles';
  for (const [bits, name, title] of BASIC_MODES) {
    const b = document.createElement('button');
    b.className = 'toggle wave-choice';
    b.title = title;
    b.setAttribute('aria-pressed', String(passband === bits));
    b.append(modeIcon(bits), name);
    b.addEventListener('click', () => change(bits));
    buttons.append(b);
  }
  const more = document.createElement('select');
  more.className = 'mixes';
  more.setAttribute('aria-label', 'Other filter modes');
  more.append(new Option('More…', ''));
  for (const [bits, name] of MIXED_MODES) more.append(new Option(name, String(bits)));
  const basic = BASIC_MODES.some(([bits]) => bits === passband);
  more.value = basic ? '' : String(passband);
  more.classList.toggle('on', !basic);
  more.addEventListener('change', () => {
    if (more.value !== '') change(Number(more.value));
  });
  wrap.append(buttons, more);
  return wrap;
}

/**
 * Which voices go through the filter. The test note plays on voice 1, so
 * "this voice" is voice 1 here; the other voices are behind a button.
 */
function routingField(voices: number, change: (voices: number) => void): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'routing';
  const own = segmented(
    [
      [1, 'Filter this voice', 'The note this instrument plays goes through the filter'],
      [0, 'Off', 'This instrument’s voice skips the filter'],
    ],
    voices & 1,
    (bit) => change((voices & ~1) | bit),
  );
  const others = toggles(
    [
      [2, 'V2', 'Also filter voice 2 (another instrument’s note)', ''],
      [4, 'V3', 'Also filter voice 3 (another instrument’s note)', ''],
    ],
    voices,
    (bits) => (change((voices & 1) | bits), true),
    0x06,
  );
  others.classList.add('minor');
  others.hidden = !(voices & 6);
  const reveal = document.createElement('button');
  reveal.className = 'reveal';
  reveal.textContent = '⋯';
  reveal.title = 'Other voices: the filter is shared, so it can filter other instruments’ notes too';
  reveal.setAttribute('aria-label', reveal.title);
  reveal.hidden = !others.hidden;
  reveal.addEventListener('click', () => {
    others.hidden = false;
    reveal.hidden = true;
  });
  wrap.append(own, reveal, others);
  return wrap;
}

const BASIC_WAVES: [number, string, string][] = [
  [WAVE_TRI, 'Tri', 'Triangle: soft and round, like a flute'],
  [WAVE_SAW, 'Saw', 'Sawtooth: bright and buzzy, like brass or strings'],
  [WAVE_PULSE, 'Pulse', 'Pulse: hollow to nasal, shaped by the pulse width'],
  [WAVE_NOISE, 'Noise', 'Noise: hiss, for drums and effects'],
];

// Mixes that make a sound. The chip combines the waveforms' bits, so these
// are quieter and thinner than one waveform, and differ between chips.
const MIXED_WAVES: [number, string, string][] = [
  [WAVE_SAW | WAVE_TRI, 'Saw + Triangle', 'reedy and hollow'],
  [WAVE_PULSE | WAVE_TRI, 'Pulse + Triangle', 'a soft, muted pulse'],
  [WAVE_PULSE | WAVE_SAW, 'Pulse + Saw', 'thin and metallic'],
  [WAVE_PULSE | WAVE_SAW | WAVE_TRI, 'Pulse + Saw + Triangle', 'faint and glassy'],
];

/** Waveform buttons with pictures, and a list of the useful mixes. */
function wavePicker(wave: number, change: (osc: number) => void): HTMLElement {
  const osc = wave & 0xf0;
  const wrap = document.createElement('span');
  wrap.className = 'wave-picker';
  const buttons = document.createElement('span');
  buttons.className = 'toggles waves';
  for (const [bit, name, title] of BASIC_WAVES) {
    const b = document.createElement('button');
    b.className = 'toggle wave-choice';
    b.dataset.tone = waveTone(bit);
    b.title = title;
    b.setAttribute('aria-pressed', String(osc === bit));
    b.append(waveIcon(bit, 22, 12), name);
    b.addEventListener('click', () => change(bit));
    buttons.append(b);
  }
  const mixes = document.createElement('select');
  mixes.className = 'mixes';
  mixes.setAttribute('aria-label', 'Mixed waveforms');
  mixes.title = 'Two or three waveforms at once. The chip merges them into new, quieter tones, which sound different on the 6581 and 8580.';
  mixes.append(new Option('More…', ''));
  for (const [bits, name, hint] of MIXED_WAVES) mixes.append(new Option(`${name}: ${hint}`, String(bits)));
  const isBasic = BASIC_WAVES.some(([bit]) => bit === osc);
  const isMix = MIXED_WAVES.some(([bits]) => bits === osc);
  // Songs can hold values the menu doesn't offer: show them as they are
  if (!isBasic && !isMix) mixes.append(new Option(osc ? `${waveName(osc)} (silent: noise doesn't mix)` : 'No waveform (silent)', String(osc)));
  mixes.value = isBasic ? '' : String(osc);
  mixes.classList.toggle('on', !isBasic);
  // A select only reports a change to a different option, so clear it while
  // the menu is open: picking the mix already chosen then plays it again
  const shown = mixes.value;
  mixes.addEventListener('pointerdown', () => {
    if (document.activeElement !== mixes) mixes.selectedIndex = -1;
  });
  mixes.addEventListener('blur', () => {
    if (mixes.selectedIndex === -1) mixes.value = shown;
  });
  mixes.addEventListener('change', () => {
    if (mixes.value !== '') change(Number(mixes.value));
    else mixes.value = shown;
  });
  wrap.append(buttons, mixes);
  return wrap;
}

/** One-of-several buttons for a value. */
function segmented(items: [number, string, string][], value: number, change: (v: number) => void): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'toggles';
  for (const [v, text, title] of items) {
    const b = document.createElement('button');
    b.className = 'toggle';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-pressed', String(v === value));
    if (v === value && v) b.dataset.tone = 'gate';
    b.addEventListener('click', () => v !== value && change(v));
    wrap.append(b);
  }
  return wrap;
}

/** Toggle chips over some bits of a value; change returns false to refuse. */
function toggles(items: [number, string, string, string][], value: number, change: (bits: number) => boolean, mask: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'toggles';
  let bits = value & mask;
  for (const [bit, text, title, tone] of items) {
    const b = document.createElement('button');
    b.className = 'toggle';
    if (tone) b.dataset.tone = tone;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-pressed', String(!!(bits & bit)));
    b.addEventListener('click', () => {
      const next = bits ^ bit;
      if (!change(next)) {
        toast('A wave table can’t store that mix of waveforms');
        return;
      }
      bits = next;
      b.setAttribute('aria-pressed', String(!!(bits & bit)));
    });
    wrap.append(b);
  }
  return wrap;
}

function label(text: string) {
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = text;
  return l;
}

function numberField(before: string, value: number, min: number, max: number, after: string, change: (n: number) => void, title: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'num';
  wrap.title = title;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener('input', () => {
    const n = Number(input.value);
    if (input.value === '' || !Number.isFinite(n)) return;
    change(Math.max(min, Math.min(max, Math.round(n))));
  });
  input.addEventListener('change', () => {
    const n = Math.max(min, Math.min(max, Math.round(Number(input.value) || 0)));
    input.value = String(n);
    change(n);
  });
  if (before) wrap.append(label(before));
  wrap.append(input);
  if (after) wrap.append(label(after));
  return wrap;
}

function hexField(value: number, change: (n: number) => void, title: string): HTMLElement {
  const input = document.createElement('input');
  input.className = 'hex';
  input.maxLength = 2;
  input.spellcheck = false;
  input.title = title;
  input.value = hex(value);
  input.addEventListener('input', () => {
    if (/^[0-9a-f]{1,2}$/i.test(input.value)) change(parseInt(input.value, 16));
  });
  input.addEventListener('change', () => (input.value = hex(parseInt(input.value, 16) || 0)));
  return input;
}

function slider(value: number, min: number, max: number, show: (n: number) => string, change: (n: number) => void, title: string, size = ''): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = `slider ${size}`;
  wrap.title = title;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  const out = document.createElement('output');
  out.textContent = show(value);
  input.addEventListener('input', () => {
    out.textContent = show(Number(input.value));
    change(Number(input.value));
  });
  wrap.append(input, out);
  return wrap;
}

// --- The graph ------------------------------------------------------------

let analyzer: Analyzer | null = null;
let trace: Trace | null = null;
let traced: Audition | null = null;
let previewPending = false;

function schedulePreview() {
  if (previewPending) return;
  previewPending = true;
  requestAnimationFrame(() => {
    previewPending = false;
    const a = audition();
    traced = a;
    if (player.started) {
      player.setTables(a.tables);
      player.setInstrument(TEST_INSTRUMENT, a.instrument);
    }
    if (analyzer) trace = analyzer.trace(a.tables, a.instrument, test.note, test.frames[state.kind], DEFAULT_SETTINGS);
    drawGraph();
    if (blipPending) {
      blipPending = false;
      playBlip();
    }
  });
}

interface Lane {
  name: string;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, y: number, h: number) => void;
}

const GUTTER = 64;
const AXIS = 18;
/** Room above the first lane's plot for its name and "& volume" */
const PLOT_TOP = 40;
let graphHover = -1;

function colors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    border: v('--border'),
    grid: v('--step-beat'),
    accent: v('--accent'),
    surface: v('--surface'),
    surface2: v('--surface-2'),
    tri: v('--tri'),
    saw: v('--saw'),
    pulse: v('--pulse'),
    noise: v('--noise'),
    playhead: v('--playhead'),
    stepS: v('--clip-s'),
    stepL: v('--clip-l'),
  };
}

/** Which step of the edited program each frame ran, or -1 if another program's, or -2 if none. */
function frameSteps(): number[] {
  if (!trace || !traced) return [];
  const kind = state.kind;
  const list = traced.lists[kind];
  const p = current();
  const out: number[] = [];
  for (let f = 0; f < trace.frames; f++) {
    const pos = trace.pos[kind][f];
    if (!pos) {
      out.push(-2);
      continue;
    }
    const at = locate(list, traced.layouts[kind], pos);
    if (!at || list[at.program] !== p) {
      out.push(-1);
      continue;
    }
    // On its end row the program has stopped, or is jumping back
    const end = at.step >= p!.steps.length;
    out.push(!end ? at.step : !p!.next ? -2 : p!.next.program === p ? p!.next.step : -1);
  }
  return out;
}

function semitones(freq: number): number {
  // GoatTracker's PAL frequency table: A-4 (note 57) is 440 Hz
  const played = ((440 * 2 ** ((test.note - 57) / 12)) * 16777216) / 985248;
  return freq ? 12 * Math.log2(freq / played) : NaN;
}

interface Volume {
  /** Envelope level (0-1), ENV_STEPS samples a frame */
  level: Float32Array;
  /** Frame the key goes up, or -1 while it is still held */
  keyUp: number;
  /** Whether this is a made-up example rather than the last note played */
  example: boolean;
  /** First frame after key up where the sound has all but died away, or the span */
  end: number;
  /** Frames to draw: a note being played is drawn as far as it has got */
  shown: number;
}

const ENV_STEPS = 4;

/**
 * The test note's volume envelope. Before any note is played, or after the
 * envelope settings change, an example with the key going up halfway
 * through; otherwise the last note played, drawn as far as it has got.
 */
function volume(): Volume | null {
  if (!trace || !traced) return null;
  const frames = trace.frames;
  const { ad, sr } = traced.instrument;
  const env = (ad << 8) | sr;
  // The note played with other settings no longer shows what they do
  if (playedEnv !== env) playedEnv = null;
  const example = playedEnv === null;
  let keyUp = Math.round(frames / 2);
  if (!example) keyUp = held !== null ? Math.max(frames, liveFrame() + 1) : (releasedAt ?? frames);
  const gate = Array.from({ length: frames }, (_, f) => (trace!.control[f] & WAVE_GATE) !== 0 && f < keyUp);
  const level = envelope(ad, sr, gate, ENV_STEPS);
  let end = frames;
  for (let f = Math.max(keyUp, 1); f < frames; f++) {
    if (level[f * ENV_STEPS] < 0.02) {
      end = f;
      break;
    }
  }
  const shown = example ? frames : animating ? Math.max(0, Math.min(frames, playheadFrame)) : held !== null ? frames : end;
  return { level, keyUp: example || held === null ? keyUp : -1, example, end, shown };
}

function drawGraph() {
  const canvas = $<HTMLCanvasElement>('graph');
  const c = colors();
  const kind = state.kind;
  const lanes: Lane[] = [];
  const t = trace;
  const steps = frameSteps();
  const width = canvas.parentElement!.clientWidth;
  const frames = test.frames[state.kind];
  const fw = (width - GUTTER) / frames;
  const x = (f: number) => GUTTER + f * fw;
  // Once the program stops (the sound holds its last step) or first loops
  // back (it repeats), nothing new happens: everything from there is faded
  const ran = steps.findIndex((v) => v >= 0);
  const settled = ran < 0 ? -1 : steps.findIndex((v, f) => f > ran && (v === -2 || (v >= 0 && steps[f - 1] >= 0 && v < steps[f - 1])));
  // A program that stops holds its last step (a filter's setup and cutoff steps run in one frame)
  const held = settled > 0 && steps[settled] === -2 ? Math.max(steps[settled - 1], (current()?.steps.length ?? 0) - 1) : -1;
  const settledText = settled < 0 ? '' : held >= 0 ? `hold step ${unitOf(held) + 1}` : `repeat from step ${unitOf(steps[settled]) + 1}`;
  const labelLane = kind === WAVE ? 'Wave' : kind === PULSE ? 'Width' : 'Cutoff';

  if (t && kind === WAVE) {
    const values = Array.from(t.freq, semitones).filter(Number.isFinite);
    let lo = Math.floor(Math.min(0, ...values));
    let hi = Math.ceil(Math.max(0, ...values));
    if (hi - lo < 12) {
      const pad = 12 - (hi - lo);
      hi += Math.ceil(pad / 2);
      lo -= Math.floor(pad / 2);
    }
    lanes.push({
      name: 'Pitch',
      height: 150,
      draw(ctx, y, h) {
        const yv = (v: number) => y + PLOT_TOP + ((hi - v) / (hi - lo)) * (h - PLOT_TOP - 6);
        ctx.font = '11px system-ui';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let v = lo; v <= hi; v++) {
          const major = v % 12 === 0;
          if (!major && hi - lo > 36) continue;
          ctx.fillStyle = major ? c.border : c.grid;
          ctx.fillRect(GUTTER, Math.round(yv(v)), width - GUTTER, 1);
          if (major) {
            ctx.fillStyle = c.muted;
            ctx.fillText(v === 0 ? noteName(test.note) : `${v > 0 ? '+' : '−'}${Math.abs(v)}`, GUTTER - 8, yv(v));
          }
        }
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.strokeStyle = c.accent;
        // One line per held pitch, with a faint riser where it changes
        runs(frames, (f) => `${t.freq[f]}|${(t.control[f] & 0xf0) !== 0 && !(t.control[f] & WAVE_TEST)}`, (from, to) => {
          const v = semitones(t.freq[from]);
          if (!Number.isFinite(v)) return;
          const sounding = (t.control[from] & 0xf0) !== 0 && !(t.control[from] & WAVE_TEST);
          ctx.globalAlpha = sounding ? 1 : 0.3;
          ctx.beginPath();
          ctx.moveTo(x(from) + 1, yv(v));
          ctx.lineTo(x(to) - 1, yv(v));
          ctx.stroke();
          const prev = from > 0 ? semitones(t.freq[from - 1]) : NaN;
          if (Number.isFinite(prev) && Math.abs(prev - v) > 0.01) {
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x(from), yv(prev));
            ctx.lineTo(x(from), yv(v));
            ctx.stroke();
            ctx.lineWidth = 2.5;
          }
        });
        ctx.globalAlpha = 1;
      },
    });
    lanes.push({
      name: 'Wave',
      height: 34,
      draw(ctx, y, h) {
        // One bar per stretch of unchanged waveform
        runs(frames, (f) => String(t.control[f]), (f, to) => {
          const w = t.control[f];
          const osc = [
            [WAVE_TRI, c.tri],
            [WAVE_SAW, c.saw],
            [WAVE_PULSE, c.pulse],
            [WAVE_NOISE, c.noise],
          ].filter(([bit]) => w & (bit as number));
          if (w & WAVE_TEST || !osc.length) return;
          ctx.globalAlpha = w & WAVE_GATE ? 1 : 0.35;
          const bh = (h - 8) / osc.length;
          osc.forEach(([, color], i) => {
            ctx.fillStyle = color as string;
            ctx.fillRect(x(f) + 0.5, y + 4 + i * bh, Math.max(1, x(to) - x(f) - 1), bh);
          });
        });
        ctx.globalAlpha = 1;
      },
    });
  }
  if (t && kind === PULSE) {
    lanes.push({
      name: 'Width',
      height: 150,
      draw(ctx, y, h) {
        const yv = (v: number) => y + PLOT_TOP + (1 - v / 4096) * (h - PLOT_TOP - 6);
        ctx.font = '11px system-ui';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of [0, 1024, 2048, 3072, 4096]) {
          ctx.fillStyle = v === 2048 ? c.border : c.grid;
          ctx.fillRect(GUTTER, Math.round(yv(v)), width - GUTTER, 1);
          ctx.fillStyle = c.muted;
          ctx.fillText(percent(v / 4096), GUTTER - 8, yv(v));
        }
        line(ctx, frames, x, (f) => yv(t.pulse[f]), c.pulse);
      },
    });
  }
  if (t && kind === FILTER) {
    lanes.push({
      name: 'Cutoff',
      height: 150,
      draw(ctx, y, h) {
        const yv = (v: number) => y + PLOT_TOP + (1 - v / 255) * (h - PLOT_TOP - 6);
        ctx.font = '11px system-ui';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of [0, 64, 128, 192, 255]) {
          ctx.fillStyle = c.grid;
          ctx.fillRect(GUTTER, Math.round(yv(v)), width - GUTTER, 1);
          ctx.fillStyle = c.muted;
          ctx.fillText(String(v), GUTTER - 8, yv(v));
        }
        line(ctx, frames, x, (f) => yv(t.cutoff[f]), c.accent);
      },
    });
    lanes.push({
      name: 'Filter',
      height: 26,
      draw(ctx, y, h) {
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        runs(frames, (f) => `${t.mode[f] & 0x70}|${t.routing[f]}`, (from, to) => {
          const mode = t.mode[from] & 0x70;
          const routed = t.routing[from] & 1;
          ctx.fillStyle = routed && mode ? c.surface2 : 'transparent';
          ctx.fillRect(x(from) + 1, y + 3, x(to) - x(from) - 2, h - 6);
          ctx.fillStyle = routed && mode ? c.text : c.muted;
          const label = !mode ? 'off' : `${passbandName(mode)}, res ${t.routing[from] >> 4}${routed ? '' : ' · voice 1 not filtered'}`;
          clipText(ctx, label, x(from) + 6, y + h / 2, x(to) - x(from) - 10);
        });
      },
    });
  }
  const vol = volume();
  lanes.push({
    name: 'Step',
    height: 26,
    draw(ctx, y, h) {
      ctx.font = '600 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const list = traced?.lists[kind] ?? [];
      // Frames where the program jumps back to an earlier step; after the
      // first, it is repeating itself, so those passes are drawn faded
      const loops: number[] = [];
      for (let f = 1; f < frames; f++) if (steps[f] >= 0 && steps[f - 1] >= 0 && steps[f] < steps[f - 1]) loops.push(f);
      const repeating = settled > 0 ? settled : frames;
      runs(frames, (f) => `${steps[f]}|${t ? t.pos[kind][f] : 0}|${steps[f] >= 0 || steps[f] === -2 ? '' : f}`, (from, to) => {
        let s = steps[from];
        if (s === -2 && held >= 0 && from >= settled) s = held;
        else if (s === -2) {
          if (from === 0 || steps[from - 1] !== -2) {
            ctx.fillStyle = c.muted;
            ctx.textAlign = 'left';
            clipText(ctx, 'not running', x(from) + 6, y + h / 2, width - x(from));
            ctx.textAlign = 'center';
          }
          return;
        }
        if (s === -1) {
          const at = t && traced ? locate(list, traced.layouts[kind], t.pos[kind][from]) : null;
          ctx.fillStyle = c.surface2;
          ctx.fillRect(x(from) + 0.5, y + 3, Math.max(1, x(to) - x(from) - 1), h - 6);
          if (at && (from === 0 || steps[from - 1] !== -1)) {
            ctx.fillStyle = c.muted;
            ctx.textAlign = 'left';
            clipText(ctx, `→ ${list[at.program].name}`, x(from) + 4, y + h / 2, width - x(from));
            ctx.textAlign = 'center';
          }
          return;
        }
        const hue = stepHue(unitOf(s));
        const on = hoverStep < 0 ? from < repeating : hoverStep === s;
        ctx.fillStyle = `hsl(${hue} ${c.stepS} ${c.stepL})`;
        ctx.globalAlpha = on ? 1 : 0.35;
        ctx.fillRect(x(from) + 0.5, y + 3, Math.max(1, x(to) - x(from) - 1), h - 6);
        ctx.globalAlpha = 1;
        if (x(to) - x(from) >= 12) {
          ctx.fillStyle = c.text;
          ctx.fillText(String(unitOf(s) + 1), (x(from) + x(to)) / 2, y + h / 2);
        }
      });
      ctx.fillStyle = c.accent;
      for (const f of loops) {
        ctx.fillRect(Math.round(x(f)) - 1, y, 2, h);
        ctx.beginPath();
        ctx.moveTo(x(f) - 5, y);
        ctx.lineTo(x(f) + 5, y);
        ctx.lineTo(x(f), y + 5);
        ctx.fill();
      }
    },
  });

  const height = lanes.reduce((n, l) => n + l.height, 0) + AXIS;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Frames of the hovered step, across all lanes
  if (hoverStep >= 0) {
    ctx.fillStyle = c.surface2;
    runs(frames, (f) => String(steps[f] === hoverStep), (from, to) => {
      if (steps[from] === hoverStep) ctx.fillRect(x(from), 0, x(to) - x(from), height - AXIS);
    });
  }

  let y = 0;
  let labelTop = -1;
  ctx.font = '600 12px system-ui';
  for (const lane of lanes) {
    if (lane.name === labelLane) labelTop = y;
    ctx.fillStyle = c.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '600 12px system-ui';
    ctx.fillText(lane.name, 0, y + 6);
    lane.draw(ctx, y, lane.height);
    y += lane.height;
    ctx.fillStyle = c.border;
    ctx.fillRect(GUTTER, y, width - GUTTER, 1);
  }

  // Wash out the lanes above the steps once the program settles, and say how
  if (settled > 0) {
    // The step lane shows what happens next its own way
    const below = lanes[lanes.length - 1].height;
    ctx.fillStyle = c.surface;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x(settled), 0, width - x(settled), y - below);
    ctx.globalAlpha = 1;
    if (labelTop >= 0) {
      ctx.font = '600 11px system-ui';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const ty = labelTop + (labelLane === 'Wave' ? 17 : 26);
      const tw = Math.min(ctx.measureText(settledText).width, width - x(settled) - 16);
      if (tw > 20) {
        ctx.fillStyle = c.surface;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.roundRect(x(settled) + 4, ty - 8, tw + 8, 16, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.text;
        clipText(ctx, settledText, x(settled) + 8, ty, tw + 1);
      }
    }
  }

  // The volume envelope, shaded behind the first lane, and never faded:
  // it keeps changing however the programs settle
  if (vol && vol.shown > 0 && lanes.length > 1) {
    const top = PLOT_TOP;
    const bottom = lanes[0].height - 6;
    const n = Math.min(vol.level.length, vol.shown * ENV_STEPS + 1);
    const sx = (i: number) => x(i / ENV_STEPS);
    const sy = (i: number) => bottom - vol.level[i] * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(sx(0), bottom);
    for (let i = 0; i < n; i++) ctx.lineTo(sx(i), sy(i));
    ctx.lineTo(sx(n - 1), bottom);
    ctx.closePath();
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = c.muted;
    ctx.fillText('& volume', 0, 21);
    if (vol.keyUp >= 0 && vol.keyUp < Math.min(frames, vol.shown + 1)) {
      const kx = Math.round(x(vol.keyUp)) + 0.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = c.muted;
      ctx.beginPath();
      ctx.moveTo(kx, 2);
      ctx.lineTo(kx, lanes[0].height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 11px system-ui';
      const label = vol.example ? 'key up (example)' : 'key up';
      const right = kx + 6 + ctx.measureText(label).width < width;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, right ? kx + 5 : kx - 5, 6);
    }
  }

  // Time axis
  ctx.font = '11px system-ui';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  // A label every 0.1, 0.2, 0.5 or 1 s, at least 40 px apart
  const every = [5, 10, 25, 50].find((n) => n * fw >= 40) ?? 50;
  for (let f = 0; f <= frames; f += every) {
    ctx.fillStyle = c.border;
    ctx.fillRect(Math.round(x(f)), y, 1, 4);
    ctx.fillStyle = c.muted;
    ctx.fillText(`${(f / FPS).toFixed(f % FPS === 0 ? 0 : 1)}s`, Math.min(x(f), width - 12), y + 4);
  }

  if (graphHover >= 0) {
    ctx.fillStyle = c.text;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x(graphHover), 0, fw, height - AXIS);
    ctx.globalAlpha = 1;
  }
  if (playheadFrame >= 0 && playheadFrame < frames) {
    ctx.fillStyle = c.playhead;
    ctx.fillRect(Math.round(x(playheadFrame)) - 1, 0, 2, height - AXIS);
  }
}

function line(ctx: CanvasRenderingContext2D, frames: number, x: (f: number) => number, y: (f: number) => number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let f = 0; f < frames; f++) {
    if (f === 0) ctx.moveTo(x(f), y(f));
    else ctx.lineTo(x(f), y(f));
    ctx.lineTo(x(f + 1), y(f));
  }
  ctx.stroke();
}

/** Calls draw for each run of frames with the same key. */
function runs(frames: number, key: (f: number) => string, draw: (from: number, to: number) => void) {
  let from = 0;
  for (let f = 1; f <= frames; f++) {
    if (f === frames || key(f) !== key(from)) {
      draw(from, f);
      from = f;
    }
  }
}

function clipText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number) {
  if (max < 14) return;
  let s = text;
  while (s.length > 1 && ctx.measureText(s).width > max) s = s.slice(0, -2) + '…';
  ctx.fillText(s, x, y);
}

function setHoverStep(i: number) {
  if (hoverStep === i) return;
  hoverStep = i;
  drawGraph();
}

function graphTip(f: number): string {
  const t = trace;
  if (!t) return '';
  const kind = state.kind;
  const steps = frameSteps();
  const s = steps[f];
  const p = current()!;
  const head = `Frame ${f + 1} · ${(f / FPS).toFixed(2)} s`;
  // Is this frame on a repeat, after the program first looped back?
  const again = s >= 0 && steps.slice(1, f + 1).some((v, i) => v >= 0 && steps[i] >= 0 && v < steps[i]);
  const last = s === -2 ? Math.max(-1, ...steps.slice(0, f).filter((v) => v >= 0).slice(-1)) : -1;
  const stepText =
    s >= 0
      ? `Step ${unitOf(s) + 1}${again ? ' (repeating)' : ''}: ${describeUnit(kind, p, unitsOf(p)[unitOf(s)])}`
      : s === -1
        ? 'Running another program'
        : last >= 0
          ? `Stopped: holding step ${unitOf(last) + 1}`
          : `${kind === FILTER ? 'Filter' : 'Program'} not running`;
  let value = '';
  if (kind === WAVE) {
    const st = semitones(t.freq[f]);
    const w = t.control[f];
    const pitch = Number.isFinite(st) ? `${noteName(Math.round(test.note + st))}${Math.abs(st - Math.round(st)) > 0.05 ? ' (between notes)' : ''}` : 'no pitch';
    value = `${w & WAVE_TEST ? 'Test bit (silent)' : waveName(w)} · ${pitch}${w & WAVE_GATE ? '' : ' · gate off'}`;
  } else if (kind === PULSE) {
    value = `Width ${percent(t.pulse[f] / 4096)} (${t.pulse[f]} of 4096)`;
  } else {
    value = `Cutoff ${t.cutoff[f]} · ${passbandName(t.mode[f] & 0x70)}, resonance ${t.routing[f] >> 4}`;
  }
  const vol = volume();
  const level = vol ? `Volume ${Math.round(vol.level[f * ENV_STEPS] * 100)}%${vol.keyUp >= 0 && f >= vol.keyUp ? ' · releasing' : ''}` : '';
  return `<b>${head}</b><br>${escapeHtml(stepText)}<br>${escapeHtml(value)}${level ? `<br>${level}` : ''}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
}

function graphFrame(e: PointerEvent): number {
  const canvas = $<HTMLCanvasElement>('graph');
  const rect = canvas.getBoundingClientRect();
  const fw = (rect.width - GUTTER) / test.frames[state.kind];
  const f = Math.floor((e.clientX - rect.left - GUTTER) / fw);
  return f >= 0 && f < test.frames[state.kind] ? f : -1;
}

{
  const canvas = $<HTMLCanvasElement>('graph');
  const tip = $('graph-tip');
  canvas.addEventListener('pointermove', (e) => {
    const f = graphFrame(e);
    if (f !== graphHover) {
      graphHover = f;
      const s = f >= 0 ? frameSteps()[f] : -1;
      hoverStep = s >= 0 ? unitStart(s) : -1;
      for (const row of $('steps').querySelectorAll<HTMLElement>('.step')) row.classList.toggle('hover', Number(row.dataset.step) === hoverStep);
      drawGraph();
    }
    tip.hidden = f < 0;
    if (f < 0) return;
    tip.innerHTML = graphTip(f);
    const rect = canvas.getBoundingClientRect();
    const left = e.clientX - rect.left;
    tip.style.left = `${Math.min(left + 14, rect.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${e.clientY - rect.top + 14}px`;
  });
  canvas.addEventListener('pointerleave', () => {
    graphHover = -1;
    hoverStep = -1;
    tip.hidden = true;
    for (const row of $('steps').querySelectorAll('.step.hover')) row.classList.remove('hover');
    drawGraph();
  });
  canvas.addEventListener('click', (e) => {
    const f = graphFrame(e);
    const s = f >= 0 ? frameSteps()[f] : -1;
    const row = $('steps').querySelector<HTMLElement>(`.step[data-step="${unitStart(s)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  });
  new ResizeObserver(() => drawGraph()).observe(canvas.parentElement!);
}

// --- Playing --------------------------------------------------------------

const player = new Player();
player.onError = (m) => toast(m);
let lastStatus: Status | null = null;
player.onStatus = (status: Status) => {
  lastStatus = status;
  showLive(status);
};
let held: number | null = null;
let noteStart = 0;
let playheadFrame = -1;
/** The frame the last test note was let go, for the volume graph */
let releasedAt: number | null = null;
/** The envelope (AD and SR) of the last test note, or null to show an example */
let playedEnv: number | null = null;

/** The graph frame the test note has reached, negative before it sounds. */
function liveFrame(): number {
  const elapsed = (performance.now() - noteStart) / 1000 - player.latency;
  // The note sounds after the gate timer and a frame of setup
  return Math.floor(elapsed * FPS) - (((instrument()?.gateTimer ?? 2) & 0x3f) + 1);
}

async function noteOn(note: number) {
  // Held from now: a quick click can be released while audio is starting
  held = note;
  renderKeyboard();
  if (!player.started) {
    try {
      await player.start();
    } catch (err) {
      held = null;
      renderKeyboard();
      toast(`Audio failed to start: ${err}`);
      return;
    }
    const a = audition();
    player.setTables(a.tables);
    player.setInstrument(TEST_INSTRUMENT, a.instrument);
  }
  if (note !== test.note) {
    test.note = note;
    schedulePreview();
  }
  player.noteOn(0, note, TEST_INSTRUMENT);
  noteStart = performance.now();
  releasedAt = null;
  playedEnv = traced ? (traced.instrument.ad << 8) | traced.instrument.sr : null;
  // Released already: still play it, briefly
  if (held !== note) {
    player.noteOff(0);
    releasedAt = 1;
  }
  animate();
}

let blipPending = false;
let blipTimer = 0;

/** Plays the last note briefly once the change has reached the player, so a choice can be heard. */
function blip() {
  blipPending = true;
  schedulePreview();
}

function playBlip() {
  if (held !== null) return;
  const note = test.note;
  void noteOn(note);
  clearTimeout(blipTimer);
  blipTimer = window.setTimeout(() => noteOff(note), 450);
}

/** Cuts the sound at once, whatever the release time. */
function silence() {
  held = null;
  if (player.started) player.silence();
  renderKeyboard();
}

function noteOff(note?: number) {
  if (held === null || (note !== undefined && note !== held)) return;
  held = null;
  // A release before the note starts waits for it: it still sounds a frame
  releasedAt = Math.max(1, liveFrame());
  if (player.started) player.noteOff(0);
  renderKeyboard();
  drawGraph();
}

let animating = false;
function animate() {
  if (animating) return;
  animating = true;
  const step = () => {
    const f = liveFrame();
    const was = playheadFrame;
    // Once let go, the playhead stops where the sound has faded away
    const end = held === null ? (volume()?.end ?? test.frames[state.kind]) : test.frames[state.kind];
    playheadFrame = held === null && f >= end ? -1 : f;
    if (playheadFrame !== was) drawGraph();
    if (playheadFrame >= 0 && playheadFrame < test.frames[state.kind]) requestAnimationFrame(step);
    else if (held !== null && f < 0) requestAnimationFrame(step);
    else {
      animating = false;
      playheadFrame = -1;
      drawGraph();
    }
  };
  requestAnimationFrame(step);
}

function showLive(status: Status) {
  let step = -1;
  if (traced && (held !== null || playheadFrame >= 0)) {
    const kind = state.kind;
    const pos = status.tablePos[kind];
    const at = pos ? locate(traced.lists[kind], traced.layouts[kind], pos) : null;
    if (at && traced.lists[kind][at.program] === current()) step = unitStart(at.step);
  }
  if (step === liveStep) return;
  liveStep = step;
  for (const row of $('steps').querySelectorAll<HTMLElement>('.step')) row.classList.toggle('live', Number(row.dataset.step) === step);
}

// Note keys in one row, like a piano: white keys A S D F G H J K L ; and the
// black keys above them on W E, T Y U, O P. That reaches from C up to the E
// a bit over an octave higher.
const KEY_LETTERS = [...'AWSEDFTGYHUJKOLP;'];
const KEYS: Record<string, number> = Object.fromEntries(KEY_LETTERS.map((k, i) => [k.toLowerCase(), i]));

function renderKeyboard() {
  const board = $('keyboard');
  const base = test.octave * 12;
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
    // Dragging across the keys plays each one it passes over
    const keyAt = (e: PointerEvent) => document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('#keyboard .key');
    let dragging = false;
    board.addEventListener('pointerdown', (e) => {
      const key = keyAt(e);
      if (!key) return;
      e.preventDefault();
      board.setPointerCapture(e.pointerId);
      dragging = true;
      void noteOn(test.octave * 12 + Number(key.dataset.offset));
    });
    board.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const key = keyAt(e);
      const note = key ? test.octave * 12 + Number(key.dataset.offset) : null;
      if (note !== null && note !== held) void noteOn(note);
    });
    const end = () => {
      dragging = false;
      noteOff();
    };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
  }
  const labels = $('key-labels');
  labels.replaceChildren();
  for (const key of board.querySelectorAll<HTMLElement>('.key')) {
    const offset = Number(key.dataset.offset);
    const n = base + offset;
    key.classList.toggle('down', n === held);
    // The computer key that plays it
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

/**
 * Only fields you type into keep the keys; on everything else (dropdowns,
 * buttons, sliders) the keys play notes.
 */
function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea') || t.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing(e)) {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if (e.key === 'Escape') {
    silence();
    if (typing(e)) (e.target as HTMLElement).blur();
    return;
  }
  // Enter finishes typing a value and hands the keys back to the keyboard
  if (e.key === 'Enter' && typing(e)) {
    (e.target as HTMLElement).blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || e.repeat) return;
  const offset = KEYS[e.key.toLowerCase()];
  if (offset === undefined) return;
  e.preventDefault();
  void noteOn(Math.min(94, test.octave * 12 + offset));
});
window.addEventListener('keyup', (e) => {
  const offset = KEYS[e.key.toLowerCase()];
  if (offset !== undefined) noteOff(Math.min(94, test.octave * 12 + offset));
});
window.addEventListener('blur', () => noteOff());
document.addEventListener('visibilitychange', () => document.hidden && silence());

$('octave-down').addEventListener('click', () => {
  test.octave = Math.max(0, test.octave - 1);
  renderKeyboard();
});
$('octave-up').addEventListener('click', () => {
  test.octave = Math.min(6, test.octave + 1);
  renderKeyboard();
});

// Dragging the envelope reshapes the graph as it goes; letting go plays it
const drawAdsr = adsrEditor(
  $('adsr'),
  (): Env => {
    const ins = instrument();
    return ins ? { a: ins.ad >> 4, d: ins.ad & 15, s: ins.sr >> 4, r: ins.sr & 15 } : { a: 0, d: 0, s: 0, r: 0 };
  },
  (key, v) => {
    const ins = instrument();
    if (!ins) return;
    before();
    if (key === 'a') ins.ad = (v << 4) | (ins.ad & 15);
    else if (key === 'd') ins.ad = (ins.ad & 0xf0) | v;
    else if (key === 's') ins.sr = (v << 4) | (ins.sr & 15);
    else ins.sr = (ins.sr & 0xf0) | v;
    schedulePreview();
    persist();
  },
  () => blip(),
);

// The chip is a setting for the whole app, shared with the song player
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

// --- Page controls --------------------------------------------------------

for (const b of $('kinds').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    state.kind = Number(b.dataset.kind);
    liveStep = -1;
    persist();
    renderAll();
    schedulePreview();
  });
}

for (const b of $('span').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    test.frames[state.kind] = Number(b.dataset.frames);
    for (const o of $('span').querySelectorAll('button')) o.classList.toggle('on', o === b);
    persist();
    schedulePreview();
  });
}

$<HTMLSelectElement>('new-program').addEventListener('change', (e) => {
  const select = e.target as HTMLSelectElement;
  const value = select.value;
  select.value = '';
  if (!value) return;
  if (value === 'empty') {
    // A filter program starts by setting the filter up, with its cutoff
    const steps = state.kind === FILTER ? [filterStep({ type: 'setup', passband: FILTER_LOW, resonance: 8, voices: 1 }), filterStep({ type: 'cutoff', cutoff: 0x80 })] : [defaultStep(state.kind)];
    addProgram({ name: `${KIND_NAMES[state.kind]} ${programs().length + 1}`, steps, next: null });
  }
  else addProgram(programFromPreset(PRESETS[state.kind][Number(value)]));
  blip();
});

$<HTMLInputElement>('program-name').addEventListener('input', (e) => {
  const p = current();
  if (!p) return;
  before();
  p.name = (e.target as HTMLInputElement).value;
  renderPrograms();
  renderNext();
  renderInstrument();
  persist();
});

$('duplicate').addEventListener('click', copyProgram);
$('delete').addEventListener('click', deleteProgram);

$<HTMLSelectElement>('instrument').addEventListener('change', (e) => {
  state.current = Number((e.target as HTMLSelectElement).value);
  persist();
  renderAll();
  schedulePreview();
});

// Renaming swaps the menu for a text field until Enter or leaving it
{
  const select = $<HTMLSelectElement>('instrument');
  const input = $<HTMLInputElement>('instrument-name');
  const finish = () => {
    if (input.hidden) return;
    input.hidden = true;
    select.hidden = false;
    const ins = instrument();
    if (ins && input.value.trim() !== ins.name) {
      before();
      ins.name = input.value.trim();
      changed(true);
    }
  };
  $('rename-instrument').addEventListener('click', () => {
    const ins = instrument();
    if (!ins) return;
    input.value = ins.name;
    select.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  });
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') input.value = instrument()?.name ?? '';
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  });
}

$('new-instrument').addEventListener('click', addInstrument);
$('duplicate-instrument').addEventListener('click', duplicateInstrument);
$('delete-instrument').addEventListener('click', deleteInstrument);

$('add-step').addEventListener('click', () => {
  const p = current();
  if (!p) return;
  const last = p.steps[p.steps.length - 1];
  insertStep(p.steps.length, last ? { ...last } : defaultStep(state.kind));
});

$<HTMLSelectElement>('next').addEventListener('change', (e) => {
  const p = current();
  const value = (e.target as HTMLSelectElement).value;
  if (!p || value === 'other') return;
  before();
  p.next = value === 'stop' ? null : { program: p, step: Number(value.split(':')[1]) };
  changed(true);
});

// --- Loading a song's instruments ----------------------------------------------

async function loadSong(bytes: ArrayBuffer, label: string) {
  if (!analyzer) return;
  const canonical = analyzer.load(bytes);
  if (!canonical) {
    toast(`${label} isn't a GoatTracker song`);
    return;
  }
  const song = parseSong(canonical);
  before();
  const splits = KINDS.map((k) => splitTable(song.tables[k], k));
  const instruments: InstrumentDef[] = [];
  song.instruments.forEach((ins, num) => {
    const targets = KINDS.map((k) => (ins.tables[k] ? splits[k].target(ins.tables[k]) : null));
    // Slot 0 is unused, and empty slots have nothing to show
    if (!num || (!ins.name && !ins.ad && !ins.sr && !targets.some(Boolean))) return;
    const { name, ad, sr, vibratoDelay, gateTimer, firstWave } = ins;
    instruments.push({ num, name, ad, sr, vibratoDelay, gateTimer, firstWave, speed: ins.tables[3], targets });
    // Name programs after the first instrument that starts them
    targets.forEach((t) => {
      if (t && t.step === 0 && name && /^(Wave|Pulse|Filter) \d+$/.test(t.program.name)) t.program.name = name;
    });
  });
  state = {
    programs: splits.map((s) => s.programs),
    speed: song.tables[3],
    instruments,
    source: `From “${song.title || label}”${song.author ? ` by ${song.author}` : ''}. Changes here don’t touch the song file.`,
    kind: state.kind,
    current: 0,
  };
  persist();
  renderAll();
  schedulePreview();
  toast(`Loaded ${instruments.length} instruments from ${song.title || label}`);
}

const examples = $<HTMLSelectElement>('examples');
fetch(`${import.meta.env.BASE_URL}examples/index.json`)
  .then((r) => r.json())
  .then((list: { file: string; title: string; author: string }[]) => {
    for (const ex of list) examples.append(new Option(ex.author ? `${ex.title} — ${ex.author}` : ex.title, ex.file));
  })
  .catch(() => {});
examples.addEventListener('change', async () => {
  const file = examples.value;
  examples.value = '';
  if (!file) return;
  const response = await fetch(`${import.meta.env.BASE_URL}examples/${file}`);
  await loadSong(await response.arrayBuffer(), file);
});
$('open').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await loadSong(await file.arrayBuffer(), file.name);
});

let toastTimer = 0;
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 3200);
}

// --- Start ----------------------------------------------------------------

load();
renderAll();
renderKeyboard();
Analyzer.create()
  .then((a) => {
    analyzer = a;
    schedulePreview();
  })
  .catch((err) => toast(`Engine failed to start: ${err}`));

// For scripts/browsertest.mjs
Object.assign(window, {
  instrumentMaker: {
    state: () => state,
    loadSong,
    trace: () => trace,
    frameSteps,
    ready: () => analyzer !== null && trace !== null,
    idle: () => !previewPending,
    status: () => lastStatus,
  },
});
