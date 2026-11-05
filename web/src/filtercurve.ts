// A picture of the SID filter's response: which frequencies get through for
// a mode (low, band, high pass and their mixes), cutoff and resonance. The
// handle sits on the cutoff: drag it sideways to move the cutoff, up and
// down for resonance. The real chip (the 6581 especially) is less regular
// than this, so it is a guide to the shape, not a measurement.

import { FILTER_BAND, FILTER_HIGH, FILTER_LOW } from './tables';

const SVG = 'http://www.w3.org/2000/svg';
const W = 280;
const H = 96;
const PAD = 10;
/** Cutoff steps per octave on the drawing's frequency axis */
const PER_OCTAVE = 32;
/** Loudest and quietest levels drawn, in dB */
const TOP_DB = 15;
const FLOOR_DB = -30;
/** Pixels of drag for a step of resonance */
const STEP_Y = 5;

export interface FilterShape {
  passband: number;
  resonance: number;
  /** Null when the step leaves the cutoff as it was */
  cutoff: number | null;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** How sharp the peak is for a resonance setting (0-15). */
function q(resonance: number): number {
  return 0.7 + resonance * 0.25;
}

/**
 * The level (dB) at a frequency `ratio` times the cutoff, for a two-pole
 * filter whose low, band and high pass outputs are added as the mode says.
 */
export function response(passband: number, resonance: number, ratio: number): number {
  const w = ratio;
  const k = 1 / q(resonance);
  // Each output over the shared denominator 1 - w² + j·w·k. Band pass is
  // scaled so resonance lifts its peak as it does the others'
  let re = 0;
  let im = 0;
  if (passband & FILTER_LOW) re += 1;
  if (passband & FILTER_BAND) im += w;
  if (passband & FILTER_HIGH) re -= w * w;
  const dRe = 1 - w * w;
  const dIm = w * k;
  const mag = Math.hypot(re, im) / Math.hypot(dRe, dIm);
  return mag > 0 ? 20 * Math.log10(mag) : -Infinity;
}

const x = (cutoff: number) => PAD + (cutoff / 255) * (W - 2 * PAD);
const toCutoff = (px: number) => Math.round(((px - PAD) / (W - 2 * PAD)) * 255);
const y = (db: number) => PAD + ((TOP_DB - Math.max(FLOOR_DB, Math.min(TOP_DB, db))) / (TOP_DB - FLOOR_DB)) * (H - 2 * PAD);

/** The response as an SVG path over the width, for a cutoff (a mid one if unknown). */
function curvePath(shape: FilterShape, width = W, height = H, pad = PAD): string {
  const c = shape.cutoff ?? 128;
  const pts: string[] = [];
  for (let px = pad; px <= width - pad; px += 2) {
    const at = ((px - pad) / (width - 2 * pad)) * 255;
    const db = shape.passband ? response(shape.passband, shape.resonance, 2 ** ((at - c) / PER_OCTAVE)) : -Infinity;
    const py = pad + ((TOP_DB - Math.max(FLOOR_DB, Math.min(TOP_DB, db))) / (TOP_DB - FLOOR_DB)) * (height - 2 * pad);
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return `M${pts.join(' L')}`;
}

/** A small picture of a mode's curve, for its button. */
export function modeIcon(passband: number, w = 26, h = 14): SVGSVGElement {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true', class: 'mode-icon' });
  svg.append(el('path', { d: curvePath({ passband, resonance: 6, cutoff: 128 }, w, h, 1), fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
  return svg;
}

export interface CurveOptions {
  get: () => FilterShape;
  /** Called while dragging; resonance is only offered when `resonance` is set */
  change: (next: { cutoff?: number; resonance?: number }) => void;
  done: () => void;
  /** Whether resonance can be dragged (not on a step that only sets the cutoff) */
  resonance: boolean;
  /** Drawn faded: the shape comes from an earlier step */
  borrowed?: boolean;
}

export function filterCurve(o: CurveOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'filter-curve';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'filter-graph' });
  const zero = el('line', { x1: PAD, x2: W - PAD, y1: y(0), y2: y(0), class: 'filter-zero' });
  const area = el('path', { class: 'filter-area' });
  const line = el('path', { class: 'filter-line' });
  const mark = el('line', { class: 'filter-mark', y1: 4, y2: H - 4 });
  const dark = el('text', { x: PAD, y: H - 2, class: 'filter-axis' });
  dark.textContent = 'dark';
  const bright = el('text', { x: W - PAD, y: H - 2, class: 'filter-axis end' });
  bright.textContent = 'bright';
  const handle = el('g', { class: 'filter-handle', tabindex: 0, role: 'slider' });
  handle.setAttribute('aria-label', o.resonance ? 'Cutoff (sideways) and resonance (up and down)' : 'Cutoff');
  const title = el('title');
  title.textContent = o.resonance ? 'Drag sideways for the cutoff, up and down for resonance' : 'Drag sideways for the cutoff';
  handle.append(title, el('circle', { r: 13, class: 'hit' }), el('circle', { r: 6, class: 'dot' }));
  const arrow = 'M0,-4 L4,0 L0,4 Z';
  for (const turn of o.resonance ? [0, 90, 180, 270] : [0, 180]) handle.append(el('path', { d: arrow, class: 'arrow', transform: `rotate(${turn}) translate(11,0)` }));
  svg.append(zero, area, line, mark, dark, bright, handle);
  svg.classList.toggle('borrowed', !!o.borrowed);

  const readout = document.createElement('div');
  readout.className = 'filter-readout';

  function draw() {
    const s = o.get();
    const d = curvePath(s);
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`);
    const known = s.cutoff !== null;
    const c = s.cutoff ?? 128;
    mark.setAttribute('x1', String(x(c)));
    mark.setAttribute('x2', String(x(c)));
    mark.classList.toggle('unknown', !known);
    const peak = 20 * Math.log10(q(s.resonance));
    handle.setAttribute('transform', `translate(${x(c)},${y(o.resonance ? peak : 0)})`);
    handle.classList.toggle('unknown', !known);
    readout.textContent = `${known ? `Cutoff ${c}` : 'Cutoff unchanged'}${o.resonance ? ` · Resonance ${s.resonance}` : ''}`;
  }

  let startY = 0;
  let fromRes = 0;
  let left = 0;
  let scale = 1;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.focus();
    handle.classList.add('active');
    const box = svg.getBoundingClientRect();
    left = box.left;
    scale = W / box.width;
    startY = e.clientY;
    fromRes = o.get().resonance;
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const s = o.get();
    const cutoff = Math.max(0, Math.min(255, toCutoff((e.clientX - left) * scale)));
    const next: { cutoff?: number; resonance?: number } = {};
    if (cutoff !== s.cutoff) next.cutoff = cutoff;
    if (o.resonance) {
      const res = Math.max(0, Math.min(15, fromRes + Math.round((startY - e.clientY) / STEP_Y)));
      if (res !== s.resonance) next.resonance = res;
    }
    if (next.cutoff !== undefined || next.resonance !== undefined) {
      o.change(next);
      draw();
    }
  });
  const end = (e: PointerEvent) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('active');
    o.done();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    const s = o.get();
    const big = e.shiftKey ? 16 : 1;
    let next: { cutoff?: number; resonance?: number } | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      next = { cutoff: Math.max(0, Math.min(255, (s.cutoff ?? 128) + (e.key === 'ArrowRight' ? big : -big))) };
    } else if (o.resonance && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      next = { resonance: Math.max(0, Math.min(15, s.resonance + (e.key === 'ArrowUp' ? 1 : -1))) };
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    o.change(next);
    draw();
    o.done();
  });

  draw();
  wrap.append(svg, readout);
  return wrap;
}

/**
 * A wide picture of the filter's response at one moment, to follow a note
 * as it plays: which frequencies get through, where the cutoff is, and how
 * much it rings. `set` redraws it for a moment's type, cutoff and resonance.
 */
export function filterScope(w = 420, h = 120): { el: HTMLElement; set: (shape: FilterShape) => void } {
  const wrap = document.createElement('div');
  wrap.className = 'filter-scope';
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'filter-graph' });
  const pad = 10;
  const yy = (db: number) => pad + ((TOP_DB - Math.max(FLOOR_DB, Math.min(TOP_DB, db))) / (TOP_DB - FLOOR_DB)) * (h - 2 * pad);
  const zero = el('line', { x1: pad, x2: w - pad, y1: yy(0), y2: yy(0), class: 'filter-zero' });
  const area = el('path', { class: 'filter-area' });
  const line = el('path', { class: 'filter-line' });
  const mark = el('line', { class: 'filter-mark', y1: 4, y2: h - 4 });
  const dark = el('text', { x: pad, y: h - 2, class: 'filter-axis' });
  dark.textContent = 'low';
  const bright = el('text', { x: w - pad, y: h - 2, class: 'filter-axis end' });
  bright.textContent = 'high';
  svg.append(zero, area, line, mark, dark, bright);
  const readout = document.createElement('div');
  readout.className = 'filter-readout';
  const names: [number, string][] = [
    [FILTER_LOW, 'Low'],
    [FILTER_BAND, 'Band'],
    [FILTER_HIGH, 'High'],
  ];
  const set = (shape: FilterShape) => {
    // A negative passband: the voice goes past the filter, all of it heard
    if (shape.passband < 0) {
      const flat = `M${pad},${yy(0)} L${w - pad},${yy(0)}`;
      line.setAttribute('d', flat);
      area.setAttribute('d', `${flat} L${w - pad},${h - pad} L${pad},${h - pad} Z`);
      mark.style.display = 'none';
      readout.textContent = 'Not filtered here';
      return;
    }
    const d = curvePath(shape, w, h, pad);
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L${w - pad},${h - pad} L${pad},${h - pad} Z`);
    const cx = pad + ((shape.cutoff ?? 128) / 255) * (w - 2 * pad);
    mark.style.display = '';
    mark.setAttribute('x1', String(cx));
    mark.setAttribute('x2', String(cx));
    const type = names.filter(([bit]) => shape.passband & bit).map(([, n]) => n).join(' + ') || 'None (silent)';
    readout.textContent = `${type} · cutoff ${shape.cutoff ?? '?'} · resonance ${shape.resonance}`;
  };
  wrap.append(svg, readout);
  return { el: wrap, set };
}
