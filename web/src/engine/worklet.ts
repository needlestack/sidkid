// Audio worklet that owns the SIDKid engine. It renders 128-sample blocks,
// applies commands from the main thread, and reports status ~30 times a
// second. The engine renders whole C64 frames internally, so block size does
// not affect the output.

import createSidKid, { type SidKidModule } from '@engine/sidkid.js';
import type { Command, Event, ProcessorOptions } from './protocol';

// AudioWorkletGlobalScope is not in TypeScript's DOM lib
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: ProcessorOptions }) => AudioWorkletProcessor): void;

const BLOCK = 128;
const SONG_PATH = '/song.sng';
const STATUS_INTERVAL = Math.round(sampleRate / 30);

class SidKidProcessor extends AudioWorkletProcessor {
  private sk: SidKidModule | null = null;
  private buffer = 0;
  private envelopes = 0;
  private path = 0;
  private sinceStatus = 0;

  constructor(options: { processorOptions: ProcessorOptions }) {
    super();
    this.port.onmessage = (e: MessageEvent<Command>) => this.command(e.data);
    void this.boot(options.processorOptions);
  }

  private async boot({ wasm, model }: ProcessorOptions) {
    try {
      const sk = await createSidKid({ wasmBinary: wasm });
      sk._sk_init(sampleRate, model, 0, 0);
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
        sk._sk_play(cmd.subsong);
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
      case 'ping':
        this.send({ type: 'pong', id: cmd.id });
        break;
    }
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
    sk._sk_render(this.buffer, n);
    const samples = sk.HEAP16.subarray(this.buffer >> 1, (this.buffer >> 1) + n);
    for (let i = 0; i < n; i++) out[0][i] = samples[i] / 32768;
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
        },
      });
    }
    return true;
  }
}

registerProcessor('sidkid', SidKidProcessor);
