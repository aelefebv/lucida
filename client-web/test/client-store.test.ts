import { describe, expect, it } from "vitest";

import {
  applyEvent,
  hydrateClientState,
  reconcileWithSnapshot,
  selectionBoundsFor,
  type SnapshotPayload,
} from "../src/client-store";

function snapshot(): SnapshotPayload {
  return {
    session: {
      session_id: "sess_00000001",
      session_rev: 3,
    },
    shared_scene: {
      scene_rev: 2,
      sources: {
        src_00000001: {
          sourceId: "src_00000001",
          name: "source-a",
          status: "watching",
          latestWorkingGenerationSeq: 1,
        },
      },
      datasets: {
        ds_00000001: {
          datasetId: "ds_00000001",
          sourceId: "src_00000001",
          resolvedGenerationSeq: 1,
          dtype: "uint8",
        },
      },
      layers: {
        lay_00000001: {
          layerId: "lay_00000001",
          name: "raw",
          layerRev: 1,
          metadataRev: 0,
          writeRev: 0,
        },
      },
      source_generations: {},
      warnings: [],
    },
    client_view: {
      client_id: "cli_00000001",
      view_rev: 1,
      warnings: [],
      active_layer_id: "lay_00000001",
      center_x: 32,
      center_y: 48,
      zoom: 1,
      z_index: 0,
      t_index: 0,
      selected_channels: [0],
    },
    warnings: [],
  };
}

describe("client store", () => {
  it("hydrates from snapshot and applies typed events", () => {
    const hydrated = hydrateClientState(snapshot());
    const withGeneration = applyEvent(hydrated, {
      session_rev: 4,
      event_type: "source_generation_progress",
      payload: {
        sourceId: "src_00000001",
        generationSeq: 2,
        stage: "partial",
        progressPercent: 55,
        previewReady: true,
        tile2dReadyLods: [4],
        brick3dReadyLods: [],
        tileLayout: {
          defaultChannelBlockSize: 4,
          lods: [
            {
              lod: 0,
              width: 64,
              height: 32,
              tileWidth: 512,
              tileHeight: 512,
              rows: 1,
              cols: 1,
            },
          ],
        },
      },
    });
    const withWarnings = applyEvent(withGeneration, {
      session_rev: 5,
      event_type: "warnings_updated",
      payload: {
        client_id: "cli_00000001",
        warnings: [
          {
            warningCode: "generation_build_incomplete",
            severity: "warning",
            message: "Generation 2 still refining.",
          },
        ],
      },
    });

    expect(withWarnings.sessionRev).toBe(5);
    expect(withWarnings.generations["src_00000001:2"]?.stage).toBe("partial");
    expect(
      withWarnings.generations["src_00000001:2"]?.tileLayout?.lods[0]?.width,
    ).toBe(64);
    expect(withWarnings.warnings).toHaveLength(1);
  });

  it("applies source_generation_failed payloads through the same generation contract", () => {
    const hydrated = hydrateClientState(snapshot());
    const failed = applyEvent(hydrated, {
      session_rev: 4,
      event_type: "source_generation_failed",
      payload: {
        sourceId: "src_00000001",
        generationSeq: 2,
        stage: "failed",
        progressPercent: 33,
        previewReady: true,
        tile2dReadyLods: [0],
        brick3dReadyLods: [],
        tileLayout: null,
      },
    });
    expect(failed.generations["src_00000001:2"]?.stage).toBe("failed");
    expect(failed.generations["src_00000001:2"]?.progressPercent).toBe(33);
  });

  it("ignores malformed generation payloads instead of mutating state", () => {
    const hydrated = hydrateClientState(snapshot());
    const malformed = applyEvent(hydrated, {
      session_rev: 4,
      event_type: "source_generation_progress",
      payload: {
        sourceId: "src_00000001",
        generationSeq: "2",
        stage: "partial",
        progressPercent: 55,
        previewReady: true,
        tile2dReadyLods: [0],
        brick3dReadyLods: [],
      },
    });
    expect(malformed.generations).toEqual(hydrated.generations);
  });

  it("hydrates source generation tile layout metadata from snapshot", () => {
    const snap = snapshot();
    snap.shared_scene.source_generations = {
      ...(snap.shared_scene.source_generations ?? {}),
      "src_00000001:3": {
      sourceId: "src_00000001",
      generationSeq: 3,
      stage: "ready",
      progressPercent: 100,
      previewReady: true,
      tile2dReadyLods: [2, 1, 0],
      brick3dReadyLods: [],
      tileLayout: {
        defaultChannelBlockSize: 4,
        lods: [
          {
            lod: 0,
            width: 279,
            height: 192,
            tileWidth: 512,
            tileHeight: 512,
            rows: 1,
            cols: 1,
          },
        ],
      },
      },
    };

    const hydrated = hydrateClientState(snap);
    expect(hydrated.generations["src_00000001:3"]?.tileLayout?.lods[0]?.height).toBe(
      192,
    );
    expect(
      hydrated.generations["src_00000001:3"]?.tileLayout?.defaultChannelBlockSize,
    ).toBe(4);
  });

  it("reconciles authoritative snapshot on reconnect", () => {
    const hydrated = hydrateClientState(snapshot());
    const drifted = applyEvent(hydrated, {
      session_rev: 10,
      event_type: "view_updated",
      payload: {
        client_id: "cli_00000001",
        view_rev: 99,
        active_layer_id: null,
        center_x: 200,
        center_y: 100,
        zoom: 2,
        z_index: 3,
        t_index: 4,
        selected_channels: [0, 1],
      },
    });
    const reconciled = reconcileWithSnapshot(drifted, snapshot());

    expect(reconciled.sessionRev).toBe(3);
    expect(reconciled.viewRev).toBe(1);
    expect(reconciled.activeLayerId).toBe("lay_00000001");
    expect(reconciled.selectedChannels).toEqual([0]);
    expect(reconciled.reconnectCount).toBe(1);
  });

  it("ignores out-of-order stale events", () => {
    const hydrated = hydrateClientState(snapshot());
    const newer = applyEvent(hydrated, {
      session_rev: 6,
      event_type: "view_updated",
      payload: {
        client_id: "cli_00000001",
        view_rev: 3,
        active_layer_id: null,
        center_x: 10,
        center_y: 11,
        zoom: 1.2,
        z_index: 2,
        t_index: 1,
        selected_channels: [1],
      },
    });
    const stale = applyEvent(newer, {
      session_rev: 4,
      event_type: "view_updated",
      payload: {
        client_id: "cli_00000001",
        view_rev: 2,
        active_layer_id: "lay_00000001",
        center_x: 9,
        center_y: 9,
        zoom: 1,
        z_index: 0,
        t_index: 0,
        selected_channels: [0],
      },
    });

    expect(stale.sessionRev).toBe(6);
    expect(stale.viewRev).toBe(3);
    expect(stale.activeLayerId).toBeNull();
  });

  it("derives z/t/c bounds from dataset shape metadata", () => {
    const shaped = snapshot();
    const baseDataset = shaped.shared_scene.datasets.ds_00000001;
    if (baseDataset === undefined) {
      throw new Error("dataset fixture should be present");
    }
    shaped.shared_scene.datasets.ds_00000001 = {
      ...baseDataset,
      sizeT: 30,
      sizeC: 2,
      sizeZ: 17,
      sizeY: 192,
      sizeX: 279,
    };

    const hydrated = hydrateClientState(shaped);
    const bounds = selectionBoundsFor(hydrated);

    expect(bounds).not.toBeNull();
    expect(bounds?.maxTIndex).toBe(29);
    expect(bounds?.maxChannelIndex).toBe(1);
    expect(bounds?.maxZIndex).toBe(16);
  });
});
