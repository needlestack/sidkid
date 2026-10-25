import wasmUrl from '@engine/sidkid.wasm?url';

let bytes: Promise<ArrayBuffer> | null = null;

/** The engine's wasm binary, fetched once and shared by worklet and workers. */
export function wasmBytes(): Promise<ArrayBuffer> {
  bytes ??= fetch(wasmUrl).then((r) => {
    if (!r.ok) throw new Error(`Could not load the engine (${r.status})`);
    return r.arrayBuffer();
  });
  return bytes;
}
