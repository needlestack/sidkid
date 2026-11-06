// Audio worklet that owns the SIDKid engine. It renders 128-sample blocks,
// applies commands from the main thread, and reports status ~30 times a
// second. The engine renders whole C64 frames internally, so block size does
// not affect the output.

import createSidKid, { type SidKidModule } from '@engine/sidkid.js';
import { configure, writeInstrument, writeTables } from './configure';
import type { Command, Event, ProcessorOptions } from './protocol';
import { BAR, NO_CLICK, Sequencer } from './sequencer';

// AudioWorkletGlobalScope is not in TypeScript's DOM lib
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: ProcessorOptions }) => AudioWorkletProcessor): void;

const BLOCK = 128;
const SONG_PATH = '/song.sng';
const CLICK_SECONDS = 0.06;
const STATUS_INTERVAL = Math.round(sampleRate / 30);

class SidKidProcessor extends AudioWorkletProcessor {
  private sk: SidKidModule | null = null;
  private buffer = 0;
  private envelopes = 0;
  private path = 0;
  private sinceStatus = 0;
  private sequencer = new Sequencer();
  /** The metronome's click: where it started in this block (or -1), its pitch, and samples since */
  private clickAt = -1;
  private clickHz = 0;
  private clickAge = Infinity;

  constructor(options: { processorOptions: ProcessorOptions }) {
    super();
    this.port.onmessage = (e: MessageEvent<Command>) => this.command(e.data);
    void this.boot(options.processorOptions);
  }

  private async boot({ wasm, model, settings }: ProcessorOptions) {
    try {
      const sk = await createSidKid({ wasmBinary: wasm });
      sk._sk_init(sampleRate, model, settings.ntsc ? 1 : 0, 0);
      configure(sk, settings);
      this.buffer = sk._malloc(BLOCK * 2);
      this.envelopes = sk._malloc(3);
      this.path = sk._malloc(SONG_PATH.length + 1);
      for (let i = 0; i < SONG_PATH.length; i++) sk.HEAPU8[this.path + i] = SONG_PATH.charCodeAt(i);
      sk.HEAPU8[this.path + SONG_PATH.length] = 0;
      this.sk = sk;
      this.send({ type: 'ready' });
    } catch (err) {
      this.send({ type: 'error', message: `Engine failed to start: ${err}` });
    }
  }

  private send(event: Event) {
    this.port.postMessage(event);
  }

  private command(cmd: Command) {
    const sk = this.sk;
    if (!sk) return;
    switch (cmd.type) {
      case 'load': {
        sk.FS.writeFile(SONG_PATH, new Uint8Array(cmd.bytes));
        const ok = sk._sk_load_song(this.path) !== 0;
        this.send({
          type: 'loaded',
          id: cmd.id,
          info: ok
            ? {
                title: this.string(sk._sk_song_name()),
                author: this.string(sk._sk_author_name()),
                copyright: this.string(sk._sk_copyright_name()),
                subsongs: sk._sk_num_subsongs(),
              }
            : null,
        });
        break;
      }
      case 'play':
        if (cmd.frame > 0) sk._sk_seek(cmd.subsong, cmd.frame);
        else sk._sk_play(cmd.subsong);
        break;
      case 'stop':
        sk._sk_stop();
        break;
      case 'mute':
        if ((sk._sk_is_muted(cmd.channel) !== 0) !== cmd.muted) sk._sk_toggle_mute(cmd.channel);
        break;
      case 'model':
        sk._sk_set_model(cmd.model, 0);
        break;
      case 'settings':
        configure(sk, cmd.settings);
        break;
      case 'ping':
        this.send({ type: 'pong', id: cmd.id });
        break;
      case 'tables':
        writeTables(sk, cmd.tables);
        break;
      case 'instrument':
        writeInstrument(sk, cmd.num, cmd.instrument);
        break;
      case 'noteOn':
        sk._sk_note_on(cmd.voice, cmd.note, cmd.instrument);
        this.liveNow();
        break;
      case 'clearFilter':
        sk._sk_clear_filter();
        break;
      case 'noteOff':
        sk._sk_note_off(cmd.voice);
        this.liveNow();
        break;
      case 'silence':
        // Clears the SID registers: gates off with the fastest release
        this.sequencer.stop();
        sk._sk_reset();
        break;
      case 'sequence':
        if (cmd.sequence) this.sequencer.load(cmd.sequence, cmd.keep);
        else this.sequencer.stop();
        break;
    }
  }

  /** A note played live, with no song playing: its frame starts now, not when the one being played would end */
  private liveNow() {
    if (!this.sequencer.playing) this.sk!._sk_frame_now();
  }

  /** The metronome: a short, quickly fading tick beside the chip (it takes none of its voices) */
  private click(): number {
    const age = this.clickAge;
    if (age > sampleRate * CLICK_SECONDS) return 0;
    this.clickAge++;
    const t = age / sampleRate;
    return 0.28 * Math.exp(-t * 90) * Math.sin(2 * Math.PI * this.clickHz * t);
  }

  // Song texts are 32-byte Latin-1 fields; TextDecoder is not available in
  // every browser's worklet scope, so decode by hand.
  private string(ptr: number): string {
    const heap = this.sk!.HEAPU8;
    let s = '';
    for (let i = 0; i < 32 && heap[ptr + i]; i++) s += String.fromCharCode(heap[ptr + i]);
    return s.trim();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const sk = this.sk;
    if (!sk) return true;

    const n = out[0].length;
    // Rendered a frame at a time where a new one starts, so a sequence's
    // notes go in just before their frame
    this.clickAt = -1;
    for (let done = 0; done < n; ) {
      if (sk._sk_frame_left() <= 0) {
        const click = this.sequencer.tick(sk);
        if (click !== NO_CLICK) {
          this.clickAt = done;
          this.clickHz = click === BAR ? 1760 : 1320;
        }
      }
      const left = sk._sk_frame_left();
      const amount = left > 0 ? Math.min(left, n - done) : 1;
      sk._sk_render(this.buffer + done * 2, amount);
      done += amount;
    }
    const samples = sk.HEAP16.subarray(this.buffer >> 1, (this.buffer >> 1) + n);
    for (let i = 0; i < n; i++) {
      if (i === this.clickAt) this.clickAge = 0;
      out[0][i] = samples[i] / 32768 + this.click();
    }
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);

    this.sinceStatus += n;
    if (this.sinceStatus >= STATUS_INTERVAL) {
      this.sinceStatus = 0;
      sk._sk_envelopes(this.envelopes);
      const regs = sk._sk_sidregs();
      this.send({
        type: 'status',
        status: {
          playing: sk._sk_is_playing() !== 0,
          frames: sk._sk_frames(),
          muted: [0, 1, 2].map((c) => sk._sk_is_muted(c) !== 0),
          regs: sk.HEAPU8.slice(regs, regs + 25),
          envelopes: sk.HEAPU8.slice(this.envelopes, this.envelopes + 3),
          tablePos: [0, 1, 2].map((t) => sk._sk_table_pos(0, t)),
          sequence: this.sequencer.playing ? this.sequencer.frame : null,
        },
      });
    }
    return true;
  }
}

registerProcessor('sidkid', SidKidProcessor);
