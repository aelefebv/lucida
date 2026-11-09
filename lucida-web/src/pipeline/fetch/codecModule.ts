import wasmUrl from "lucida-core/lucida_core_bg.wasm?url";

/**
 * The WASM module compiled once on the page, for the decode workers to
 * instantiate. A worker that compiled its own spent about 60 ms on its first
 * encoded chunk, which a burst of them waited out in the pool's queue.
 */
export async function compileCodecModule(): Promise<WebAssembly.Module> {
  const response = await fetch(wasmUrl);
  // Streaming compilation needs the server to name the type; without it,
  // compile the bytes as the bindings' own loader does.
  if (response.headers.get("Content-Type")?.startsWith("application/wasm")) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}
