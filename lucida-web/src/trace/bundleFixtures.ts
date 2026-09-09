/**
 * Fixed inputs for a bundle, shared by the bundle tests and the golden that
 * the CLI reads back. Everything here is a constant, so the bundle they
 * produce is the same on every run and on both sides of the repository.
 */

import type { DatasetSourceHealth } from "../bridge.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import type { BundleContext, BundleServices } from "./bundle.ts";
import { healthyLocalOpen } from "./diagnose/fixtures.ts";
import { TRACE_SCHEMA_VERSION, type TraceDocument, type TraceRun } from "./types.ts";

/**
 * A `#view=` payload for dataset `ds`: a slice camera, channel 0 in magenta
 * with a 100..2000 window, channel 1 in green with 50..900, the volume render
 * mode pinned to max intensity, the level pinned to 2, and auto-contrast off.
 * Encoded once with the saved-view encoder and kept as a constant, because
 * the bundle decodes a URL and never encodes one.
 */
export const VIEW_PAYLOAD =
  "H4sIAAAAAAAAA2WO3WrDMAyF3-Vci-FkCax-lRKMiLXO4NjDVrKuxe8-0rVQthshpO_8XLHBdoSZFykMe8WSvcCixjALCLMklQJ7HLueXt-GiXDJeYE1LyNhC_L1mYvCHrthMHQwZmoEz8pV1OXib1r4iumX3iMurnA6yb5W5V09ECR52LERFLYnLGvU4OYPTkkirJZVnoyrqIZ0qruFv80iyUtx9_YLn11IKqkG_QbBi3KILsom0eVNSgk71xPuCU-OxyvmnLRwVbeEBNsZQ08nPsP2xphGf8HxH3cwpk2tEXjV7B6_R-t3jlVa-wE3o0m1hAEAAA";

export const VIEW_URL = `/w/ws-1?render=1#view=${VIEW_PAYLOAD}`;

/** The eight-byte PNG signature, enough to be a frame the tests can recognise. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function fixtureDocument(...runs: TraceRun[]): TraceDocument {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    exportedAtEpochMs: 1_700_000_100_000,
    retention: {
      residentCapBytes: 33_554_432,
      perRunCapBytes: 8_388_608,
      residentBytes: 0,
      intervalsEvicted: 0,
      derivedFrom: "fixture",
      capUnit: "bytes",
    },
    instrumentedPhases: ["plan", "queue", "wire", "decode", "upload", "present"],
    countedPhases: ["cache-admission", "worker-dispatch", "coalesce-attach"],
    runs,
    steadyState: [],
    rowsOutsideRun: 0,
    serverRowsOutsideRun: 0,
  };
}

export function fixtureHealth(id = "ds"): DatasetSourceHealth {
  return {
    workspace_dataset_id: id,
    name: "sample set",
    status: "healthy",
    source_url: "gs://bucket/sample.zarr",
    backend: "gcs",
    binding: { status: "healthy" },
    source_cache: {
      max_bytes: 1_073_741_824,
      current_bytes: 8_388_608,
      used_percent: 1,
      entry_count: 12,
      hits: 40,
      misses: 12,
      evictions: 0,
      backend_errors: 0,
      source_reads: 12,
      source_read_millis: 380,
    },
    generated_coarse: {
      status: "healthy",
      level_count: 2,
      ready_chunks: 8,
      pending_chunks: 0,
      failed_chunks: 0,
      unavailable_chunks: 0,
    },
  };
}

export function fixtureServices(overrides: Partial<BundleServices> = {}): BundleServices {
  return {
    requestDatasetHealth: () => Promise.resolve([fixtureHealth()]),
    captureFrame: () =>
      Promise.resolve({ png: PNG_BYTES.buffer.slice(0), width: 2880, height: 1800 }),
    ...overrides,
  };
}

/** A healthy local open whose URL carries {@link VIEW_PAYLOAD}, with every service answering. */
export function fixtureContext(overrides: Partial<BundleContext> = {}): BundleContext {
  const run = healthyLocalOpen();
  run.header.composedView = { url: VIEW_URL, mode: "slice" };
  return {
    exportTrace: () => fixtureDocument(run),
    services: fixtureServices(),
    planning: { ...DEFAULT_PLANNING_CONFIG },
    origin: "https://lucida.example",
    devicePixelRatio: 2,
    now: 1_700_000_200_000,
    ...overrides,
  };
}
