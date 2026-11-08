// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// A mid-session snapshot (reconnect, or resync after broadcast loss) runs the
// same onSnapshot path as the join snapshot. That reuse is safe only if it is
// idempotent (a registered dataset keeps its pipeline and layer maps) and
// converges membership (a dataset the document no longer holds is removed,
// since its remove_dataset broadcast may be what the resync repaired).
// Bridge and fetch-pipeline classes are recording doubles; Session is real.
vi.mock("../bridge.ts", () => {
  class MockBridge {
    static instances: MockBridge[] = [];
    handlers: unknown;
    destroy = vi.fn();
    send = vi.fn();
    sendCommand = vi.fn();
    sendPresence = vi.fn();
    sendDatasetPresence = vi.fn();
    sendCursor = vi.fn();
    sendFollow = vi.fn();
    sendOpenRemoteDataset = vi.fn();
    constructor(handlers: unknown, _url: string) {
      this.handlers = handlers;
      MockBridge.instances.push(this);
    }
  }
  return {
    Bridge: MockBridge,
    bridgeLog: vi.fn(),
    workspaceSocketUrl: (id: string) => `ws://test/ws/workspaces/${id}`,
  };
});

vi.mock("../pipeline/fetch/index.ts", () => {
  class MockDecodePool {
    size = 2;
    terminate = vi.fn();
  }
  class MockProxiedContentSource {
    static instances: MockProxiedContentSource[] = [];
    rejectAll = vi.fn();
    rejectDataset = vi.fn();
    registerImage = vi.fn();
    handleBinary = vi.fn();
    handleChunkStatus = vi.fn();
    constructor(_send: unknown) {
      MockProxiedContentSource.instances.push(this);
    }
  }
  class MockCpuCache {
    reset = vi.fn();
  }
  return {
    DecodePool: MockDecodePool,
    ProxiedContentSource: MockProxiedContentSource,
    CpuCache: MockCpuCache,
  };
});

import { useBridge } from "./useBridge.ts";
import { Bridge, type BridgeHandlers } from "../bridge.ts";
import { ProxiedContentSource } from "../pipeline/fetch/index.ts";
import type { DatasetState } from "../types.ts";
import type { WasmScene } from "lucida-core";

const MockedBridge = Bridge as unknown as { instances: Array<{ handlers: BridgeHandlers }> };
const MockedContentSource = ProxiedContentSource as unknown as {
  instances: Array<{ registerImage: ReturnType<typeof vi.fn> }>;
};

/** The WASM surface the snapshot path touches, as call-recording stubs. */
function makeFakeScene() {
  return {
    load_document: vi.fn(),
    apply_command: vi.fn(),
    available_layouts: vi.fn(() => "[]"),
    export_presence: vi.fn(() => "{}"),
  };
}

function makeManifest(datasetId: string) {
  return {
    dataset_id: datasetId,
    name: `${datasetId}.zarr`,
    kind: "Single",
    entities: [],
    transforms: [],
    images: [
      {
        image_id: `${datasetId}-img`,
        owner: `${datasetId}-entity`,
        multiscale: {
          axes: [
            { name: "t", kind: "Time" },
            { name: "c", kind: "Channel" },
            { name: "z", kind: "Space" },
            { name: "y", kind: "Space" },
            { name: "x", kind: "Space" },
          ],
          levels: [
            {
              level_index: 0,
              shape: [1, 1, 1, 4, 4],
              chunk_shape: [1, 1, 1, 4, 4],
              grid_shape: [1, 1, 1, 1, 1],
              scale: [1, 1, 1, 1, 1],
            },
          ],
          data_type: "Uint16",
          pinned_axes: [],
        },
      },
    ],
    source_layouts: [],
    default_layout_id: null,
  };
}

function snapshotJson(datasetIds: string[]): string {
  const manifests: Record<string, unknown> = {};
  for (const id of datasetIds) manifests[id] = makeManifest(id);
  return JSON.stringify({ manifests });
}

function makeParams(scene: ReturnType<typeof makeFakeScene>) {
  const wasmSceneRef: { current: WasmScene | null } = { current: null };
  return {
    params: {
      workspaceId: "ws-1",
      wasmReady: true,
      wasmSceneRef,
      setWasmScene: vi.fn(),
      ensureScene: vi.fn(() => {
        wasmSceneRef.current = scene as unknown as WasmScene;
        return scene as unknown as WasmScene;
      }),
      loopRef: { current: null },
      canvasRef: { current: null },
      datasetsRef: { current: new Map<string, DatasetState>() },
      datasetCallbacksRef: { current: { removeDataset: vi.fn() } },
      bumpLayerSettingsVersion: vi.fn(),
      initLayerMaps: vi.fn(),
      setSelectedDatasetId: vi.fn(),
      bumpDatasetsVersion: vi.fn(),
      bumpRemoteDocumentVersion: vi.fn(),
    } satisfies Parameters<typeof useBridge>[0],
    wasmSceneRef,
  };
}

beforeEach(() => {
  MockedBridge.instances.length = 0;
  MockedContentSource.instances.length = 0;
});

describe("useBridge mid-session snapshot", () => {
  it("re-applying a snapshot with the same datasets creates no second fetch pipeline or layer maps", () => {
    const scene = makeFakeScene();
    const { params } = makeParams(scene);
    renderHook(() => useBridge(params));
    const handlers = MockedBridge.instances[0].handlers;
    const contentSource = MockedContentSource.instances[0];

    act(() => {
      handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 7, {});
    });
    expect(params.datasetsRef.current.has("wds-1")).toBe(true);
    expect(contentSource.registerImage).toHaveBeenCalledTimes(1);
    expect(params.initLayerMaps).toHaveBeenCalledTimes(1);

    // Mid-session snapshot with the same membership: pure refresh.
    act(() => {
      handlers.onSnapshot(9, snapshotJson(["wds-1"]), [], 7, {});
    });
    expect(scene.load_document).toHaveBeenCalledTimes(2);
    expect(contentSource.registerImage).toHaveBeenCalledTimes(1);
    expect(params.initLayerMaps).toHaveBeenCalledTimes(1);
    expect(params.datasetCallbacksRef.current.removeDataset).not.toHaveBeenCalled();
  });

  it("registers datasets the snapshot adds and removes ones its document no longer contains", () => {
    const scene = makeFakeScene();
    const { params } = makeParams(scene);
    renderHook(() => useBridge(params));
    const handlers = MockedBridge.instances[0].handlers;
    const contentSource = MockedContentSource.instances[0];

    act(() => {
      handlers.onSnapshot(1, snapshotJson(["wds-1", "wds-2"]), [], 7, {});
    });
    expect(params.datasetsRef.current.has("wds-1")).toBe(true);
    expect(params.datasetsRef.current.has("wds-2")).toBe(true);
    expect(contentSource.registerImage).toHaveBeenCalledTimes(2);

    // The resync snapshot no longer contains wds-2 (its remove_dataset was
    // among the lost broadcasts) but adds wds-3 (opened while lagged).
    act(() => {
      handlers.onSnapshot(20, snapshotJson(["wds-1", "wds-3"]), [], 7, {});
    });
    expect(params.datasetCallbacksRef.current.removeDataset).toHaveBeenCalledTimes(1);
    expect(params.datasetCallbacksRef.current.removeDataset).toHaveBeenCalledWith("wds-2");
    // wds-1 kept its pipeline; wds-3 got exactly one new registration.
    expect(contentSource.registerImage).toHaveBeenCalledTimes(3);
    expect(params.datasetsRef.current.has("wds-3")).toBe(true);
  });
});
