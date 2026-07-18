// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";

// The connection stack useBridge bootstraps holds real resources (WebSocket,
// decode workers, request timers). Replace each class with an
// instance-recording double so the tests can assert construction/teardown
// pairing without a transport or worker runtime.
vi.mock("../bridge.ts", () => {
  class MockBridge {
    static instances: MockBridge[] = [];
    workspaceId: string | undefined;
    destroy = vi.fn();
    send = vi.fn();
    sendCommand = vi.fn();
    sendPresence = vi.fn();
    sendDatasetPresence = vi.fn();
    sendCursor = vi.fn();
    sendFollow = vi.fn();
    sendOpenRemoteDataset = vi.fn();
    constructor(_handlers: unknown, _url?: string, workspaceId?: string) {
      this.workspaceId = workspaceId;
      MockBridge.instances.push(this);
    }
  }
  return { Bridge: MockBridge, bridgeLog: vi.fn() };
});

vi.mock("../pipeline/fetch/index.ts", () => {
  class MockDecodePool {
    static instances: MockDecodePool[] = [];
    size = 2;
    terminate = vi.fn();
    constructor() {
      MockDecodePool.instances.push(this);
    }
  }
  class MockProxiedContentSource {
    static instances: MockProxiedContentSource[] = [];
    rejectAll = vi.fn();
    rejectDataset = vi.fn();
    registerImage = vi.fn();
    handleBinary = vi.fn();
    handleChunkStatus = vi.fn();
    handleTransportReady = vi.fn();
    constructor(_send: unknown) {
      MockProxiedContentSource.instances.push(this);
    }
  }
  class MockCpuCache {
    static instances: MockCpuCache[] = [];
    reset = vi.fn();
    constructor(_source: unknown, _pool: unknown) {
      MockCpuCache.instances.push(this);
    }
  }
  return {
    DecodePool: MockDecodePool,
    ProxiedContentSource: MockProxiedContentSource,
    CpuCache: MockCpuCache,
  };
});

import { useBridge } from "./useBridge.ts";
import { Bridge } from "../bridge.ts";
import { DecodePool, ProxiedContentSource, CpuCache } from "../pipeline/fetch/index.ts";
import type { DatasetState } from "../types.ts";

interface Recorded {
  instances: Array<Record<string, ReturnType<typeof vi.fn>> & { workspaceId?: string }>;
}

const MockedBridge = Bridge as unknown as Recorded;
const MockedDecodePool = DecodePool as unknown as Recorded;
const MockedContentSource = ProxiedContentSource as unknown as Recorded;
const MockedCpuCache = CpuCache as unknown as Recorded;

function makeParams(wasmReady = true): Parameters<typeof useBridge>[0] {
  return {
    workspaceId: "ws-1",
    wasmReady,
    wasmSceneRef: { current: null },
    setWasmScene: vi.fn(),
    ensureScene: vi.fn() as unknown as Parameters<typeof useBridge>[0]["ensureScene"],
    loopRef: { current: null },
    datasetsRef: { current: new Map<string, DatasetState>() },
    datasetCallbacksRef: { current: { removeDataset: vi.fn() } },
    bumpLayerSettingsVersion: vi.fn(),
    initLayerMaps: vi.fn(),
    setZ: vi.fn(),
    setC: vi.fn(),
    setT: vi.fn(),
    setViewMode: vi.fn(),
    setMultiChannel: vi.fn(),
    setSelectedDatasetId: vi.fn(),
    bumpDatasetsVersion: vi.fn(),
    bumpRemoteDocumentVersion: vi.fn(),
  };
}

beforeEach(() => {
  MockedBridge.instances.length = 0;
  MockedDecodePool.instances.length = 0;
  MockedContentSource.instances.length = 0;
  MockedCpuCache.instances.length = 0;
});

describe("useBridge teardown ownership", () => {
  it("bootstraps one connection stack once wasm is ready", () => {
    const params = makeParams();
    const { result } = renderHook(() => useBridge(params));

    expect(MockedBridge.instances).toHaveLength(1);
    expect(MockedBridge.instances[0].workspaceId).toBe("ws-1");
    expect(MockedDecodePool.instances).toHaveLength(1);
    expect(MockedContentSource.instances).toHaveLength(1);
    expect(MockedCpuCache.instances).toHaveLength(1);
    expect(result.current.sessionRef.current).not.toBeNull();
    expect(result.current.bridge).toBe(
      MockedBridge.instances[0] as unknown as typeof result.current.bridge,
    );
  });

  it("does nothing before wasm is ready", () => {
    const params = makeParams(false);
    const { result, unmount } = renderHook(() => useBridge(params));

    expect(MockedBridge.instances).toHaveLength(0);
    expect(result.current.sessionRef.current).toBeNull();
    expect(() => unmount()).not.toThrow();
  });

  it("unmount releases everything the bootstrap effect constructed", () => {
    const params = makeParams();
    params.datasetsRef.current.set("ds-1", { id: "ds-1" } as unknown as DatasetState);
    const { result, unmount } = renderHook(() => useBridge(params));
    const sessionRef = result.current.sessionRef;

    unmount();

    expect(MockedBridge.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(MockedCpuCache.instances[0].reset).toHaveBeenCalledTimes(1);
    expect(MockedContentSource.instances[0].rejectAll).toHaveBeenCalledTimes(1);
    expect(MockedDecodePool.instances[0].terminate).toHaveBeenCalledTimes(1);
    // The dead stack must not be consulted by any later bootstrap: the
    // session handle and the per-connection dataset registry are dropped.
    expect(sessionRef.current).toBeNull();
    expect(params.datasetsRef.current.size).toBe(0);
  });

  it("StrictMode mount→cleanup→mount tears down the first stack and leaves a fresh working one", () => {
    const params = makeParams();
    const { result, unmount } = renderHook(() => useBridge(params), {
      wrapper: StrictMode,
    });

    // Dev StrictMode runs the bootstrap effect twice; each run must own a
    // full stack, with the first torn down before the second exists.
    expect(MockedBridge.instances).toHaveLength(2);
    expect(MockedBridge.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(MockedBridge.instances[1].destroy).not.toHaveBeenCalled();
    expect(MockedDecodePool.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(MockedDecodePool.instances[1].terminate).not.toHaveBeenCalled();

    // The surviving session is the second stack, fully wired.
    const session = result.current.sessionRef.current;
    expect(session).not.toBeNull();
    expect(session!.bridge as unknown).toBe(MockedBridge.instances[1]);

    unmount();
    expect(MockedBridge.instances[1].destroy).toHaveBeenCalledTimes(1);
    expect(MockedDecodePool.instances[1].terminate).toHaveBeenCalledTimes(1);
  });
});
