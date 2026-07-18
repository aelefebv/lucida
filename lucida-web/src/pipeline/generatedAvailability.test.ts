import { describe, expect, it } from "vitest";
import type { DatasetManifest, LevelGeometry } from "../manifestTypes.ts";
import {
  GeneratedAvailabilityCatalog,
  MAX_GENERATED_CATALOG_CHUNKS,
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

  it("reports generated status counts from level summaries before chunk statuses arrive", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("ds-1", {
      levels: [{
        ...generatedSnapshot().levels![0],
        summary: { total_chunks: 4, ready_chunks: 1, pending_chunks: 2, failed_chunks: 1 },
      }],
    });

    expect(catalog.statusCounts("ds-1")).toEqual({
      levels: 1,
      totalChunks: 4,
      ready: 1,
      pending: 2,
      unavailable: 0,
      failed: 1,
      failedTransient: 0,
      failedPermanent: 0,
    });
  });

  it("reports generated status counts from authoritative chunk statuses", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("ds-1", generatedSnapshot());
    catalog.applyDelta("ds-1", {
      chunks: [
        { image_id: "img-1", level_index: 1, key: "1/0/0/0/0/0", status: "ready" },
        { image_id: "img-1", level_index: 1, key: "1/0/0/0/0/1", status: "pending" },
        { image_id: "img-1", level_index: 1, key: "1/0/0/0/1/0", status: "unavailable" },
        { image_id: "img-1", level_index: 1, key: "1/0/0/0/1/1", status: "failed_transient" },
        { image_id: "img-1", level_index: 1, key: "1/0/0/1/0/0", status: "failed_permanent" },
      ],
    });

    expect(catalog.statusCountsByDataset()).toEqual([{
      datasetId: "ds-1",
      counts: {
        levels: 1,
        totalChunks: 5,
        ready: 1,
        pending: 1,
        unavailable: 1,
        failed: 2,
        failedTransient: 1,
        failedPermanent: 1,
      },
    }]);
  });

  it("clears runtime state by dataset", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("ds-1", generatedSnapshot());
    catalog.removeDataset("ds-1");

    expect(catalog.snapshot("ds-1")).toEqual({ levels: [], chunks: [] });
  });

  it("maintains status counts incrementally when a key changes status", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    const update = (status: "pending" | "ready" | "failed_transient") => {
      catalog.applyDelta("ds-1", {
        chunks: [{
          image_id: "img-1",
          level_index: 1,
          key: "1/0/0/0/0/0",
          status,
        }],
      });
    };

    update("pending");
    update("failed_transient");
    update("ready");

    expect(catalog.statusCounts("ds-1")).toEqual({
      levels: 0,
      totalChunks: 1,
      ready: 1,
      pending: 0,
      unavailable: 0,
      failed: 0,
      failedTransient: 0,
      failedPermanent: 0,
    });
    expect(catalog.stats()).toMatchObject({
      retainedChunks: 1,
      chunkWrites: 3,
      chunkEvictions: 0,
    });
  });

  it("uses collision-safe compound keys for arbitrary image and chunk ids", () => {
    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applyDelta("ds-1", {
      chunks: [
        { image_id: "a|1", level_index: 2, key: "b", status: "ready" },
        { image_id: "a", level_index: 1, key: "2|b", status: "failed_permanent" },
      ],
    });

    expect(catalog.statusFor("ds-1", "a|1", 2, "b")?.status).toBe("ready");
    expect(catalog.statusFor("ds-1", "a", 1, "2|b")?.status).toBe("failed_permanent");
    expect(catalog.stats().retainedChunks).toBe(2);
  });

  it("enforces one process-wide LRU budget across datasets", () => {
    const catalog = new GeneratedAvailabilityCatalog({ maxLevels: 1, maxChunks: 2 });
    catalog.applySnapshot("ds-1", generatedSnapshot());
    catalog.applyDelta("ds-1", {
      chunks: [
        { image_id: "img-1", level_index: 1, key: "old", status: "pending" },
        { image_id: "img-1", level_index: 1, key: "kept", status: "ready" },
      ],
    });
    // Reading the old entry makes it most recently used; the untouched entry
    // is therefore the one displaced by the next dataset's status.
    expect(catalog.statusFor("ds-1", "img-1", 1, "old")?.status).toBe("pending");
    catalog.applyDelta("ds-2", {
      chunks: [{ image_id: "img-2", level_index: 1, key: "new", status: "ready" }],
    });

    expect(catalog.statusFor("ds-1", "img-1", 1, "kept")).toBeNull();
    expect(catalog.statusFor("ds-1", "img-1", 1, "old")?.status).toBe("pending");
    expect(catalog.statusFor("ds-2", "img-2", 1, "new")?.status).toBe("ready");
    expect(catalog.stats()).toMatchObject({ retainedChunks: 2, chunkEvictions: 1 });
  });

  it("has deterministic linear work and bounded retention at 10k and 100k transitions", () => {
    const run = (transitions: number) => {
      const retainedLimit = 4_096;
      const catalog = new GeneratedAvailabilityCatalog({ maxChunks: retainedLimit });
      const batchSize = 250;
      for (let start = 0; start < transitions; start += batchSize) {
        catalog.applyDelta("ds-scale", {
          chunks: Array.from(
            { length: Math.min(batchSize, transitions - start) },
            (_, offset) => ({
              image_id: "img-scale",
              level_index: 1,
              key: `1/0/0/0/${start + offset}/0`,
              status: "ready" as const,
            }),
          ),
        });
      }
      return catalog.stats();
    };

    const tenThousand = run(10_000);
    const hundredThousand = run(100_000);

    expect(tenThousand.chunkWrites).toBe(10_000);
    expect(hundredThousand.chunkWrites).toBe(100_000);
    expect(hundredThousand.chunkWrites / tenThousand.chunkWrites).toBe(10);
    expect(tenThousand.retainedChunks).toBe(4_096);
    expect(hundredThousand.retainedChunks).toBe(4_096);
    expect(hundredThousand.retainedChunks).toBeLessThan(MAX_GENERATED_CATALOG_CHUNKS);
    expect(tenThousand.chunkEvictions).toBe(10_000 - 4_096);
    expect(hundredThousand.chunkEvictions).toBe(100_000 - 4_096);
  });
});
