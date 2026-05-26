/// <reference types="node" />
// Smoke test for the cross-platform URL helpers exposed through the
// `lucida-core` wasm bundle. These functions are thin shims over
// `lucida_content::url` (the single source of truth, shared with the
// server and storage layer — see
// `wiki/decisions/0042-canonical-dataset-url-form.md`). The intent of
// this test is to catch build-config drift: if wasm-pack ever stops
// re-exporting these names, the smoke test fails loudly rather than
// the SPA discovering it at runtime when a user types a Windows path.
//
// Behavior is exhaustively tested in Rust (`lucida-content/src/url.rs`
// `mod tests`); here we only assert one representative case per
// function. Subsequent slices (#705, #706) will mock these the same way
// the existing `useSavedViewSync.test.tsx` mocks `dataset_id_for_url`.
//
// Loading the WASM in Node: `init()` defaults to a `fetch()` of the
// bundled `.wasm` (which doesn't work under the vitest runner). We
// pass the absolute path of the package's `.wasm` so vitest can
// resolve it without spinning up a real fetch. The triple-slash
// reference above pulls in `@types/node` (already in devDependencies)
// for this file only, avoiding a project-wide tsconfig change.

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import init, {
  normalize_dataset_url,
  is_local_dataset_url,
} from "lucida-core";

beforeAll(async () => {
  // Resolve the .wasm file alongside the JS bundle and pass its bytes
  // to `init()` — bypasses the `fetch()` default that doesn't work in
  // the Node test runner.
  const require_ = createRequire(import.meta.url);
  const jsPath = require_.resolve("lucida-core");
  const wasmPath = jsPath.replace(/\.js$/, "_bg.wasm");
  const bytes = await readFile(wasmPath);
  await init({ module_or_path: bytes });
});

describe("lucida-core URL helpers (wasm shim smoke test)", () => {
  it("normalize_dataset_url canonicalizes a Windows drive-letter path", () => {
    // `C:\foo` is the canonical bad input the bug report cited: the
    // browser/explorer-typed form. Should round to `c:/foo` so a
    // single file produces one `DatasetId` regardless of spelling.
    expect(normalize_dataset_url("C:\\foo")).toBe("c:/foo");
  });

  it("is_local_dataset_url classifies a canonical drive-letter path as local", () => {
    // The PRD's classifier table covers the full matrix; this just
    // confirms the shim is wired and the wasm export resolves.
    expect(is_local_dataset_url("c:/foo")).toBe(true);
  });
});
