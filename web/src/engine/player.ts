// Main-thread handle on the engine running in the audio worklet.

import workletUrl from './worklet.ts?worker&url';
import { wasmBytes } from './wasm';
import type { Instrument } from '../song';
import type { TableData } from './configure';
import { DEFAULT_SETTINGS, type Command, type Event, type ProcessorOptions, type Settings, type SongInfo, type Status } from './protocol';

export const SAMPLE_RATE = 48000;

export const MODEL_6581 = 0;
export const MODEL_8580 = 1;

export class Player {
  onStatus: (status: Status) => void = () => {};
  onError: (message: string) => void = () => {};

  private context: BaseAudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private booting: Promise<void> | null = null;
  private nextId = 1;
  private pendingLoads = new Map<number, (info: SongInfo | null) => void>();
  private pendingPings = new Map<number, () => void>();
  private model = MODEL_6581;
  private settings: Settings = DEFAULT_SETTINGS;

  /**
   * Starts audio. Browsers only allow this from a user gesture, so call it
   * from a click or key handler before anything else. With an
   * OfflineAudioContext (tests), audio runs when the caller renders it.
   */
  async start(context?: BaseAudioContext): Promise<void> {
    this.booting ??= this.boot(context ?? new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }));
    await this.booting;
    // Not awaited: without a user gesture resume() stays pending until one
    // happens, and the engine is usable (silently) in the meantime.
    if (this.context instanceof AudioContext && this.context.state !== 'running') void this.context.resume();
  }

  get started(): boolean {
    return this.node !== null;
  }

  /** Seconds between the worklet rendering a sample and it being heard. */
  get latency(): number {
    if (!(this.context instanceof AudioContext)) return 0;
    return (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
  }

  /** False while the browser is holding audio back until a user gesture. */
  get running(): boolean {
    return !(this.context instanceof AudioContext) || this.context.state === 'running';
  }

  private async boot(context: BaseAudioContext): Promise<void> {
    this.context = context;
    const [wasm] = await Promise.all([wasmBytes(), context.audioWorklet.addModule(workletUrl)]);
    const processorOptions: ProcessorOptions = { wasm, model: this.model, settings: this.settings };
    const node = new AudioWorkletNode(context, 'sidkid', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions,
    });
    await new Promise<void>((resolve, reject) => {
      node.port.onmessage = (e: MessageEvent<Event>) => {
        const event = e.data;
        if (event.type === 'ready') resolve();
        else if (event.type === 'error') reject(new Error(event.message));
        this.event(event);
      };
    });
    node.connect(context.destination);
    this.node = node;
  }

  private event(event: Event) {
    switch (event.type) {
      case 'loaded':
        this.pendingLoads.get(event.id)?.(event.info);
        this.pendingLoads.delete(event.id);
        break;
      case 'pong':
        this.pendingPings.get(event.id)?.();
        this.pendingPings.delete(event.id);
        break;
      case 'status':
        this.onStatus(event.status);
        break;
      case 'error':
        this.onError(event.message);
        break;
    }
  }

  private send(cmd: Command, transfer: Transferable[] = []) {
    if (!this.node) throw new Error('Player not started');
    this.node.port.postMessage(cmd, transfer);
  }

  /** Loads a GoatTracker .sng file. Resolves to null if it is not one. */
  load(bytes: ArrayBuffer): Promise<SongInfo | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingLoads.set(id, resolve);
      this.send({ type: 'load', id, bytes }, [bytes]);
    });
  }

  /** Starts a subsong, optionally from a number of frames in. */
  play(subsong = 0, frame = 0) {
    this.send({ type: 'play', subsong, frame });
  }

  stop() {
    this.send({ type: 'stop' });
  }

  setMuted(channel: number, muted: boolean) {
    this.send({ type: 'mute', channel, muted });
  }

  /** Resolves once the worklet has handled every command sent before it. */
  sync(): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingPings.set(id, resolve);
      this.send({ type: 'ping', id });
    });
  }

  /** Replaces the wave, pulse, filter and speed tables of the loaded song. */
  setTables(tables: TableData[]) {
    this.send({ type: 'tables', tables });
  }

  setInstrument(num: number, instrument: Instrument) {
    this.send({ type: 'instrument', num, instrument });
  }

  /** Plays a note (0 = C-0) on a voice while no song is playing. */
  noteOn(voice: number, note: number, instrument: number) {
    this.send({ type: 'noteOn', voice, note, instrument });
  }

  noteOff(voice: number) {
    this.send({ type: 'noteOff', voice });
  }

  setModel(model: number) {
    this.model = model;
    if (this.node) this.send({ type: 'model', model });
  }

  /** Speed and timing changes take full effect from the next play(). */
  setSettings(settings: Settings) {
    this.settings = settings;
    if (this.node) this.send({ type: 'settings', settings });
  }
}
