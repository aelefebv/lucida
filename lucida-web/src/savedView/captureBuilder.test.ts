// @vitest-environment happy-dom
//
// Tests for `captureBuilder`'s share-warning classifier
// (`hasLocalFilePaths` / `localFilePathCount`). The classifier now
// delegates to the wasm-shimmed `is_local_dataset_url`, sharing one
// implementation with the Rust server/storage layer — see
// `wiki/decisions/0042-canonical-dataset-url-form.md` and
// `wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md`.
//
// The wasm-shim smoke test in `urlHelpers.test.ts` covers wiring drift
// against the real wasm; here we mock the shim to a small reference
// implementation so these tests can run as pure unit tests, and assert
// the externally observable property: a `SavedView` containing a
// Windows-canonical or UNC-canonical local path triggers the warning,
// remote-scheme URLs do not, and existing Unix-path behavior is
// unchanged.

import { describe, it, expect, vi } from "vitest";

// Mock BEFORE importing the module under test so the import-time
// `is_local_dataset_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  is_local_dataset_url: (url: string): boolean => {
    if (url === "") return false;
    if (
      url.startsWith("gs://") ||
      url.startsWith("s3://") ||
      url.startsWith("http://") ||
      url.startsWith("https://")
    ) {
      return false;
    }
    // UNC canonical.
    if (url.startsWith("//")) return true;
    // Drive-letter canonical (`c:` or `c:/...`).
    if (/^[a-z]:(\/|$)/.test(url)) return true;
    // Unix.
    return url.startsWith("/");
  },
}));

import {
  hasLocalFilePaths,
  localFilePathCount,
} from "./captureBuilder.ts";
import type { SavedView } from "./types.ts";
import { SAVED_VIEW_VERSION } from "./types.ts";

function viewWith(datasets: string[]): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets,
    active_layouts: {},
    camera: {
      mode: "slice",
      center: [0, 0],
      zoom: 1.0,
      viewport: [800, 600],
    },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

describe("captureBuilder.isLocalFilePath (via hasLocalFilePaths)", () => {
  // --- Existing Unix-path behavior must not regress. ---

  it("classifies a Unix path as local", () => {
    expect(hasLocalFilePaths(viewWith(["/data/scans/foo.zarr"]))).toBe(true);
  });

  it("classifies bare `/` as local", () => {
    expect(hasLocalFilePaths(viewWith(["/"]))).toBe(true);
  });

  // --- New cross-platform cases (ADR-0042). ---

  it("classifies a canonical drive-letter path as local", () => {
    expect(hasLocalFilePaths(viewWith(["c:/foo"]))).toBe(true);
  });

  it("classifies a canonical UNC path as local", () => {
    expect(hasLocalFilePaths(viewWith(["//server/share/foo"]))).toBe(true);
  });

  // --- Remote schemes are NOT local. ---

  it("does not classify gs:// as local", () => {
    expect(hasLocalFilePaths(viewWith(["gs://bucket/foo"]))).toBe(false);
  });

  it("does not classify s3:// as local", () => {
    expect(hasLocalFilePaths(viewWith(["s3://bucket/foo"]))).toBe(false);
  });

  it("does not classify http(s):// as local", () => {
    expect(hasLocalFilePaths(viewWith(["https://host.example.com/foo.zarr"]))).toBe(false);
  });

  // --- Empty view is not local. ---

  it("returns false for an empty datasets list", () => {
    expect(hasLocalFilePaths(viewWith([]))).toBe(false);
  });

  // --- Mixed views count correctly. ---

  it("counts every local path in a mixed view", () => {
    const v = viewWith([
      "gs://bucket/cloud.zarr",
      "/data/unix.zarr",
      "c:/data/windows.zarr",
      "//server/share/unc.zarr",
      "https://host/remote.zarr",
    ]);
    expect(hasLocalFilePaths(v)).toBe(true);
    expect(localFilePathCount(v)).toBe(3);
  });
});
