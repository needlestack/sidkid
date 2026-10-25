// A small picture of the volume envelope with handles to drag: attack,
// decay and release sideways (they are times), sustain up and down (it is
// a level). Each handle moves a whole step per few pixels, so the picture
// can stay small and still reach all 16 settings precisely.

export interface Env {
  a: number;
  d: number;
  s: number;
  r: number;
}

type Key = keyof Env;

/** How long each attack setting takes to reach full volume, in ms (from the SID datasheet). */
export const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
/** How long each decay or release setting takes to fall all the way, in ms. */
export const DECAY_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];

const SVG = 'http://www.w3.org/2000/svg';
const W = 240;
const H = 64;
const PAD = 8;
const HOLD = 36;
/** Pixels of drag for one step of a time, and of the sustain level */
const STEP_X = 8;
const STEP_Y = 4;

const NAMES: Record<Key, string> = { a: 'Attack', d: 'Decay', s: 'Sustain', r: 'Release' };
const HINTS: Record<Key, string> = {
  a: 'Attack: how fast the note rises to full volume. Drag sideways.',
  d: 'Decay: how fast it then falls to the sustain level. Drag sideways.',
  s: 'Sustain: the volume held while the key is down. Drag up or down.',
  r: 'Release: how fast it fades after the key goes up. Drag sideways.',
};

function time(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

export function describe(key: Key, v: number): string {
  if (key === 's') return `${Math.round((v / 15) * 100)}%`;
  return time((key === 'a' ? ATTACK_MS : DECAY_MS)[v]);
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Builds the editor into `host`. `change` runs as a value changes during a
 * drag or key press; `done` once the drag or key press is over.
 */
export function adsrEditor(host: HTMLElement, env: () => Env, change: (key: Key, v: number) => void, done: () => void): () => void {
  host.classList.add('adsr');
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'adsr-graph' });
  const area = el('path', { class: 'adsr-area' });
  const line = el('path', { class: 'adsr-line' });
  const keyUp = el('line', { class: 'adsr-keyup', y1: 3, y2: H - 3 });
  const keyUpText = el('text', { class: 'adsr-keyup-text', y: 9 });
  keyUpText.textContent = 'key up';
  svg.append(area, line, keyUp, keyUpText);
  const readout = document.createElement('div');
  readout.className = 'adsr-readout';
  const parts = {} as Record<Key, HTMLSpanElement>;
  for (const key of ['a', 'd', 's', 'r'] as Key[]) {
    const part = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = NAMES[key];
    parts[key] = document.createElement('span');
    parts[key].className = 'value';
    part.append(name, parts[key]);
    readout.append(part);
  }

  const handles = {} as Record<Key, SVGGElement>;
  let active: Key | null = null;
  let hover: Key | null = null;
  for (const key of ['a', 'd', 's', 'r'] as Key[]) {
    const g = el('g', { class: `adsr-handle ${key === 's' ? 'vertical' : 'horizontal'}`, tabindex: 0, role: 'slider' });
    g.setAttribute('aria-label', NAMES[key]);
    g.setAttribute('aria-valuemin', '0');
    g.setAttribute('aria-valuemax', '15');
    const title = el('title');
    title.textContent = HINTS[key];
    g.append(title, el('circle', { r: 13, class: 'hit' }), el('circle', { r: 5.5, class: 'dot' }));
    // Arrows on either side, pointing the ways the handle can be dragged
    const arrow = 'M0,-4 L4,0 L0,4 Z';
    for (const turn of key === 's' ? [-90, 90] : [0, 180]) g.append(el('path', { d: arrow, class: 'arrow', transform: `rotate(${turn}) translate(10,0)` }));
    g.addEventListener('pointerenter', () => ((hover = key), draw()));
    g.addEventListener('pointerleave', () => ((hover = null), draw()));
    handles[key] = g;
    svg.append(g);

    let start = 0;
    let from = 0;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.focus();
      active = key;
      start = key === 's' ? e.clientY : e.clientX;
      from = env()[key];
      draw();
    });
    g.addEventListener('pointermove', (e) => {
      if (active !== key || !g.hasPointerCapture(e.pointerId)) return;
      const moved = key === 's' ? (start - e.clientY) / STEP_Y : (e.clientX - start) / STEP_X;
      set(key, from + Math.round(moved));
    });
    const end = (e: PointerEvent) => {
      if (active !== key || !g.hasPointerCapture(e.pointerId)) return;
      g.releasePointerCapture(e.pointerId);
      active = null;
      draw();
      done();
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('keydown', (e) => {
      const up = key === 's' ? ['ArrowUp', 'ArrowRight'] : ['ArrowRight', 'ArrowUp'];
      const down = key === 's' ? ['ArrowDown', 'ArrowLeft'] : ['ArrowLeft', 'ArrowDown'];
      const by = up.includes(e.key) ? 1 : down.includes(e.key) ? -1 : 0;
      if (!by) return;
      e.preventDefault();
      e.stopPropagation();
      if (set(key, env()[key] + by)) done();
    });
    g.addEventListener('focus', () => draw());
    g.addEventListener('blur', () => draw());
  }

  function set(key: Key, v: number): boolean {
    const value = Math.max(0, Math.min(15, v));
    if (value === env()[key]) return false;
    change(key, value);
    draw();
    return true;
  }

  function draw() {
    const e = env();
    const seg = (v: number) => 8 + v * 3.5;
    // Room above full volume for the key-up label
    const top = 18;
    const bottom = H - PAD;
    const ys = bottom - (e.s / 15) * (bottom - top);
    const x0 = PAD;
    const xa = x0 + seg(e.a);
    const xd = xa + seg(e.d);
    const xs = xd + HOLD;
    const xr = xs + seg(e.r);
    const shape = `M${x0},${bottom} L${xa},${top} L${xd},${ys} L${xs},${ys} L${xr},${bottom}`;
    line.setAttribute('d', shape);
    area.setAttribute('d', `${shape} Z`);
    keyUp.setAttribute('x1', String(xs));
    keyUp.setAttribute('x2', String(xs));
    keyUpText.setAttribute('x', String(xs + 4));
    const at: Record<Key, [number, number]> = { a: [xa, top], d: [xd, ys], s: [(xd + xs) / 2, ys], r: [xr, bottom] };
    const focused = (Object.keys(handles) as Key[]).find((k) => handles[k] === document.activeElement) ?? null;
    for (const key of Object.keys(handles) as Key[]) {
      const [x, y] = at[key];
      const g = handles[key];
      g.setAttribute('transform', `translate(${x},${y})`);
      g.setAttribute('aria-valuenow', String(e[key]));
      g.setAttribute('aria-valuetext', `${e[key]} (${describe(key, e[key])})`);
      g.classList.toggle('active', key === active);
      parts[key].textContent = describe(key, e[key]);
      parts[key].parentElement!.classList.toggle('on', key === (active ?? hover ?? focused));
    }
  }

  host.replaceChildren(svg, readout);
  draw();
  return draw;
}
