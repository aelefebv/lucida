import { describe, expect, it } from "vitest";
import type { DatasetManifest, LevelGeometry } from "../manifestTypes.ts";
import {
  GeneratedAvailabilityCatalog,
  mergeGeneratedAvailabilityIntoManifest,
  type WireGeneratedAvailabilitySnapshot,
} from "./generatedAvailability.ts";

function level(levelIndex: number): LevelGeometry {
  return {
    level_index: levelIndex,
    shape: [1, 1, 1, 64, 64],
    chunk_shape: [1, 1, 1, 64, 64],
    grid_shape: [1, 1, 1, 1, 1],
    scale: [1, 1, 1, 4, 4],
  };
}

function manifest(): DatasetManifest {
  return {
    dataset_id: "ds-1",
    name: "test",
    kind: "Single",
    entities: [{ id: "entity-1", kind: "Image", parent: null, labels: {} }],
    transforms: [],
    images: [{
      image_id: "img-1",
      owner: "entity-1",
      multiscale: {
        axes: [],
        levels: [{
          level_index: 0,
          shape: [1, 1, 1, 256, 256],
          chunk_shape: [1, 1, 1, 128, 128],
          grid_shape: [1, 1, 1, 2, 2],
          scale: [1, 1, 1, 1, 1],
        }],
        data_type: "uint16",
      },
    }],
    source_layouts: [],
    default_layout_id: null,
  };
}

function generatedSnapshot(): WireGeneratedAvailabilitySnapshot {
  return {
    levels: [{
      image_id: "img-1",
      info: {
        level_index: 1,
        role: "coarse",
        provenance: { generator: "test", config_id: "cfg", source_content_id: "src" },
      },
      level: level(1),
      summary: { total_chunks: 1, ready_chunks: 0, pending_chunks: 1, failed_chunks: 0 },
    }],
  };
}

describe("GeneratedAvailabilityCatalog", () => {
  it("merges generated level metadata without requiring ready chunks", () => {
    const merged = mergeGeneratedAvailabilityIntoManifest(manifest(), generatedSnapshot());

    const multiscale = merged.images[0].multiscale;
    expect(multiscale.levels).toHaveLength(2);
    expect(multiscale.generated_levels).toEqual([{
      level_index: 1,
      role: "coarse",
      provenance: { generator: "test", config_id: "cfg", source_content_id: "src" },
    }]);
    expect(multiscale.coarse_level_index).toBe(1);
  });

  it("upserts readiness statuses and keeps level summary telemetry-only", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("ds-1", generatedSnapshot());
    catalog.applyDelta("ds-1", {
      chunks: [{
        image_id: "img-1",
        level_index: 1,
        key: "1/0/0/0/0/0",
        status: "pending",
      }],
    });
    catalog.applyDelta("ds-1", {
      chunks: [{
        image_id: "img-1",
        level_index: 1,
        key: "1/0/0/0/0/0",
        status: "ready",
      }],
    });

    expect(catalog.statusFor("ds-1", "img-1", 1, "1/0/0/0/0/0")?.status).toBe("ready");
    expect(catalog.snapshot("ds-1").levels[0].summary?.pending_chunks).toBe(1);
  });

  it("clears runtime state by dataset", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("ds-1", generatedSnapshot());
    catalog.removeDataset("ds-1");

    expect(catalog.snapshot("ds-1")).toEqual({ levels: [], chunks: [] });
  });
});
