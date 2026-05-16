/**
 * Characterization tests for the three `proxyKeyFromX` helpers.
 *
 * Pre-refactor (Slice 1 of PRD #607): pin the contract that
 * `proxyKeyFromDelivery`, `proxyKeyFromRequest`, and `proxyKeyFromMissing`
 * produce the SAME composite string for equivalent input shapes. Tested
 * through the orchestrator's public surface because the helpers are
 * private; once Slice 2 lifts them into `pipeline/upload/proxyKeys.ts`
 * the tests below migrate to direct calls.
 *
 * Contract (orchestrator.ts:1766-1776):
 *   `${datasetId}|${entityId}|${kindOrProxyKind}|${t}|${c}`
 *
 * For each input shape (ReadyProxyDelivery / ProxyRequest / MissingProxy)
 * we trigger the code path that calls the helper and assert the same
 * composite key lands in `proxyDeliveredToWorker` (or is consumed from
 * it on the missing-side delete path).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CpuCache,
  ReadyProxyDelivery,
  ReadyDelivery,
} from "./fetch/index.ts";
import type { TickContext } from "../renderLoopTypes.ts";
import { AssetCatalog } from "./assetCatalog.ts";
import type { ProxyRequest } from "./planning/index.ts";
import type { MissingProxy } from "../renderer/workerProtocol.ts";

const COMMON_KEY = "ds1|field-0|FieldProxy3D|3|2";

/** Equivalent input triples; each shape should resolve to the same composite key. */
const REQ: ProxyRequest = {
  datasetId: "ds1",
  entityId: "field-0",
  imageId: "img-0",
  kind: "FieldProxy3D",
  t: 3,
  c: 2,
  priority: 0,
};
const DELIVERY: ReadyProxyDelivery = {
  kind: "proxy",
  datasetId: "ds1",
  entityId: "field-0",
  imageId: "img-0",
  proxyKind: "FieldProxy3D",
  t: 3,
  c: 2,
  header: {
    algorithmVersion: 1,
    sourceContentHash: new Uint8Array(32),
    dims: [4, 4, 4],
    dtype: "u16",
  },
  data: new ArrayBuffer(128),
  epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
};
const MISSING: MissingProxy = {
  kind: "proxy",
  datasetId: "ds1",
  entityId: "field-0",
  proxyKind: "FieldProxy3D",
  t: 3,
  c: 2,
};

function makeCpuCache(opts: { drainResult?: ReadyDelivery[] } = {}): CpuCache {
  const drained = opts.drainResult ?? [];
  return {
    submit: vi.fn(),
    drain: vi.fn(() => {
      const out = drained.slice();
      drained.length = 0;
      return out;
    }),
    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
    getCached: vi.fn(() => null),
    getCachedChunk: vi.fn(() => null),
    getCachedProxy: vi.fn(() => null),
    telemetry: vi.fn(),
    updateConfig: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    reset: vi.fn(),
    markRejected: vi.fn(),
    clearRejected: vi.fn(),
  } as unknown as CpuCache;
}

function makeCtx(cpuCache: CpuCache): TickContext {
  return {
    scene: { multi_channel: () => false } as unknown,
    datasets: new Map(),
    client: {
      coldState: vi.fn(),
      viewHotState: vi.fn(),
      proxyAssetData: vi.fn(),
    } as unknown,
    canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
    mode: "slice",
    renderScale: 1,
    cpuCache,
    assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
  } as unknown as TickContext;
}

describe("proxyKeyFromDelivery / proxyKeyFromRequest / proxyKeyFromMissing", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Orchestrator = (await import("./orchestrator.ts")).Orchestrator;
  });

  it("proxyKeyFromDelivery: drain-path delivery adds the canonical composite key", () => {
    const orch = new Orchestrator();
    const cpuCache = makeCpuCache({ drainResult: [DELIVERY] });
    orch.deliverToWorker(makeCtx(cpuCache), 8 * 1024 * 1024, null);

    expect(orch.getProxyDeliveredKeys().has(COMMON_KEY)).toBe(true);
  });

  it("proxyKeyFromRequest: resend pass dedupes against the same composite key", () => {
    const orch = new Orchestrator();
    // Pre-populate _lastProxyRequests so resend has work to consider.
    (orch as unknown as { _lastProxyRequests: ProxyRequest[] })._lastProxyRequests = [REQ];
    // Seed the delivered set with the request-shape's composite key.
    orch.getProxyDeliveredKeys().add(COMMON_KEY);

    const cpuCache = makeCpuCache();
    const proxyAssetData = vi.fn();
    const ctx = makeCtx(cpuCache);
    (ctx.client as unknown as { proxyAssetData: typeof proxyAssetData }).proxyAssetData =
      proxyAssetData;

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);

    // Skipped on the resend pass because the request-derived key
    // matches the delivery-derived key already in the set.
    expect(proxyAssetData).not.toHaveBeenCalled();
  });

  it("proxyKeyFromMissing: handleWantedSetDelta deletes by the same composite key", () => {
    const orch = new Orchestrator();
    orch.getProxyDeliveredKeys().add(COMMON_KEY);
    expect(orch.getProxyDeliveredKeys().has(COMMON_KEY)).toBe(true);

    orch.handleWantedSetDelta([MISSING]);

    expect(orch.getProxyDeliveredKeys().has(COMMON_KEY)).toBe(false);
  });
});
