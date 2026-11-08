import { describe, expect, it } from "vitest";
import type { DatasetImportWarningKind, DatasetSourceHealth } from "../bridge.ts";
import { healthReasons, importWarningText } from "./healthText.ts";

function health(overrides: Partial<DatasetSourceHealth> = {}): DatasetSourceHealth {
  return {
    workspace_dataset_id: "wds-1",
    name: "tiles.zarr",
    status: "healthy",
    binding: { status: "healthy", message: "server binding is ready" },
    generated_coarse: {
      status: "healthy",
      level_count: 0,
      ready_chunks: 0,
      pending_chunks: 0,
      failed_chunks: 0,
      unavailable_chunks: 0,
      message: "generated coarse is healthy",
    },
    ...overrides,
  };
}

// Words that belong to the server's internals or the store's layout, not to
// what a person sees.
const DEVELOPER_WORDS = /binding|chunk|generated coarse|backend|representative|discovery|index|LUCIDA_|=1|"/i;

describe("healthReasons", () => {
  it("gives nothing for a healthy dataset, whatever the server says about itself", () => {
    expect(healthReasons(health())).toEqual([]);
  });

  it("words the server's trouble serving the dataset from its state, never its messages", () => {
    const reasons = healthReasons(
      health({
        status: "unavailable",
        binding: { status: "unavailable", message: "binding restore failed at BackendOpen: not found" },
        source_cache: {
          max_bytes: 1,
          current_bytes: 0,
          used_percent: 0,
          entry_count: 0,
          hits: 0,
          misses: 0,
          evictions: 0,
          backend_errors: 1,
          source_reads: 1,
          source_read_millis: 1,
        },
        generated_coarse: {
          status: "degraded",
          level_count: 2,
          ready_chunks: 0,
          pending_chunks: 0,
          failed_chunks: 3,
          unavailable_chunks: 0,
          message: "3 generated coarse chunks failed",
        },
        messages: ["source cache saw 1 backend errors while serving chunks"],
      }),
    );
    expect(reasons).toEqual([
      { text: "The server can't read this dataset right now, so none of it can be shown.", degrades: true },
      { text: "1 read from the source failed, so parts of the dataset may be missing.", degrades: true },
      {
        text: "The server couldn't build some zoomed-out levels, so the dataset may show gaps when zoomed out.",
        degrades: true,
      },
    ]);
  });
});

describe("importWarningText", () => {
  const KINDS: DatasetImportWarningKind[] = [
    "skipped_group",
    "unreadable_tile_geometry",
    "unusable_tile_geometry",
    "sampled_label_discovery",
    "unusable_label_index",
    "unwritten_level",
    "mismatched_tile_geometry",
    "duplicate_tile",
    "malformed_collection_layout",
    "pinned_axis",
    "invalid_scale",
  ];
  const IMPORTER_WORDED = new Set<DatasetImportWarningKind>([
    "mismatched_tile_geometry",
    "duplicate_tile",
    "malformed_collection_layout",
  ]);
  const developerMessage = 'probed 4 of 9 tiles; set LUCIDA_EXHAUSTIVE=1 to probe "A/1/0"';

  it.each(KINDS.filter((kind) => !IMPORTER_WORDED.has(kind)))("words %s for people", (kind) => {
    const text = importWarningText({ kind, target: "B/2", message: developerMessage, degrades: false });
    expect(text).not.toContain(developerMessage);
    expect(text).not.toMatch(DEVELOPER_WORDS);
    expect(text).toMatch(/^[A-Z].*\.$/);
  });

  it("keeps the importer's own wording where it is written for people, as a sentence", () => {
    for (const kind of IMPORTER_WORDED) {
      expect(importWarningText({ kind, target: "wds-1", message: "tiles differ in size", degrades: true })).toBe(
        "Tiles differ in size",
      );
    }
  });

  it("falls back to the importer's wording for a kind it has no words for", () => {
    const kind = "some_later_kind" as DatasetImportWarningKind;
    expect(importWarningText({ kind, target: "wds-1", message: "a later warning", degrades: false })).toBe(
      "A later warning",
    );
  });
});
