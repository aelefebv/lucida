import { describe, expect, it } from "vitest";

import {
  applyEvent,
  hydrateClientState,
  reconcileWithSnapshot,
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
    expect(withWarnings.warnings).toHaveLength(1);
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
});
