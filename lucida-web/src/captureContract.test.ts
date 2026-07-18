import { describe, expect, it } from "vitest";
import {
  captureCameraSummary,
  captureDatasetSummaries,
  captureViewSummary,
  type CaptureSceneFacet,
} from "./captureContract.ts";
import type { DatasetManifest } from "./manifestTypes.ts";

function manifest(): DatasetManifest {
  const multiscale = (dataType: string, channels: number) => ({
    axes: [],
    levels: [{
      level_index: 0,
      shape: [1, channels, 1, 4, 4],
      chunk_shape: [1, 1, 1, 4, 4],
      grid_shape: [1, channels, 1, 1, 1],
      scale: [1, 1, 1, 1, 1],
    }],
    data_type: dataType,
  });
  return {
    dataset_id: "fixture",
    name: "fixture",
    kind: "Single",
    entities: [],
    transforms: [],
    images: [
      { image_id: "u8-a", owner: "a", multiscale: multiscale("Uint8", 3) },
      { image_id: "f32-b", owner: "b", multiscale: multiscale("Float32", 2) },
      { image_id: "u8-c", owner: "c", multiscale: multiscale("Uint8", 1) },
    ],
    source_layouts: [],
    default_layout_id: null,
  };
}

describe("production capture contract", () => {
  it("exposes intensity dtype and per-image channel counts without voxel data", () => {
    const summaries = captureDatasetSummaries(
      new Map([["fixture", { manifest: manifest() }]]),
    );
    expect(summaries).toEqual([{
      datasetId: "fixture",
      dataTypes: ["Uint8", "Float32"],
      channelCounts: [3, 2, 1],
    }]);
  });

  it("exposes the selected channel and exact contrast used by the renderer", () => {
    const scene: CaptureSceneFacet = {
      t: () => 4,
      c: () => 2,
      z: () => 9,
      multi_channel: () => false,
      contrast_min: () => 12.5,
      contrast_max: () => 240.25,
      dataset_order: () => JSON.stringify(["unloaded", "hidden", "fixture"]),
      all_dataset_settings: () => JSON.stringify({
        unloaded: {
          visible: true,
          contrast_min: 1,
          contrast_max: 2,
          gamma: 1,
          channel_settings: [],
        },
        hidden: {
          visible: false,
          contrast_min: 3,
          contrast_max: 4,
          gamma: 1,
          channel_settings: [],
        },
        fixture: {
          visible: true,
          contrast_min: 5,
          contrast_max: 250,
          gamma: 1.1,
          channel_settings: [
            { visible: true, contrast_min: 0, contrast_max: 255, gamma: 1 },
            { visible: true, contrast_min: 10, contrast_max: 200, gamma: 1.2 },
            { visible: true, contrast_min: 20, contrast_max: 220, gamma: 1.4 },
          ],
        },
      }),
    };
    expect(captureViewSummary(scene, ["hidden", "fixture"])).toEqual({
      t: 4,
      c: 2,
      z: 9,
      multiChannel: false,
      contrastMin: 20,
      contrastMax: 220,
      layers: [{
        datasetId: "fixture",
        channel: 2,
        contrastMin: 20,
        contrastMax: 220,
        gamma: 1.4,
        contrastSource: "channel",
      }],
    });
    expect(captureViewSummary(null)).toBeNull();
  });

  it("fans out visible channels and falls back to dataset display values", () => {
    const scene: CaptureSceneFacet = {
      t: () => 0,
      c: () => 7,
      z: () => 0,
      multi_channel: () => true,
      contrast_min: () => 0,
      contrast_max: () => 65535,
      dataset_order: () => JSON.stringify(["fixture"]),
      all_dataset_settings: () => JSON.stringify({
        fixture: {
          visible: true,
          contrast_min: 4,
          contrast_max: 400,
          gamma: 1.5,
          channel_settings: [
            { visible: false, contrast_min: 1, contrast_max: 10, gamma: 1 },
            { visible: true },
          ],
        },
      }),
    };

    expect(captureViewSummary(scene, ["fixture"])?.layers).toEqual([{
      datasetId: "fixture",
      channel: 1,
      contrastMin: 4,
      contrastMax: 400,
      gamma: 1.5,
      contrastSource: "dataset",
    }]);
  });

  it("records a slice camera viewport explicitly as CSS-logical pixels", () => {
    const scene = {
      export_presence: () => JSON.stringify({
        camera: { mode: "slice", center: [123.5, -7], zoom: 1.75, viewport: [800, 600] },
      }),
      project_to_screen: (x: number, y: number) => [
        (x - 123.5) * 1.75 + 400,
        (y + 7) * 1.75 + 300,
      ],
    } as unknown as CaptureSceneFacet;
    expect(captureCameraSummary(scene)).toEqual({
      mode: "slice",
      center: [123.5, -7],
      zoom: 1.75,
      viewport: [800, 600],
      viewportUnits: "css-pixels",
      projectionProbe: {
        world: [139.5, -16],
        screen: [428, 284.25],
      },
    });
    expect(captureCameraSummary(
      { export_presence: () => "{}" } as unknown as CaptureSceneFacet,
    )).toBeNull();
  });
});
