// The table maker: edit wave, pulse and filter programs, see what they do
// frame by frame, and play them on a test keyboard.

import './style.css';
import './tablemaker.css';
import { Analyzer, type Trace } from './engine/analyzer';
import type { TableData } from './engine/configure';
import { loadModel, Player, saveModel } from './engine/player';
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
  waveStorable,
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
const STORAGE_KEY = 'sidkid.tables.v1';
const TEST_INSTRUMENT = 1;
const TEST_GATE_TIMER = 2;

// --- State ----------------------------------------------------------------

/** An instrument of the loaded song, pointing at steps of these programs. */
interface SongInstrument {
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
  instruments: SongInstrument[];
  source: string;
  kind: number;
  selected: number[];
}

// Programs the test sound can use when the one being edited is of another
// kind; they are laid out after the real ones, for trying out only
const BUILTIN: Program[][] = [
  [
    { name: 'Pulse', steps: [{ left: 0x41, right: 0x00 }], next: null },
    { name: 'Saw', steps: [{ left: 0x21, right: 0x00 }], next: null },
    { name: 'Triangle', steps: [{ left: 0x11, right: 0x00 }], next: null },
  ],
  [{ name: '50%', steps: [{ left: 0x88, right: 0x00 }], next: null }],
  [],
];

/** What plays with the program being edited: a program, or null for none. */
type TestSound = (Program | null)[];

const test = {
  octave: 3,
  note: 48,
  env: { a: 0, d: 9, s: 12, r: 8 },
  // Per tab being edited, the other kinds' choices
  sounds: [
    [null, BUILTIN[PULSE][0], null],
    [BUILTIN[WAVE][0], null, null],
    [BUILTIN[WAVE][1], BUILTIN[PULSE][0], null],
  ] as TestSound[],
  frames: [50, 200, 200],
  /** Play as this song instrument instead of the test sound. */
  like: null as SongInstrument | null,
};

function insName(i: SongInstrument) {
  return i.name || `instrument ${i.num}`;
}

/** Picks the song instrument a program is heard with by default. */
function resetLike() {
  const p = current();
  test.like = p ? (usersOf(p)[0] ?? null) : null;
}

let state: State = initialState();

function initialState(): State {
  const pick = (kind: number, names: string[]) => names.map((n) => programFromPreset(PRESETS[kind].find((p) => p.name === n)!));
  return {
    programs: [pick(WAVE, ['Saw', 'Flute', 'Major arpeggio']), pick(PULSE, ['Square', 'Slow sweep']), pick(FILTER, ['Low pass', 'Wah sweep'])],
    speed: { left: new Uint8Array(0), right: new Uint8Array(0) },
    instruments: [],
    source: '',
    kind: WAVE,
    selected: [0, 0, 0],
  };
}

const programs = () => state.programs[state.kind];
const usersOf = (p: Program, kind = state.kind) => state.instruments.filter((i) => i.targets[kind]?.program === p);
const current = (): Program | undefined => programs()[state.selected[state.kind]];

// --- Saving, undo ---------------------------------------------------------

interface Saved {
  programs: { name: string; steps: [number, number][]; next: [number, number] | null }[][];
  speed: [number[], number[]];
  instruments: (Omit<SongInstrument, 'targets'> & { targets: ([number, number] | null)[] })[];
  source: string;
  kind: number;
  selected: number[];
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
    selected: [...s.selected],
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
  return {
    programs: lists,
    speed: { left: Uint8Array.from(d.speed[0]), right: Uint8Array.from(d.speed[1]) },
    instruments: (d.instruments ?? []).map((i) => ({
      ...i,
      targets: i.targets.map((t, k) => (t && lists[k][t[0]] ? { program: lists[k][t[0]], step: t[1] } : null)),
    })),
    source: d.source,
    kind: d.kind,
    selected: d.selected,
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
  resetLike();
  renderAll();
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

function insertStep(at: number, step: Step) {
  const p = current()!;
  before();
  p.steps.splice(at, 0, step);
  remap(state.kind, p, (i) => (i >= at ? i + 1 : i));
  changed(true);
}

function removeStep(at: number) {
  const p = current()!;
  before();
  p.steps.splice(at, 1);
  // References to the removed step move on to the one after it
  remap(state.kind, p, (i) => (i > at ? i - 1 : i));
  changed(true);
}

function moveStep(from: number, to: number) {
  const p = current()!;
  if (to < 0 || to >= p.steps.length) return;
  before();
  const [s] = p.steps.splice(from, 1);
  p.steps.splice(to, 0, s);
  remap(state.kind, p, (i) => {
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (from > to && i >= to && i < from) return i + 1;
    return i;
  });
  changed(true);
}

function addProgram(p: Program) {
  before();
  programs().push(p);
  state.selected[state.kind] = programs().length - 1;
  resetLike();
  changed(true);
}

function deleteProgram() {
  const p = current();
  if (!p) return;
  const users = usersOf(p);
  if (users.length && !confirm(`“${p.name}” is used by ${users.map(insName).join(', ')}. Delete it anyway?`)) return;
  before();
  const list = programs();
  list.splice(list.indexOf(p), 1);
  for (const o of list) if (o.next?.program === p) o.next = null;
  for (const ins of users) ins.targets[state.kind] = null;
  for (const sound of test.sounds) sound.forEach((s, k) => s === p && (sound[k] = null));
  state.selected[state.kind] = Math.min(state.selected[state.kind], list.length - 1);
  changed(true);
}

function duplicateProgram() {
  const p = current();
  if (!p) return;
  const copy: Program = { name: `${p.name} copy`, steps: p.steps.map((s) => ({ ...s })), next: null };
  if (p.next) copy.next = p.next.program === p ? { program: copy, step: p.next.step } : { ...p.next };
  addProgram(copy);
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

function sound(): TestSound {
  const s = [...test.sounds[state.kind]];
  s[state.kind] = current() ?? null;
  return s;
}

function audition(): Audition {
  const s = sound();
  const lists = KINDS.map((k) => {
    const list = [...state.programs[k]];
    if (s[k] && !list.includes(s[k]!)) list.push(s[k]!);
    return list;
  });
  const layouts = lists.map(layOut);
  const pointer = (k: number) => {
    const p = s[k];
    return p && p.steps.length ? layouts[k].starts[lists[k].indexOf(p)] : 0;
  };
  const like = test.like;
  if (like) {
    const at = (k: number) => {
      const t = like.targets[k];
      const i = t ? lists[k].indexOf(t.program) : -1;
      return t && i >= 0 && t.step < t.program.steps.length ? layouts[k].starts[i] + t.step : 0;
    };
    return {
      lists,
      layouts,
      tables: [...layouts.map((l) => l.table), state.speed],
      instrument: { ...like, tables: [at(WAVE), at(PULSE), at(FILTER), like.speed] },
    };
  }
  const { a, d, s: sus, r } = test.env;
  return {
    lists,
    layouts,
    tables: [...layouts.map((l) => l.table), state.speed],
    instrument: {
      name: '',
      ad: (a << 4) | d,
      sr: (sus << 4) | r,
      tables: [pointer(WAVE), pointer(PULSE), pointer(FILTER), 0],
      vibratoDelay: 0,
      gateTimer: TEST_GATE_TIMER,
      firstWave: 0x09,
    },
  };
}

// --- Rendering: tabs and program list -------------------------------------

function renderAll() {
  for (const b of $('span').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.frames) === test.frames[state.kind]);
  renderKinds();
  renderPrograms();
  renderEditor();
  renderTestSound();
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

function renderPrograms() {
  const list = $('program-list');
  list.replaceChildren(
    ...programs().map((p, i) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'program-item';
      button.classList.toggle('on', i === state.selected[state.kind]);
      const name = document.createElement('span');
      name.className = 'program-name';
      name.textContent = p.name || 'Untitled';
      const meta = document.createElement('span');
      meta.className = 'program-meta';
      const users = usersOf(p).length;
      meta.textContent = [`${p.steps.length} step${p.steps.length === 1 ? '' : 's'}`, p.next ? (p.next.program === p ? 'loops' : 'jumps') : '', users ? `${users} instrument${users === 1 ? '' : 's'}` : '']
        .filter(Boolean)
        .join(' · ');
      button.append(name, meta);
      button.addEventListener('click', () => {
        state.selected[state.kind] = i;
        resetLike();
        persist();
        renderAll();
        schedulePreview();
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
  $('editor').hidden = !p;
  if (!p) return;
  const name = $<HTMLInputElement>('program-name');
  if (document.activeElement !== name) name.value = p.name;
  const users = usersOf(p);
  const uses = $('uses');
  uses.hidden = !users.length;
  uses.textContent = users.length
    ? `Used by ${users.map((i) => `${insName(i)}${i.targets[state.kind]!.step ? ` (from step ${i.targets[state.kind]!.step + 1})` : ''}`).join(', ')}`
    : '';
  renderSteps();
  renderNext();
}

function renderNext() {
  const p = current();
  if (!p) return;
  const select = $<HTMLSelectElement>('next');
  select.replaceChildren(new Option('Stop, keeping the sound as it is', 'stop'));
  p.steps.forEach((_, i) => select.append(new Option(i === 0 ? 'Loop back to the start' : `Loop back to step ${i + 1}`, `loop:${i}`)));
  if (p.next?.program === p && p.next.step === p.steps.length) {
    select.append(new Option('Jump onto its own end row (a GoatTracker quirk)', `loop:${p.steps.length}`));
  }
  if (p.next && p.next.program !== p) {
    const end = p.next.step === p.next.program.steps.length;
    select.append(new Option(`Go on to “${p.next.program.name}”, ${end ? 'its end row' : `step ${p.next.step + 1}`}`, 'other'));
  }
  select.value = !p.next ? 'stop' : p.next.program === p ? `loop:${p.next.step}` : 'other';
}

let hoverStep = -1;
let liveStep = -1;

function renderSteps() {
  const p = current()!;
  const list = $('steps');
  list.replaceChildren(...p.steps.map((s, i) => stepRow(p, s, i)));
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

function stepRow(p: Program, s: Step, i: number): HTMLLIElement {
  const kind = state.kind;
  const li = document.createElement('li');
  li.className = 'step';
  li.dataset.step = String(i);
  li.style.setProperty('--hue', String(stepHue(i)));
  li.classList.toggle('live', i === liveStep);

  const num = document.createElement('span');
  num.className = 'step-num';
  num.textContent = String(i + 1);
  const loopsHere = p.next?.program === p && p.next.step === i;
  if (loopsHere) {
    num.classList.add('loop-target');
    num.title = 'The program loops back to here';
  }

  const type = document.createElement('select');
  type.className = 'step-type';
  type.setAttribute('aria-label', `Step ${i + 1} type`);
  for (const [value, label] of STEP_TYPES[kind]) type.append(new Option(label, value));
  type.value = stepType(kind, s);
  type.addEventListener('change', () => {
    before();
    p.steps[i] = convertStep(kind, s, type.value);
    changed(true);
  });

  const fields = document.createElement('div');
  fields.className = 'step-fields';

  const text = document.createElement('span');
  text.className = 'step-text';
  const raw = document.createElement('code');
  raw.className = 'step-raw';
  raw.title = 'The GoatTracker table row: left and right bytes';
  const refresh = () => {
    const st = p.steps[i];
    text.textContent = describeStep(kind, st) + warning(kind, p, i);
    raw.textContent = `${hex(st.left)} ${hex(st.right)}`;
  };
  // Field edits change the step in place, so a slider being dragged stays put
  const update = (next: Step) => {
    before();
    p.steps[i] = next;
    refresh();
    changed(false);
  };
  stepFields(kind, s, fields, update, () => p.steps[i]);
  refresh();

  const tools = document.createElement('div');
  tools.className = 'step-tools';
  tools.append(
    toolButton('↑', 'Move up', () => moveStep(i, i - 1), i === 0),
    toolButton('↓', 'Move down', () => moveStep(i, i + 1), i === p.steps.length - 1),
    toolButton('⧉', 'Duplicate step', () => insertStep(i + 1, { ...p.steps[i] })),
    toolButton('×', 'Delete step', () => removeStep(i)),
  );

  const main = document.createElement('div');
  main.className = 'step-main';
  main.append(type, fields);
  const info = document.createElement('div');
  info.className = 'step-info';
  info.append(text, raw);
  li.append(num, main, info, tools);
  li.addEventListener('pointerenter', () => setHoverStep(i));
  li.addEventListener('pointerleave', () => setHoverStep(-1));
  return li;
}

function warning(kind: number, p: Program, i: number): string {
  if (kind === WAVE && i === 0) {
    const t = waveAction(p.steps[0]).type;
    if (t === 'keep' || t === 'wait') return ' — as a first step this can make notes go missing; start with Set waveform';
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
  else if (kind === PULSE) pulseFields(s, box, update, get);
  else filterFields(s, box, update, get);
}

function waveFields(s: Step, box: HTMLElement, update: Update, get: () => Step) {
  const a = waveAction(s);
  if (a.type === 'wave') {
    const osc = toggles(
      [
        [WAVE_TRI, 'Tri', 'Triangle: soft, flute-like', 'tri'],
        [WAVE_SAW, 'Saw', 'Sawtooth: bright and buzzy', 'saw'],
        [WAVE_PULSE, 'Pulse', 'Pulse: hollow to nasal, shaped by the pulse program', 'pulse'],
        [WAVE_NOISE, 'Noise', 'Noise: drums and effects', 'noise'],
      ],
      a.wave,
      (bits) => {
        const cur = waveAction(get());
        const wave = cur.type === 'wave' ? (cur.wave & 0x0f) | bits : bits | WAVE_GATE;
        return waveStorable(wave) ? (update({ ...get(), left: waveLeft({ type: 'wave', wave }) }), true) : false;
      },
      0xf0,
    );
    osc.title = 'Oscillators. Noise only mixes with triangle or saw.';
    const ctl = toggles(
      [
        [WAVE_GATE, 'Gate', 'On: the note sounds (attack, decay, sustain). Off: it fades out (release).', 'gate'],
        [WAVE_SYNC, 'Sync', 'Syncs to another voice (voice 3 for voice 1): needs that voice playing', ''],
        [WAVE_RING, 'Ring', 'Ring modulation by another voice (voice 3 for voice 1): needs that voice playing, best with triangle', ''],
        [WAVE_TEST, 'Test', 'Test bit: silences and resets the oscillator', ''],
      ],
      a.wave,
      (bits) => {
        const cur = waveAction(get());
        const wave = (cur.type === 'wave' ? cur.wave & 0xf0 : 0) | bits;
        update({ ...get(), left: waveLeft({ type: 'wave', wave }) });
        return true;
      },
      0x0f,
    );
    ctl.classList.add('minor');
    box.append(osc, ctl, pitchField(s, update, get));
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

function filterFields(s: Step, box: HTMLElement, update: Update, get: () => Step) {
  const a = filterAction(s);
  type Setup = { type: 'setup'; passband: number; resonance: number; voices: number };
  const setup = () => filterAction(get()) as Setup;
  if (a.type === 'setup') {
    box.append(
      toggles(
        [
          [FILTER_LOW, 'Low', 'Low pass: lets the bass through, muffles the highs', ''],
          [FILTER_BAND, 'Band', 'Band pass: keeps a band around the cutoff, nasal and thin', ''],
          [FILTER_HIGH, 'High', 'High pass: cuts the bass, keeps the fizz', ''],
        ],
        a.passband,
        (bits) => (update(filterStep({ ...setup(), passband: bits })), true),
        0x70,
      ),
      slider(a.resonance, 0, 15, (n) => `res ${n}`, (n) => update(filterStep({ ...setup(), resonance: n })), 'Resonance: how much the filter rings around the cutoff', 'short'),
      toggles(
        [
          [1, 'V1', 'Voice 1 goes through the filter (the test note plays on voice 1)', ''],
          [2, 'V2', 'Voice 2 goes through the filter', ''],
          [4, 'V3', 'Voice 3 goes through the filter', ''],
        ],
        a.voices,
        (bits) => (update(filterStep({ ...setup(), voices: bits })), true),
        0x07,
      ),
    );
  } else if (a.type === 'cutoff') {
    box.append(slider(a.cutoff, 0, 255, (n) => String(n), (n) => update(filterStep({ type: 'cutoff', cutoff: n })), 'Cutoff: low values are dark and muffled, high values bright'));
  } else {
    type Sweep = { type: 'sweep'; frames: number; speed: number };
    box.append(
      numberField('for', a.frames, 1, 127, 'frames', (n) => update(filterStep({ ...(filterAction(get()) as Sweep), frames: n })), 'How long the sweep lasts'),
      numberField('by', a.speed, -128, 127, 'a frame', (n) => update(filterStep({ ...(filterAction(get()) as Sweep), speed: n })), 'Change in cutoff each frame, out of 255. Negative closes the filter.'),
    );
  }
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

// --- Rendering: the test sound --------------------------------------------

function renderTestSound() {
  const s = test.sounds[state.kind];
  const p = current();
  const users = p ? usersOf(p) : [];
  if (test.like && !users.includes(test.like)) test.like = null;
  const like = $<HTMLSelectElement>('test-like');
  $('test-like-field').hidden = !users.length;
  like.replaceChildren(new Option('Test sound', ''), ...users.map((i) => new Option(`As in ${insName(i)}`, String(i.num))));
  like.value = test.like ? String(test.like.num) : '';
  like.onchange = () => {
    test.like = users.find((i) => String(i.num) === like.value) ?? null;
    renderTestSound();
    schedulePreview();
  };
  $('env-field').hidden = !!test.like;
  KINDS.forEach((k) => {
    const field = $(['test-wave-field', 'test-pulse-field', 'test-filter-field'][k]);
    const select = $<HTMLSelectElement>(['test-wave', 'test-pulse', 'test-filter'][k]);
    field.hidden = k === state.kind || !!test.like;
    if (k === state.kind) return;
    const options: [string, Program | null][] = [];
    if (k !== WAVE) options.push([k === PULSE ? 'None (width stays put)' : 'None', null]);
    state.programs[k].forEach((p) => options.push([p.name, p]));
    BUILTIN[k].forEach((p) => options.push([`${p.name} (built in)`, p]));
    select.replaceChildren(...options.map(([name], i) => new Option(name, String(i))));
    const at = options.findIndex(([, p]) => p === s[k]);
    select.value = String(at < 0 ? 0 : at);
    if (at < 0) s[k] = options[0][1];
    select.onchange = () => {
      s[k] = options[Number(select.value)][1];
      schedulePreview();
    };
  });
  for (const key of ['a', 'd', 's', 'r'] as const) $<HTMLInputElement>(`env-${key}`).value = test.env[key].toString(16).toUpperCase();
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
  });
}

interface Lane {
  name: string;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, y: number, h: number) => void;
}

const GUTTER = 64;
const AXIS = 18;
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
    out.push(at && list[at.program] === p ? at.step : -1);
  }
  return out;
}

function semitones(freq: number): number {
  // GoatTracker's PAL frequency table: A-4 (note 57) is 440 Hz
  const played = ((440 * 2 ** ((test.note - 57) / 12)) * 16777216) / 985248;
  return freq ? 12 * Math.log2(freq / played) : NaN;
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
        const yv = (v: number) => y + 24 + ((hi - v) / (hi - lo)) * (h - 30);
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
        for (let f = 0; f < frames; f++) {
          const v = semitones(t.freq[f]);
          if (!Number.isFinite(v)) continue;
          const sounding = (t.control[f] & 0xf0) !== 0 && !(t.control[f] & WAVE_TEST);
          ctx.strokeStyle = c.accent;
          ctx.globalAlpha = sounding ? 1 : 0.3;
          ctx.beginPath();
          ctx.moveTo(x(f) + 1, yv(v));
          ctx.lineTo(x(f + 1) - 1, yv(v));
          ctx.stroke();
          const prev = f > 0 ? semitones(t.freq[f - 1]) : NaN;
          if (Number.isFinite(prev) && Math.abs(prev - v) > 0.01) {
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x(f), yv(prev));
            ctx.lineTo(x(f), yv(v));
            ctx.stroke();
            ctx.lineWidth = 2.5;
          }
        }
        ctx.globalAlpha = 1;
      },
    });
    lanes.push({
      name: 'Wave',
      height: 34,
      draw(ctx, y, h) {
        for (let f = 0; f < frames; f++) {
          const w = t.control[f];
          const osc = [
            [WAVE_TRI, c.tri],
            [WAVE_SAW, c.saw],
            [WAVE_PULSE, c.pulse],
            [WAVE_NOISE, c.noise],
          ].filter(([bit]) => w & (bit as number));
          if (w & WAVE_TEST || !osc.length) continue;
          ctx.globalAlpha = w & WAVE_GATE ? 1 : 0.35;
          const bh = (h - 8) / osc.length;
          osc.forEach(([, color], i) => {
            ctx.fillStyle = color as string;
            ctx.fillRect(x(f) + 0.5, y + 4 + i * bh, Math.max(1, fw - 1), bh);
          });
        }
        ctx.globalAlpha = 1;
      },
    });
  }
  if (t && kind === PULSE) {
    lanes.push({
      name: 'Width',
      height: 150,
      draw(ctx, y, h) {
        const yv = (v: number) => y + 24 + (1 - v / 4096) * (h - 30);
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
        const yv = (v: number) => y + 24 + (1 - v / 255) * (h - 30);
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
  lanes.push({
    name: 'Step',
    height: 26,
    draw(ctx, y, h) {
      ctx.font = '600 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const list = traced?.lists[kind] ?? [];
      runs(frames, (f) => `${steps[f]}|${t ? t.pos[kind][f] : 0}|${steps[f] >= 0 ? '' : f}`, (from, to) => {
        const s = steps[from];
        if (s === -2) {
          if (from === 0 || steps[from - 1] !== -2) {
            ctx.fillStyle = c.muted;
            ctx.textAlign = 'left';
            clipText(ctx, kind === FILTER ? 'not running' : 'stopped: the sound holds', x(from) + 6, y + h / 2, width - x(from));
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
        const hue = stepHue(s);
        const on = hoverStep < 0 || hoverStep === s;
        ctx.fillStyle = `hsl(${hue} ${c.stepS} ${c.stepL})`;
        ctx.globalAlpha = on ? 1 : 0.35;
        ctx.fillRect(x(from) + 0.5, y + 3, Math.max(1, x(to) - x(from) - 1), h - 6);
        ctx.globalAlpha = 1;
        if (x(to) - x(from) >= 12) {
          ctx.fillStyle = c.text;
          ctx.fillText(String(s + 1), (x(from) + x(to)) / 2, y + h / 2);
        }
      });
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
  ctx.font = '600 12px system-ui';
  for (const lane of lanes) {
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
  const stepText = s >= 0 ? `Step ${s + 1}: ${describeStep(kind, p.steps[s])}` : s === -1 ? 'Running another program' : kind === FILTER ? 'Filter program not running' : 'Program stopped';
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
  return `<b>${head}</b><br>${escapeHtml(stepText)}<br>${escapeHtml(value)}`;
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
      hoverStep = s >= 0 ? s : -1;
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
    const row = $('steps').querySelector<HTMLElement>(`.step[data-step="${s}"]`);
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
  // Released already: still play it, briefly
  if (held !== note) player.noteOff(0);
  noteStart = performance.now();
  animate();
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
  if (player.started) player.noteOff(0);
  renderKeyboard();
}

let animating = false;
function animate() {
  if (animating) return;
  animating = true;
  const step = () => {
    const elapsed = (performance.now() - noteStart) / 1000 - player.latency;
    // The note sounds after the gate timer and a frame of setup
    const f = Math.floor(elapsed * FPS) - ((test.like ? test.like.gateTimer & 0x3f : TEST_GATE_TIMER) + 1);
    const was = playheadFrame;
    playheadFrame = held === null && f >= test.frames[state.kind] ? -1 : f;
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
    if (at && traced.lists[kind][at.program] === current()) step = at.step;
  }
  if (step === liveStep) return;
  liveStep = step;
  for (const row of $('steps').querySelectorAll<HTMLElement>('.step')) row.classList.toggle('live', Number(row.dataset.step) === step);
}

// Tracker keys: two rows of a piano, the lower octave on Z-M
const KEYS: Record<string, number> = {};
'zsxdcvgbhnjm'.split('').forEach((k, i) => (KEYS[k] = i));
',l.;/'.split('').forEach((k, i) => (KEYS[k] = 12 + i));
'q2w3er5t6y7ui9o0p'.split('').forEach((k, i) => (KEYS[k] = 12 + i));

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
  for (const key of board.querySelectorAll<HTMLElement>('.key')) {
    const n = base + Number(key.dataset.offset);
    key.classList.toggle('down', n === held);
    key.textContent = n % 12 === 0 ? noteName(n).replace('-', '') : '';
    key.setAttribute('aria-label', noteName(n));
  }
  $('octave-label').textContent = `${noteName(base).replace('-', '')}–${noteName(base + 24).replace('-', '')}`;
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

for (const key of ['a', 'd', 's', 'r'] as const) {
  const input = $<HTMLInputElement>(`env-${key}`);
  input.type = 'text';
  input.maxLength = 1;
  input.addEventListener('input', () => {
    if (!/^[0-9a-f]$/i.test(input.value)) return;
    test.env[key] = parseInt(input.value, 16);
    schedulePreview();
  });
  input.addEventListener('change', () => (input.value = test.env[key].toString(16).toUpperCase()));
}

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
    resetLike();
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
  if (value === 'empty') addProgram({ name: `${KIND_NAMES[state.kind]} ${programs().length + 1}`, steps: [defaultStep(state.kind)], next: null });
  else addProgram(programFromPreset(PRESETS[state.kind][Number(value)]));
});

$<HTMLInputElement>('program-name').addEventListener('input', (e) => {
  const p = current();
  if (!p) return;
  before();
  p.name = (e.target as HTMLInputElement).value;
  renderPrograms();
  renderNext();
  persist();
});

$('duplicate').addEventListener('click', duplicateProgram);
$('delete').addEventListener('click', deleteProgram);

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

// --- Loading a song's tables ----------------------------------------------

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
  const instruments: SongInstrument[] = [];
  song.instruments.forEach((ins, num) => {
    const targets = KINDS.map((k) => (ins.tables[k] ? splits[k].target(ins.tables[k]) : null));
    if (!num || !targets.some(Boolean)) return;
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
    source: `Tables from “${song.title || label}”${song.author ? ` by ${song.author}` : ''}. Changes here don’t touch the song file.`,
    kind: state.kind,
    selected: [0, 0, 0],
  };
  for (const s of test.sounds) KINDS.forEach((k) => s[k] && !BUILTIN[k].includes(s[k]!) && (s[k] = null));
  test.sounds[PULSE][WAVE] = BUILTIN[WAVE][0];
  test.sounds[FILTER][WAVE] = BUILTIN[WAVE][1];
  test.sounds[WAVE][PULSE] = test.sounds[FILTER][PULSE] = BUILTIN[PULSE][0];
  resetLike();
  persist();
  renderAll();
  schedulePreview();
  toast(`Loaded ${splits.reduce((n, s) => n + s.programs.length, 0)} programs from ${song.title || label}`);
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
resetLike();
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
  tableMaker: {
    state: () => state,
    loadSong,
    trace: () => trace,
    frameSteps,
    ready: () => analyzer !== null && trace !== null,
    idle: () => !previewPending,
    status: () => lastStatus,
  },
});
