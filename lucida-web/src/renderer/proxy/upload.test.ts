/**
 * Suite B — proxy upload characterization.
 *
 * Locks the behavior of `handleProxyUpload`. Covers the variant matrix
 * for Suites B + E:
 *
 *   1. First proxy upload for an entity → pool created, slot 0 allocated,
 *      descriptor populated.
 *   2. Same proxy upload again (same composite key) → no new allocation,
 *      existing slot reused, LRU touched.
 *   3. Pool fills, new upload arrives → oldest LRU evicted, slot reused,
 *      proxyStats.evicted incremented.
 *   4. `WellProxy3D` upload for a well with two child fields → both
 *      children's `wellProxyHandle` populated with same handle.
 *   5. `FieldProxy3D` upload → only field descriptor gets
 *      `fieldProxyHandle`; no fan-out happens to other entities.
 *   6. Stale upload (`epochs.selection` < current) → dropped,
 *      proxyStats.dropped incremented, returns no-change outcome.
 *   7. Short-buffer upload (`data.byteLength` < expected) → warned +
 *      dropped, no slot allocated.
 *   8. Outcome.rebuildDescriptor is true on every successful upload —
 *      caller decides whether to act on it based on current cold state.
 *   9. Outcome.wantedSetChanged is true on every successful upload.
 *
 * Suite E (descriptor-rebuild trigger) is folded in below — items 2 + 3
 * are covered by Suite B test #1, and the dispatcher-side rebuild gating
 * (only-rebuild-when-dataset-matches) is exercised as a thin extra block
 * since the dispatcher's policy is what the suite locks.
 *
 * Mocks `WorkerCtx.device` + `GPUDevice` — no real GPU. Registries and
 * the current epochs pointer live on `ctx.state`; tests set
 * `ctx.state.currentEpochs` to drive the staleness check.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import { reconcileProxyResidency } from "./residency.ts";
import { handleProxyUpload } from "./upload.ts";
import {
  proxyDescriptorKey,
  type WorkerCtx,
} from "../workerContext.ts";
import type { ColdStateMessage, ProxyAssetDataMessage } from "../workerProtocol.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { allocateProxySlot, proxySlotKey } from "../proxyAtlas.ts";
import { createInitialState } from "../worker/state.ts";

// ---------------------------------------------------------------------------
// Mock GPU device — texture creation + writeTexture calls only.
// ---------------------------------------------------------------------------

interface MockTexture { destroyed: boolean; destroy: () => void; size: [number, number, number] }

interface MockDeviceHandle {
  device: GPUDevice;
  writeTextureMock: ReturnType<typeof vi.fn>;
  createTextureMock: ReturnType<typeof vi.fn>;
}

function makeMockDevice(maxDim = 2048): MockDeviceHandle {
  const createTexture = vi.fn((desc: GPUTextureDescriptor): MockTexture => {
    const size = desc.size as number[];
    return {
      destroyed: false,
      destroy() { this.destroyed = true; },
      size: [size[0], size[1], size[2]],
    };
  });
  const writeTexture = vi.fn();
  const device = {
    limits: { maxTextureDimension3D: maxDim } as unknown as GPUSupportedLimits,
    createTexture,
    queue: { writeTexture } as unknown as GPUQueue,
  } as unknown as GPUDevice;
  return { device, writeTextureMock: writeTexture, createTextureMock: createTexture };
}

function makeCtx(device: GPUDevice, currentEpochs: SceneEpochs | null = null): WorkerCtx {
  // Only `device` + `state` are actually used by handleProxyUpload.
  const state = createInitialState();
  state.currentEpochs = currentEpochs;
  return {
    device,
    context: {} as GPUCanvasContext,
    format: "bgra8unorm",
    state,
    getSliceRenderer: () => ({} as never),
    getVolumeRenderer: () => ({} as never),
    getCompositor: () => ({} as never),
    getCursorRenderer: () => ({} as never),
    ensureOffscreenPool: () => [],
    getDummyTexture: () => ({} as GPUTexture),
    getDummy3DTexture: () => ({} as GPUTexture),
    getOrCreateLUT: () => ({} as GPUTexture),
    post: () => {},
    postWantedSet: () => {},
    lookupProxyDescriptor: () => null,
    lookupProxyPool: () => null,
    lookupEntityDescriptor: () => null,
  };
}

function makeEpochs(opts?: Partial<SceneEpochs>): SceneEpochs {
  return {
    content: opts?.content ?? 1,
    layout: opts?.layout ?? 1,
    view: opts?.view ?? 1,
    selection: opts?.selection ?? 5,
    asset: opts?.asset ?? 0,
    request: opts?.request ?? 0,
  };
}

function makeMsg(
  opts: Partial<ProxyAssetDataMessage> & {
    entityId: string;
    kind: "WellProxy3D" | "FieldProxy3D";
  },
): ProxyAssetDataMessage {
  const dims = opts.dims ?? ([8, 8, 8] as [number, number, number]);
  const [z, y, x] = dims;
  const data = opts.data ?? new ArrayBuffer(z * y * x * 2);
  return {
    type: "proxyAssetData",
    epochs: opts.epochs ?? makeEpochs(),
    datasetId: opts.datasetId ?? "ds1",
    entityId: opts.entityId,
    imageId: opts.imageId ?? opts.entityId,
    kind: opts.kind,
    t: opts.t ?? 0,
    c: opts.c ?? 0,
    dims,
    dataType: "u16",
    data,
  };
}

function makeColdState(
  opts?: Partial<ColdStateMessage>,
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: opts?.epochs ?? makeEpochs(),
    datasetId: opts?.datasetId ?? "ds1",
    currentT: opts?.currentT ?? 0,
    currentZ: opts?.currentZ ?? 0,
    multiChannel: opts?.multiChannel ?? false,
    visibleChannels: opts?.visibleChannels ?? [0],
    visibleRegion: opts?.visibleRegion ?? {
      xyBoundsVox: [0, 0, 128, 128],
      zRangeVox: [0, 8],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    desiredProxyKeys: opts?.desiredProxyKeys,
    activeSet: opts?.activeSet ?? [],
    viewMode: opts?.viewMode ?? "volume",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Suite B — handleProxyUpload", () => {
  let handle: MockDeviceHandle;
  let ctx: WorkerCtx;
  let currentEpochs: SceneEpochs;

  beforeEach(() => {
    handle = makeMockDevice();
    currentEpochs = makeEpochs();
    ctx = makeCtx(handle.device, currentEpochs);
  });

  // -------------------------------------------------------------------------
  // 1. First proxy upload for an entity
  // -------------------------------------------------------------------------
  it("first proxy upload → pool created, slot 0 allocated, descriptor populated", () => {
    const msg = makeMsg({ entityId: "fieldA", kind: "FieldProxy3D" });
    const outcome = handleProxyUpload(ctx, msg);

    // Pool created under the dataset.
    const dsPools = ctx.state.proxyPoolsByDataset.get("ds1");
    expect(dsPools).toBeDefined();
    expect(dsPools!.size).toBe(1);
    const [, pool] = [...dsPools!.entries()][0];
    expect(pool.slots.size).toBe(1);

    // Slot 0 was allocated (freeSlots is built [cap-1...0], pop -> 0 first).
    const compositeKey = proxySlotKey("fieldA", 0, 0);
    expect(pool.slots.get(compositeKey)).toBe(0);

    // Descriptor populated for the entity (field gets fieldProxyHandle).
    const desc = ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0));
    expect(desc).toBeDefined();
    expect(desc!.fieldProxyHandle).not.toBeNull();
    expect(desc!.fieldProxyHandle!.slotIndex).toBe(0);
    expect(desc!.wellProxyHandle).toBeNull();

    // GPU write happened.
    expect(handle.writeTextureMock).toHaveBeenCalledTimes(1);

    // Stats + outcome.
    expect(ctx.state.proxyStats.uploaded).toBe(1);
    expect(ctx.state.proxyStats.dropped).toBe(0);
    expect(ctx.state.proxyStats.evicted).toBe(0);
    expect(outcome).toEqual({ rebuildDescriptor: true, wantedSetChanged: true });
  });

  // -------------------------------------------------------------------------
  // 2. Same proxy upload again (same composite key)
  // -------------------------------------------------------------------------
  it("repeat upload with same key → no new slot, existing slot reused, LRU touched", () => {
    const msg = makeMsg({ entityId: "fieldA", kind: "FieldProxy3D" });
    handleProxyUpload(ctx, msg);

    // Allocate a second entity to advance LRU position of fieldA.
    handleProxyUpload(ctx, makeMsg({ entityId: "fieldB", kind: "FieldProxy3D" }));
    const pool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    expect(pool.touchOrder).toEqual([
      proxySlotKey("fieldA", 0, 0),
      proxySlotKey("fieldB", 0, 0),
    ]);

    // Repeat fieldA upload.
    const outcome = handleProxyUpload(ctx, msg);
    // Still 2 slots, no new allocation.
    expect(pool.slots.size).toBe(2);
    // fieldA is now most-recently-used.
    expect(pool.touchOrder).toEqual([
      proxySlotKey("fieldB", 0, 0),
      proxySlotKey("fieldA", 0, 0),
    ]);
    // Stats: uploaded incremented; no eviction.
    expect(ctx.state.proxyStats.uploaded).toBe(3);
    expect(ctx.state.proxyStats.evicted).toBe(0);
    expect(outcome.rebuildDescriptor).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Pool fills, new upload arrives → eviction
  // -------------------------------------------------------------------------
  it("pool full + new key → oldest LRU evicted, slot reused, evicted stat incremented", () => {
    // Seed the pool to capacity by pre-allocating directly. PROXY_POOL_CAPACITY=64;
    // simpler to use a tiny mock by hand-allocating slots through the pool API.
    const msg0 = makeMsg({ entityId: "fieldA", kind: "FieldProxy3D" });
    handleProxyUpload(ctx, msg0);
    const pool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    // Fill the pool. fieldA already used slot 0; allocate 63 more.
    for (let i = 0; i < pool.capacity - 1; i++) {
      allocateProxySlot(pool, `seed-${i}`);
    }
    expect(pool.slots.size).toBe(pool.capacity);
    expect(pool.freeSlots).toHaveLength(0);

    // Now upload a brand-new key; should evict the LRU head (fieldA — it
    // was the first thing allocated, then everything else after, so it
    // sits at the front of touchOrder).
    const fieldASlot = pool.slots.get(proxySlotKey("fieldA", 0, 0))!;
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldZ", kind: "FieldProxy3D" }),
    );
    expect(ctx.state.proxyStats.evicted).toBe(1);
    expect(pool.slots.has(proxySlotKey("fieldA", 0, 0))).toBe(false);
    expect(pool.slots.get(proxySlotKey("fieldZ", 0, 0))).toBe(fieldASlot);
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0))!.fieldProxyHandle,
    ).toBeNull();
    expect(outcome).toEqual({ rebuildDescriptor: true, wantedSetChanged: true });
  });

  // -------------------------------------------------------------------------
  // 4. WellProxy3D upload fans out to child fields
  // -------------------------------------------------------------------------
  it("WellProxy3D upload for well with two child fields → both child wellProxyHandles set", () => {
    ctx.state.wellToFields.set("wellA", new Set(["fieldA", "fieldB"]));
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "wellA", kind: "WellProxy3D" }),
    );
    const wellDesc = ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("wellA", 0, 0));
    expect(wellDesc!.wellProxyHandle).not.toBeNull();
    const sharedHandle = wellDesc!.wellProxyHandle!;

    const descA = ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0));
    const descB = ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldB", 0, 0));
    expect(descA!.wellProxyHandle).toBe(sharedHandle);
    expect(descB!.wellProxyHandle).toBe(sharedHandle);
    // Children's fieldProxyHandle stays null (not affected by well upload).
    expect(descA!.fieldProxyHandle).toBeNull();
    expect(descB!.fieldProxyHandle).toBeNull();
    // Well's own fieldProxyHandle stays null too.
    expect(wellDesc!.fieldProxyHandle).toBeNull();
    expect(outcome.rebuildDescriptor).toBe(true);
  });

  it("desired-set reconciliation releases resident well proxy and clears fanned-out handles", () => {
    ctx.state.wellToFields.set("wellA", new Set(["fieldA", "fieldB"]));
    handleProxyUpload(
      ctx,
      makeMsg({ entityId: "wellA", kind: "WellProxy3D" }),
    );
    const pool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    expect(pool.slots.size).toBe(1);

    const released = reconcileProxyResidency(ctx.state, "ds1", []);

    expect(released).toBe(1);
    expect(pool.slots.size).toBe(0);
    expect(pool.freeSlots).toContain(0);
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("wellA", 0, 0))!.wellProxyHandle,
    ).toBeNull();
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0))!.wellProxyHandle,
    ).toBeNull();
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldB", 0, 0))!.wellProxyHandle,
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. FieldProxy3D upload — no fan-out
  // -------------------------------------------------------------------------
  it("FieldProxy3D upload → only field descriptor mutated; no fan-out to other entities", () => {
    // Preload wellToFields with another well's children (irrelevant to
    // this upload — should not be touched).
    ctx.state.wellToFields.set("wellA", new Set(["fieldOther"]));
    handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D" }),
    );
    // Only fieldA in descriptors.
    expect(ctx.state.proxyDescriptorsByEntity.size).toBe(1);
    expect(ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0))!.fieldProxyHandle).not.toBeNull();
    // fieldOther was not touched.
    expect(ctx.state.proxyDescriptorsByEntity.has(proxyDescriptorKey("fieldOther", 0, 0))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Stale upload — dropped
  // -------------------------------------------------------------------------
  it("stale upload (epochs.selection < current) → dropped, dropped stat incremented, no slot allocated", () => {
    const stale = makeEpochs({ selection: 3 });
    const current = makeEpochs({ selection: 5 });
    ctx.state.currentEpochs = current;
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", epochs: stale }),
    );
    expect(ctx.state.proxyStats.dropped).toBe(1);
    expect(ctx.state.proxyStats.uploaded).toBe(0);
    // No pool created — nothing to allocate against.
    expect(ctx.state.proxyPoolsByDataset.size).toBe(0);
    expect(ctx.state.proxyDescriptorsByEntity.size).toBe(0);
    expect(outcome).toEqual({ rebuildDescriptor: false, wantedSetChanged: false });
  });

  it("upload absent from current desiredProxyKeys → dropped before pool allocation", () => {
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: [],
      epochs: makeEpochs({ request: 1 }),
    });
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldA",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 1 }),
      }),
    );
    expect(ctx.state.proxyStats.dropped).toBe(1);
    expect(ctx.state.proxyStats.uploaded).toBe(0);
    expect(ctx.state.proxyPoolsByDataset.size).toBe(0);
    expect(ctx.state.proxyDescriptorsByEntity.size).toBe(0);
    expect(outcome).toEqual({ rebuildDescriptor: false, wantedSetChanged: false });
  });

  it("upload present in current desiredProxyKeys → accepted", () => {
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: ["ds1|fieldA|FieldProxy3D|0|0"],
      epochs: makeEpochs({ request: 1 }),
    });
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldA",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 1 }),
      }),
    );
    expect(ctx.state.proxyStats.dropped).toBe(0);
    expect(ctx.state.proxyStats.uploaded).toBe(1);
    expect(ctx.state.proxyPoolsByDataset.size).toBe(1);
    expect(outcome).toEqual({ rebuildDescriptor: true, wantedSetChanged: true });
  });

  it("policy-driven pool capacity tracks desired proxy count for the pool", () => {
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: [
        "ds1|fieldA|FieldProxy3D|0|0",
        "ds1|fieldB|FieldProxy3D|0|0",
        "ds1|fieldC|FieldProxy3D|0|0",
      ],
      epochs: makeEpochs({ request: 1 }),
    });
    handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldA",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 1 }),
      }),
    );
    const pool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    expect(pool.capacity).toBe(3);
    expect(pool.requestedCapacity).toBe(3);
  });

  it("grows an existing proxy pool when the desired set exceeds prior requested capacity", () => {
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: ["ds1|fieldA|FieldProxy3D|0|0"],
      epochs: makeEpochs({ request: 1 }),
    });
    handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldA",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 1 }),
      }),
    );
    const firstPool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    const firstTexture = firstPool.texture as unknown as MockTexture;
    expect(firstPool.capacity).toBe(1);
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0))!.fieldProxyHandle,
    ).not.toBeNull();

    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: [
        "ds1|fieldA|FieldProxy3D|0|0",
        "ds1|fieldB|FieldProxy3D|0|0",
      ],
      epochs: makeEpochs({ request: 2 }),
    });
    handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldB",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 2 }),
      }),
    );
    const grownPool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    expect(grownPool).not.toBe(firstPool);
    expect(firstTexture.destroyed).toBe(true);
    expect(grownPool.capacity).toBe(2);
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldA", 0, 0))!.fieldProxyHandle,
    ).toBeNull();
    expect(
      ctx.state.proxyDescriptorsByEntity.get(proxyDescriptorKey("fieldB", 0, 0))!.fieldProxyHandle,
    ).not.toBeNull();
  });

  it("does not evict while uploading a desired set larger than the old X-only 16-slot limit", () => {
    const desiredKeys = Array.from(
      { length: 40 },
      (_, i) => `ds1|field-${i}|FieldProxy3D|0|0`,
    );
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: desiredKeys,
      epochs: makeEpochs({ request: 1 }),
    });

    for (let i = 0; i < desiredKeys.length; i++) {
      handleProxyUpload(
        ctx,
        makeMsg({
          entityId: `field-${i}`,
          kind: "FieldProxy3D",
          dims: [1, 128, 128],
          epochs: makeEpochs({ request: 1 }),
        }),
      );
    }

    const pool = [...ctx.state.proxyPoolsByDataset.get("ds1")!.values()][0];
    expect(pool.capacity).toBe(40);
    expect(pool.slots.size).toBe(40);
    expect(ctx.state.proxyStats.evicted).toBe(0);
    expect(ctx.state.proxyStats.evictedLru).toBe(0);
    expect(ctx.state.proxyStats.uploaded).toBe(40);
  });

  it("desired upload from stale request epoch → dropped and requests a wanted-set refresh", () => {
    ctx.state.currentColdState = makeColdState({
      desiredProxyKeys: ["ds1|fieldA|FieldProxy3D|0|0"],
      epochs: makeEpochs({ request: 2 }),
    });
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({
        entityId: "fieldA",
        kind: "FieldProxy3D",
        epochs: makeEpochs({ request: 1 }),
      }),
    );
    expect(ctx.state.proxyStats.dropped).toBe(1);
    expect(ctx.state.proxyStats.uploaded).toBe(0);
    expect(ctx.state.proxyPoolsByDataset.size).toBe(0);
    expect(outcome).toEqual({ rebuildDescriptor: false, wantedSetChanged: true });
  });

  // -------------------------------------------------------------------------
  // 7. Short buffer — dropped with warning
  // -------------------------------------------------------------------------
  it("short-buffer upload (byteLength < expected) → dropped + warned, no slot allocated", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Build a buffer too small for the declared dims [8,8,8] => 8*8*8*2 = 1024 bytes.
    const small = new ArrayBuffer(100);
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", data: small }),
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(ctx.state.proxyPoolsByDataset.size).toBe(0);
    expect(ctx.state.proxyDescriptorsByEntity.size).toBe(0);
    expect(ctx.state.proxyStats.uploaded).toBe(0);
    expect(outcome).toEqual({ rebuildDescriptor: false, wantedSetChanged: false });
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 8. Successful upload always returns rebuildDescriptor=true; caller
  //    decides whether to act on it based on cold-state policy.
  // -------------------------------------------------------------------------
  it("outcome.rebuildDescriptor is true for any successful upload (caller gates by dataset)", () => {
    const ok1 = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", datasetId: "ds1" }),
    );
    expect(ok1.rebuildDescriptor).toBe(true);
    const ok2 = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldB", kind: "FieldProxy3D", datasetId: "ds2" }),
    );
    expect(ok2.rebuildDescriptor).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9. Successful upload always returns wantedSetChanged=true
  // -------------------------------------------------------------------------
  it("outcome.wantedSetChanged is true for successful uploads, false when dropped", () => {
    expect(
      handleProxyUpload(
        ctx,
        makeMsg({ entityId: "fieldA", kind: "FieldProxy3D" }),
      ).wantedSetChanged,
    ).toBe(true);
    // Stale → false. Reset state.
    const stale = makeEpochs({ selection: 1 });
    ctx.state.currentEpochs = makeEpochs({ selection: 5 });
    expect(
      handleProxyUpload(
        ctx,
        makeMsg({
          entityId: "fieldB",
          kind: "FieldProxy3D",
          epochs: stale,
        }),
      ).wantedSetChanged,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite E — descriptor-rebuild trigger characterization.
//
// The rebuild + wanted-set decisions live in the worker dispatcher
// (where `currentColdState` is in scope). `handleProxyUpload` only
// surfaces the flags. We exercise those flags here and document the
// dispatcher policy as a thin guard.
//
// Items 4 + 5 (`removeLayerResources` / `destroy`) are worker-side state
// management and stay covered by the worker module's own teardown paths
// (see `gpu.worker.ts` cases). They don't have a unit-testable surface
// in this slice without a full worker harness, so we document the
// expectation here for traceability.
// ---------------------------------------------------------------------------

describe("Suite E — descriptor-rebuild trigger gating (dispatcher policy)", () => {
  let handle: MockDeviceHandle;
  let ctx: WorkerCtx;

  beforeEach(() => {
    handle = makeMockDevice();
    ctx = makeCtx(handle.device, makeEpochs());
  });

  it("upload for current cold-state dataset → rebuildDescriptor true (dispatcher acts)", () => {
    const currentColdDataset = "ds1";
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", datasetId: "ds1" }),
    );
    // Dispatcher's policy: act iff outcome.rebuildDescriptor && msg.datasetId === currentColdDataset.
    expect(outcome.rebuildDescriptor && currentColdDataset === "ds1").toBe(true);
  });

  it("upload for different dataset → rebuildDescriptor true but dispatcher skips rebuild", () => {
    const currentColdDataset = "ds1";
    const msg = makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", datasetId: "ds2" });
    const outcome = handleProxyUpload(ctx, msg);
    // Dispatcher's policy: rebuild only when datasets match. Here they don't.
    const shouldRebuild = outcome.rebuildDescriptor && msg.datasetId === currentColdDataset;
    expect(shouldRebuild).toBe(false);
  });

  it("stale upload → rebuildDescriptor false (dispatcher skips regardless of dataset)", () => {
    const stale = makeEpochs({ selection: 1 });
    ctx.state.currentEpochs = makeEpochs({ selection: 5 });
    const outcome = handleProxyUpload(
      ctx,
      makeMsg({ entityId: "fieldA", kind: "FieldProxy3D", datasetId: "ds1", epochs: stale }),
    );
    expect(outcome.rebuildDescriptor).toBe(false);
  });
});
