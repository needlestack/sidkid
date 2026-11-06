// Small pictures of SID waveforms, including the mixes the chip makes when
// several are switched on at once.

import { WAVE_NOISE, WAVE_PULSE, WAVE_SAW, WAVE_TRI } from './tables';

const SVG = 'http://www.w3.org/2000/svg';
const POINTS = 96;
const CYCLES = 2;

// A fixed run of noise values, so the picture doesn't change on redraw
const NOISE = Array.from({ length: 16 }, (_, i) => ((i * 2654435761) >>> 20) & 0xfff);

/**
 * One 12-bit sample of the oscillator output for a phase (0-1). Mixes are
 * the bitwise AND of the waveforms, as Commodore's datasheet describes
 * them; real chips differ (and the 6581 from the 8580), so this is a
 * sketch of the shape, not the sound.
 */
function sample(wave: number, phase: number, cycle: number, width = 0.5): number {
  let out = 0xfff;
  if (wave & WAVE_TRI) out &= Math.round((phase < 0.5 ? phase * 2 : 2 - phase * 2) * 0xfff);
  if (wave & WAVE_SAW) out &= Math.round(phase * 0xfff);
  if (wave & WAVE_PULSE) out &= phase < width ? 0xfff : 0;
  if (wave & WAVE_NOISE) out &= NOISE[(cycle * 8 + Math.floor(phase * 8)) % NOISE.length];
  return wave & 0xf0 ? out : 0x800;
}

/** An SVG of a waveform value's oscillators, w × h, drawn in currentColor. */
export function waveIcon(wave: number, w = 34, h = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wave-icon');
  const points: string[] = [];
  for (let i = 0; i <= POINTS; i++) {
    const t = (i / POINTS) * CYCLES;
    const cycle = Math.floor(t);
    const phase = t - cycle;
    const x = (i / POINTS) * (w - 2) + 1;
    const y = 1.5 + (1 - sample(wave, phase === 0 && i ? 1 : phase, cycle) / 0xfff) * (h - 3);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return svg;
}

/**
 * Points for a waveform repeated along a strip w × h from (x, y), one cycle
 * every `period` pixels, for an SVG polyline; `width` gives the pulse width
 * (0-1) at a point along it, for pulse that changes.
 */
export function waveRun(wave: number, x: number, y: number, w: number, h: number, period: number, width?: (px: number) => number): string {
  const steps = 16;
  const points: string[] = [];
  for (let c = 0; c * period < w; c++) {
    // Pulse width (0-1) for this cycle: how much of it the pulse is high,
    // with its edge drawn exactly where it falls
    const pw = width ? Math.max(0, Math.min(1, width(x + c * period))) : 0.5;
    const phases = Array.from({ length: steps + 1 }, (_, k) => k / steps);
    if (wave & WAVE_PULSE) phases.push(pw - 1e-6, pw);
    phases.sort((a, b) => a - b);
    for (const phase of phases) {
      if (phase < 0 || phase > 1 || (c > 0 && phase === 0)) continue;
      const px = x + (c + phase) * period;
      if (px > x + w) break;
      const py = y + (1 - sample(wave, phase, c, pw) / 0xfff) * h;
      points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
  }
  return points.join(' ');
}
