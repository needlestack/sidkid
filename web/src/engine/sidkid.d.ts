// Types for the Emscripten module built by engine/Makefile (`make wasm`).

declare module '@engine/sidkid.js' {
  export interface SidKidModule {
    FS: { writeFile(path: string, data: Uint8Array): void };
    HEAP16: Int16Array;
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _sk_init(samplerate: number, model: number, ntsc: number, interpolate: number): number;
    _sk_configure(multiplier: number, ntsc: number, adparam: number, optimizepulse: number, optimizerealtime: number): void;
    _sk_set_model(model: number, interpolate: number): void;
    _sk_load_song(path: number): number;
    _sk_num_subsongs(): number;
    _sk_play(subsong: number): void;
    _sk_stop(): void;
    _sk_is_playing(): number;
    _sk_song_looped(): number;
    _sk_toggle_mute(channel: number): void;
    _sk_is_muted(channel: number): number;
    _sk_render(out: number, samples: number): void;
    _sk_render_frame(out: number): number;
    _sk_sidregs(): number;
    _sk_envelopes(out: number): void;
    _sk_frames(): number;
    _sk_song_name(): number;
    _sk_author_name(): number;
    _sk_copyright_name(): number;
  }

  export default function createSidKid(options?: { wasmBinary?: ArrayBuffer }): Promise<SidKidModule>;
}
