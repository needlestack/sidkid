// The song views: an arrangement of sections and clips along time, and a
// step view of one section with every voice's notes.

import { describeCommand, noteName, type Song } from './song';
import { findAt, type Clip, type Event, type Section, type Timeline } from './timeline';

const LANE_GAP = 2;
const MIN_CLIP_WIDTH = 52;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.6;

/** Same pattern, same colour, wherever it is used. */
export function patternHue(pattern: number): number {
  return Math.round((pattern * 137.508) % 360);
}

/** Sections that repeat share a colour; one-offs stay neutral. */
function colorSection(e: HTMLElement, s: Section) {
  e.classList.toggle('once', s.color < 0);
  if (s.color >= 0) e.style.setProperty('--h', String(Math.round((s.color * 137.508 + 260) % 360)));
}

/** A run of clips of the same pattern, shown as one looped block. */
interface ClipRun {
  clips: Clip[];
  start: number;
  end: number;
  el: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function transposeLabel(t: number): string {
  return t > 0 ? `+${t}` : String(t);
}

// --- arrangement ---------------------------------------------------------------

export class ArrangementView {
  onSeek: (frame: number) => void = () => {};

  private timeline: Timeline | null = null;
  private fps = 50;
  private zoom = 1;
  private fitZoom = 1;
  private runs: ClipRun[][] = [[], [], []];
  private runByEl = new Map<Element, ClipRun>();
  private sectionEls: HTMLElement[] = [];
  private current: (HTMLElement | null)[] = [null, null, null, null];
  private followPausedUntil = 0;

  private readonly scroller: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly sectionLane: HTMLElement;
  private readonly lanes: HTMLElement[];
  private readonly labels: HTMLElement[];
  private readonly loop: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly follow: HTMLInputElement;

  constructor(root: HTMLElement) {
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.scroller = q('.arrange-scroll');
    this.inner = q('.arrange-inner');
    this.ruler = q('.ruler');
    this.sectionLane = q('.lane.sections');
    this.lanes = [0, 1, 2].map((v) => q(`.lane[data-voice="${v}"]`));
    this.labels = [0, 1, 2].map((v) => q(`.lane-label[data-voice="${v}"]`));
    this.loop = q('.loop');
    this.playhead = q('.playhead');
    this.follow = q('.follow input');

    q('.zoom-in').addEventListener('click', () => this.setZoom(this.zoom * ZOOM_STEP));
    q('.zoom-out').addEventListener('click', () => this.setZoom(this.zoom / ZOOM_STEP));
    q('.zoom-fit').addEventListener('click', () => this.setZoom(this.fitZoom));

    // Scrolling by hand pauses following for a moment
    const pause = () => (this.followPausedUntil = performance.now() + 2500);
    this.scroller.addEventListener('wheel', pause, { passive: true });
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroller) pause();
    });

    this.inner.addEventListener('click', (e) => {
      if (!this.timeline) return;
      const frame = Math.max(0, Math.min(this.timeline.length - 1, Math.round(this.frameAtX(e.clientX))));
      const target = (e.target as HTMLElement).closest<HTMLElement>('.section-block, .clip');
      const run = target && this.runByEl.get(target);
      if (run) {
        // Play from the start of whichever repeat was clicked
        this.onSeek([...run.clips].reverse().find((c) => c.start <= frame)?.start ?? run.start);
      } else if (target?.dataset.start) {
        this.onSeek(Number(target.dataset.start));
      } else {
        this.onSeek(frame);
      }
    });

    new ResizeObserver(() => {
      if (!this.timeline) return;
      const wasFit = this.zoom === this.fitZoom;
      this.fitZoom = this.computeFit();
      if (wasFit) this.setZoom(this.fitZoom);
    }).observe(this.scroller);
  }

  private frameAtX(clientX: number): number {
    const rect = this.inner.getBoundingClientRect();
    return (clientX - rect.left) / this.zoom;
  }

  private computeFit(): number {
    return this.timeline ? Math.max(0.02, (this.scroller.clientWidth - 8) / this.timeline.length) : 1;
  }

  show(song: Song, timeline: Timeline, fps: number) {
    this.timeline = timeline;
    this.fps = fps;
    this.fitZoom = this.computeFit();
    // Start zoomed so that a typical clip is wide enough to read
    const lengths = timeline.clips.flat().map((c) => c.end - c.start).sort((a, b) => a - b);
    const typical = lengths[lengths.length >> 1] || timeline.length;
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.fitZoom, MIN_CLIP_WIDTH / typical));
    this.build(song);
    this.scroller.scrollLeft = 0;
  }

  setZoom(zoom: number) {
    if (!this.timeline) return;
    const center = (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / this.zoom;
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.fitZoom, zoom));
    this.layout();
    this.scroller.scrollLeft = center * this.zoom - this.scroller.clientWidth / 2;
  }

  private build(song: Song) {
    const t = this.timeline!;
    this.sectionLane.replaceChildren();
    this.sectionEls = t.sections.map((s) => {
      const e = el('button', 'section-block', s.letter);
      e.dataset.start = String(s.start);
      colorSection(e, s);
      e.title =
        `Section ${s.letter}: ${formatTime(s.start / this.fps)}–${formatTime(s.end / this.fps)}` +
        (s.count > 1 ? `, one of ${s.count} with the same patterns` : '') +
        '. Click to play from here.';
      this.sectionLane.append(e);
      return e;
    });

    this.runByEl.clear();
    this.runs = t.clips.map((lane, v) => {
      this.lanes[v].replaceChildren();
      const [lo, hi] = t.range[v];
      const span = Math.max(12, hi - lo + 1);
      // Thumbnails are ~26px tall: keep bars about 2px whatever the range
      const barHeight = Math.max(1, span / 12);
      const notes = t.notes[v];
      let n = 0;

      // Back-to-back plays of the same pattern become one block
      const groups: Clip[][] = [];
      for (const clip of lane) {
        if (clip.start >= t.length) break;
        const last = groups[groups.length - 1]?.[0];
        if (last && last.pattern === clip.pattern && last.transpose === clip.transpose && last.repeat === clip.repeat) groups[groups.length - 1].push(clip);
        else groups.push([clip]);
      }

      return groups.map((clips) => {
        const first = clips[0];
        const run: ClipRun = { clips, start: first.start, end: Math.min(clips[clips.length - 1].end, t.length), el: el('button', first.repeat ? 'clip repeat' : 'clip') };
        const e = run.el;
        e.style.setProperty('--h', String(patternHue(first.pattern)));
        const rows = song.patterns[first.pattern]?.length ?? 0;
        e.title =
          `Pattern ${first.pattern}` +
          (first.transpose ? `, transposed ${transposeLabel(first.transpose)} semitones` : '') +
          ` · ${rows} rows` +
          (clips.length > 1 ? ` · plays ${clips.length} times in a row` : '') +
          ` · ${formatTime(first.start / this.fps)}` +
          (first.repeat ? ' · the voice has looped back: this repeats earlier material' : '');

        const label = el('span', 'clip-label', String(first.pattern));
        if (first.transpose) label.append(el('span', 'clip-transpose', transposeLabel(first.transpose)));
        if (clips.length > 1) label.append(el('span', 'clip-times', `×${clips.length}`));
        e.append(label);

        // A thumbnail of the notes, with a notch where each repeat starts
        const length = Math.max(1, run.end - run.start);
        const thumb = svg('svg', { viewBox: `0 0 ${length} ${span}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        for (const c of clips.slice(1)) {
          thumb.append(svg('line', { x1: c.start - run.start, x2: c.start - run.start, y1: 0, y2: span, class: 'notch' }));
        }
        while (n < notes.length && notes[n].end <= run.start) n++;
        for (let i = n; i < notes.length && notes[i].start < run.end; i++) {
          const note = notes[i];
          const x = Math.max(note.start, run.start) - run.start;
          const w = Math.min(note.end, run.end) - run.start - x;
          if (w <= 0) continue;
          const y = hi - note.note + (span - (hi - lo + 1)) / 2 - barHeight / 2 + 0.5;
          thumb.append(svg('rect', { x, y, width: Math.max(w - 0.6, 0.6), height: barHeight }));
        }
        e.append(thumb);
        this.lanes[v].append(e);
        this.runByEl.set(e, run);
        return run;
      });
    });

    this.loop.hidden = t.loopStart < 0;
    if (t.loopStart >= 0) this.loop.title = `When the song reaches the end it loops back to ${formatTime(t.loopStart / this.fps)}`;
    this.current = [null, null, null, null];
    this.layout();
  }

  private layout() {
    const t = this.timeline!;
    const z = this.zoom;
    this.inner.style.width = `${Math.ceil(t.length * z)}px`;

    t.sections.forEach((s, i) => {
      this.sectionEls[i].style.left = `${s.start * z}px`;
      this.sectionEls[i].style.width = `${Math.max(1, (s.end - s.start) * z - LANE_GAP)}px`;
      this.sectionEls[i].classList.toggle('narrow', (s.end - s.start) * z < 22);
    });
    for (const lane of this.runs) {
      for (const { start, end, el: e } of lane) {
        const w = (end - start) * z;
        e.style.left = `${start * z}px`;
        e.style.width = `${Math.max(1, w - LANE_GAP)}px`;
        e.classList.toggle('narrow', w < 30);
      }
    }

    if (t.loopStart >= 0) {
      this.loop.style.left = `${t.loopStart * z}px`;
      this.loop.style.width = `${(t.length - t.loopStart) * z}px`;
    }

    // Ruler ticks: pick a spacing that leaves room for the labels
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * this.fps * z >= 56) ?? 600;
    this.ruler.replaceChildren();
    for (let s = 0; s * this.fps < t.length; s += step) {
      const tick = el('span', 'tick', formatTime(s));
      tick.style.left = `${s * this.fps * z}px`;
      this.ruler.append(tick);
    }
  }

  setMuted(muted: boolean[]) {
    muted.forEach((m, v) => {
      this.lanes[v].classList.toggle('muted', m);
      this.labels[v].classList.toggle('muted', m);
    });
  }

  /** Moves the playhead to a timeline frame and highlights what is playing. */
  setFrame(frame: number, playing: boolean) {
    const t = this.timeline;
    if (!t) return;
    const x = frame * this.zoom;
    this.playhead.style.transform = `translateX(${x}px)`;

    const highlight = (slot: number, next: HTMLElement | null) => {
      if (this.current[slot] === next) return;
      this.current[slot]?.classList.remove('now');
      next?.classList.add('now');
      this.current[slot] = next;
    };
    const section = findAt(t.sections, frame);
    highlight(3, section ? this.sectionEls[section.index] : null);
    this.runs.forEach((lane, v) => highlight(v, findAt(lane, frame)?.el ?? null));

    // Turn the page when the playhead nears the edge, like a DAW
    if (playing && this.follow.checked && performance.now() > this.followPausedUntil) {
      const left = this.scroller.scrollLeft;
      const width = this.scroller.clientWidth;
      if (x < left || x > left + width * 0.85) this.scroller.scrollLeft = x - width * 0.1;
    }
  }
}

// --- step view -----------------------------------------------------------------

interface Colors {
  surface: string;
  beat: string;
  bar: string;
  grid: string;
  text: string;
  muted: string;
  dark: boolean;
}

export class SectionView {
  onSeek: (frame: number) => void = () => {};
  /** Called when the shown section changes, with true if the user chose it. */
  onSection: (section: Section, chosen: boolean) => void = () => {};

  private song: Song | null = null;
  private timeline: Timeline | null = null;
  private fps = 50;
  private section: Section | null = null;
  private pinned = false;
  private muted = [false, false, false];
  private instrumentHues = new Map<number, number>();

  private readonly steps: HTMLElement;
  private readonly canvases: HTMLCanvasElement[];
  private readonly playhead: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly letter: HTMLElement;
  private readonly info: HTMLElement;
  private readonly legend: HTMLElement;

  constructor(root: HTMLElement) {
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.steps = q('.steps');
    this.canvases = [0, 1, 2].map((v) => q(`canvas[data-voice="${v}"]`));
    this.playhead = q('.playhead');
    this.tip = q('.tip');
    this.letter = q('.section-letter');
    this.info = q('.section-info');
    this.legend = q('.legend');

    q('.section-prev').addEventListener('click', () => this.step(-1));
    q('.section-next').addEventListener('click', () => this.step(1));

    for (const [v, canvas] of this.canvases.entries()) {
      canvas.addEventListener('pointermove', (e) => this.hover(v, e));
      canvas.addEventListener('pointerleave', () => (this.tip.hidden = true));
      canvas.addEventListener('click', (e) => {
        const row = this.rowAt(v, e);
        if (row) this.onSeek(row.frame);
      });
    }

    new ResizeObserver(() => this.draw()).observe(this.steps);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }

  show(song: Song, timeline: Timeline, fps: number) {
    this.song = song;
    this.timeline = timeline;
    this.fps = fps;
    this.pinned = false;
    // Spread the colours over just the instruments this song uses
    const used = [...new Set(timeline.notes.flat().map((n) => n.instrument))].sort((a, b) => a - b);
    this.instrumentHues = new Map(used.map((ins, k) => [ins, Math.round((k * 137.508 + 20) % 360)]));
    this.setSection(timeline.sections[0] ?? null);
  }

  setMuted(muted: boolean[]) {
    this.muted = muted;
    this.draw();
  }

  /** Shows the previous or next section and plays from it. */
  step(delta: number) {
    const t = this.timeline;
    if (!t || !this.section) return;
    const next = t.sections[this.section.index + delta];
    if (!next) return;
    this.setSection(next);
    this.onSection(next, true);
  }

  /** Follows playback: shows whichever section the frame is in. */
  setFrame(frame: number, playing: boolean) {
    const t = this.timeline;
    if (!t) return;
    if (playing) this.pinned = false;
    if (!this.pinned && (!this.section || frame < this.section.start || frame >= this.section.end)) {
      const s = findAt(t.sections, frame);
      if (s && s !== this.section) {
        this.setSection(s);
        this.onSection(s, false);
      }
    }
    const s = this.section;
    if (s && frame >= s.start && frame < s.end) {
      this.playhead.hidden = false;
      const canvas = this.canvases[0];
      this.playhead.style.left = `${canvas.offsetLeft + ((frame - s.start) / (s.end - s.start)) * canvas.clientWidth}px`;
    } else {
      this.playhead.hidden = true;
    }
  }

  /** Shows a section without following playback until play starts. */
  pin(section: Section) {
    this.pinned = true;
    this.setSection(section);
  }

  private setSection(section: Section | null) {
    this.section = section;
    if (!section || !this.timeline) return;
    const t = this.timeline;
    const count = this.voiceRows(0).length;
    this.letter.textContent = section.letter;
    colorSection(this.letter, section);
    this.info.textContent =
      `Section ${section.index + 1} of ${t.sections.length} · ${formatTime(section.start / this.fps)}–${formatTime(section.end / this.fps)}` +
      ` · ${count} steps` +
      (section.count > 1 ? ` · section ${section.letter} plays ${section.count} times in the song` : '');
    this.buildLegend();
    this.draw();
  }

  private voiceRows(v: number): Event[] {
    const s = this.section;
    const rows = this.timeline?.rows[v];
    if (!s || !rows) return [];
    return rows.filter((r) => r.frame >= s.start && r.frame < s.end);
  }

  private buildLegend() {
    const t = this.timeline!;
    const s = this.section!;
    const used = new Set<number>();
    for (const lane of t.notes) for (const n of lane) if (n.end > s.start && n.start < s.end) used.add(n.instrument);
    this.legend.replaceChildren(
      ...[...used].sort((a, b) => a - b).map((i) => {
        const chip = el('span', 'legend-item');
        chip.style.setProperty('--h', String(this.instrumentHues.get(i) ?? 0));
        chip.append(el('span', 'swatch'), document.createTextNode(this.song?.instruments[i]?.name || `Instrument ${i}`));
        chip.title = `Instrument ${i}`;
        return chip;
      }),
    );
  }

  private colors(): Colors {
    const style = getComputedStyle(this.steps);
    const v = (name: string) => style.getPropertyValue(name).trim();
    return {
      surface: v('--surface-2'),
      beat: v('--step-beat'),
      bar: v('--step-bar'),
      grid: v('--border'),
      text: v('--text'),
      muted: v('--muted'),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
    };
  }

  draw() {
    const t = this.timeline;
    const s = this.section;
    if (!t || !s) return;
    const colors = this.colors();
    for (let v = 0; v < 3; v++) this.drawVoice(v, t, s, colors);
  }

  private drawVoice(v: number, t: Timeline, s: Section, colors: Colors) {
    const canvas = this.canvases[v];
    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const g = canvas.getContext('2d')!;
    g.scale(ratio, ratio);
    g.clearRect(0, 0, width, height);
    g.globalAlpha = this.muted[v] ? 0.35 : 1;

    const span = s.end - s.start;
    const x = (f: number) => ((f - s.start) / span) * width;
    const rows = this.voiceRows(v);
    const COMMAND_STRIP = 10;
    const noteHeight = height - COMMAND_STRIP;

    // Steps, shaded in groups of four like a drum machine
    rows.forEach((r, i) => {
      const x0 = x(r.frame);
      const x1 = i + 1 < rows.length ? x(rows[i + 1].frame) : width;
      g.fillStyle = Math.floor(i / 4) % 2 ? colors.surface : colors.beat;
      g.fillRect(x0, 0, x1 - x0, noteHeight);
      if (i % 16 === 0 && i) {
        g.fillStyle = colors.bar;
        g.fillRect(Math.round(x0) - 1, 0, 2, noteHeight);
      } else if (x1 - x0 > 5) {
        g.fillStyle = colors.grid;
        g.fillRect(Math.round(x0), 0, 1, noteHeight);
      }
    });

    // Notes, scaled to what this voice plays in the section
    const notes = t.notes[v].filter((n) => n.end > s.start && n.start < s.end);
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of notes) {
      lo = Math.min(lo, n.note);
      hi = Math.max(hi, n.note);
    }
    if (notes.length) {
      const pad = Math.max(2, Math.ceil((12 - (hi - lo)) / 2));
      lo -= pad;
      hi += pad;
      const pitch = noteHeight / (hi - lo + 1);
      const barHeight = Math.max(4, Math.min(14, pitch * 1.6));
      g.font = `600 ${Math.min(11, barHeight)}px ui-monospace, Menlo, monospace`;
      g.textBaseline = 'middle';
      for (const n of notes) {
        const x0 = Math.max(0, x(n.start)) + 1;
        const x1 = Math.min(width, x(n.end)) - 1;
        const y = (hi - n.note + 0.5) * pitch - barHeight / 2;
        const hue = this.instrumentHues.get(n.instrument) ?? 0;
        g.fillStyle = colors.dark ? `hsl(${hue} 70% 62%)` : `hsl(${hue} 65% 50%)`;
        g.beginPath();
        g.roundRect(x0, y, Math.max(2, x1 - x0), barHeight, 3);
        g.fill();
        if (x1 - x0 > 30 && barHeight >= 9) {
          g.fillStyle = colors.dark ? '#12111a' : '#ffffff';
          g.fillText(noteName(n.note), x0 + 4, y + barHeight / 2 + 0.5);
        }
      }
    } else {
      g.fillStyle = colors.muted;
      g.font = '13px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText('Silent in this section', 10, noteHeight / 2);
    }

    // Commands: a dot under each step that has one
    g.fillStyle = colors.muted;
    for (const r of rows) {
      if (!r.data.command && !r.data.data) continue;
      if (!describeCommand(r.data.command, r.data.data)) continue;
      g.beginPath();
      g.arc(x(r.frame) + 3, height - COMMAND_STRIP / 2, 2, 0, Math.PI * 2);
      g.fill();
    }
  }

  private rowAt(v: number, e: PointerEvent | MouseEvent): Event | undefined {
    const s = this.section;
    if (!s) return undefined;
    const canvas = this.canvases[v];
    const rect = canvas.getBoundingClientRect();
    const frame = s.start + ((e.clientX - rect.left) / rect.width) * (s.end - s.start);
    const rows = this.voiceRows(v);
    let found: Event | undefined;
    for (const r of rows) {
      if (r.frame > frame) break;
      found = r;
    }
    return found;
  }

  private hover(v: number, e: PointerEvent) {
    const r = this.rowAt(v, e);
    const song = this.song;
    if (!r || !song) {
      this.tip.hidden = true;
      return;
    }
    const rows = this.voiceRows(v);
    const step = rows.indexOf(r) + 1;
    const lines = [`Voice ${v + 1} · step ${step} · pattern ${r.clip.pattern} row ${r.row}`];
    const notes = this.timeline!.notes[v];
    const sounding = notes.find((n) => n.start <= r.frame && n.end > r.frame);
    if (sounding) {
      const name = song.instruments[sounding.instrument]?.name || `Instrument ${sounding.instrument}`;
      lines.push(`${sounding.start === r.frame ? 'Plays' : 'Holding'} ${noteName(sounding.note)} · ${name}`);
    } else {
      lines.push('Silent');
    }
    const command = describeCommand(r.data.command, r.data.data);
    if (command) lines.push(command);
    this.tip.textContent = lines.join('\n');
    this.tip.hidden = false;
    const box = this.steps.getBoundingClientRect();
    const left = Math.min(e.clientX - box.left + 12, box.width - this.tip.offsetWidth - 4);
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${e.clientY - box.top + 14}px`;
  }
}
