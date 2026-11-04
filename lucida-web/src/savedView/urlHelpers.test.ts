/// <reference types="node" />
// Smoke test for the URL helpers the `lucida-core` wasm bundle re-exports from
// `lucida_content::url` (see `docs/adr/0042-canonical-dataset-url-form.md`).
// It catches build-config drift: if wasm-pack stops re-exporting these, this
// fails instead of the SPA failing when a user types a Windows path. Rust
// tests cover the behavior; this checks one case per function. The
// triple-slash reference pulls in `@types/node` for this file only.

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import init, {
  normalize_dataset_url,
  is_local_dataset_url,
} from "lucida-core";

beforeAll(async () => {
  // Pass the .wasm bytes, since `init()`'s default `fetch()` doesn't work
  // under the Node test runner.
  const require_ = createRequire(import.meta.url);
  const jsPath = require_.resolve("lucida-core");
  const wasmPath = jsPath.replace(/\.js$/, "_bg.wasm");
  const bytes = await readFile(wasmPath);
  await init({ module_or_path: bytes });
});

describe("lucida-core URL helpers (wasm shim smoke test)", () => {
  it("normalize_dataset_url canonicalizes a Windows drive-letter path", () => {
    // The Explorer-typed form must become `c:/foo` so one file has one
    // `DatasetId` however it's spelled.
    expect(normalize_dataset_url("C:\\foo")).toBe("c:/foo");
  });

  it("is_local_dataset_url classifies a canonical drive-letter path as local", () => {
    expect(is_local_dataset_url("c:/foo")).toBe(true);
  });
});
