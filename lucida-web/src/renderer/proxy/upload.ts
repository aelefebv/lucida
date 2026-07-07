/**
 * Proxy asset upload orchestrator.
 *
 * Reads + mutates per-worker registries via `ctx.state.*` and uses
 * `ctx.state.currentEpochs` for staleness checks.
 *
 * Owns the GPU upload path for a delivered proxy asset:
 *
 *   1. Stale-check against the worker's current cold-state epochs.
 *   2. Validate buffer length against the declared slot dims.
 *   3. Resolve / lazily-create the per-`(datasetId, kind, dims, channel)`
 *      proxy atlas pool.
 *   4. Allocate (or look up) the slot for `(entityId, t, c)` — may evict
 *      the LRU head if the pool is full.
 *   5. Upload via `device.queue.writeTexture`.
 *   6. Update the entity's descriptor. For `GroupProxy3D`, fan out the
 *      handle to every child tile's descriptor (see
 *      {@link propagateGroupProxyToTiles}).
 *
 * Returns an outcome describing what changed so the caller can decide
 * whether to rebuild the per-dataset descriptor buffer (only when the
 * upload's dataset matches the current cold state) and whether to post
 * a wanted-set delta. Keeping those two decisions out of this module
 * means the descriptor-rebuild + wanted-set policies stay co-located in
 * the worker dispatcher.
 */

import {
  proxyDescriptorKey,
  type WorkerCtx,
} from "../workerContext.ts";
import type { ProxyAssetDataMessage } from "../workerProtocol.ts";
import type {
  ProxyAtlasState,
  ProxyHandle,
  ProxyKind,
} from "../proxyAtlas.ts";
import {
  createProxyAtlas,
  allocateProxySlotWithEviction,
  proxyPoolKey,
  proxySlotKey,
  proxySlotOrigin,
  destroyProxyAtlas,
} from "../proxyAtlas.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { propagateGroupProxyToTiles } from "./propagate.ts";
import {
  clearResidentProxyDescriptor,
  desiredProxyCountForPool,
  evaluateProxyDeliveryPolicy,
} from "./residency.ts";
import type { EntityProxyDescriptor } from "../workerContext.ts";
import type { RendererState } from "../worker/state.ts";

/**
 * Legacy capacity when no cold-state desired set is available. Normal
 * policy-driven pools request enough slots for the current desired set
 * for that `(dataset, kind, channel)`.
 */
const PROXY_FALLBACK_POOL_CAPACITY = 64;

/**
 * Outcome of a proxy upload. The caller uses these flags to drive the
 * descriptor-rebuild + wanted-set policies (which need to know about
 * the current cold state / orchestrator wiring this module deliberately
 * does not touch).
 */
export interface ProxyUploadOutcome {
  /** Slot was allocated and descriptor written. Caller should rebuild
   * the per-dataset descriptor buffer IFF the upload's dataset matches
   * the current cold state. */
  rebuildDescriptor: boolean;
  /** Slot allocation / eviction changed which proxies are resident.
   * Caller should recompute and post the wanted-set delta. */
  wantedSetChanged: boolean;
}

function getOrCreateProxyDescriptor(
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
  entityId: string,
  t: number,
  c: number,
): EntityProxyDescriptor {
  const key = proxyDescriptorKey(entityId, t, c);
  let d = proxyDescriptorsByEntity.get(key);
  if (!d) {
    d = { tileProxyHandle: null, groupProxyHandle: null };
    proxyDescriptorsByEntity.set(key, d);
  }
  return d;
}

/**
 * Get-or-create a proxy atlas pool for the given
 * `(datasetId, kind, slotDims, channel)` tuple. Pool key encodes all
 * four so different shapes get independent pools.
 */
function getOrCreateProxyPool(
  device: GPUDevice,
  state: RendererState,
  datasetId: string,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
  requestedCapacity: number,
): { poolKey: string; pool: ProxyAtlasState } {
  const poolKey = proxyPoolKey(datasetId, kind, slotDims, channel);
  let dsPools = state.proxyPoolsByDataset.get(datasetId);
  if (!dsPools) {
    dsPools = new Map();
    state.proxyPoolsByDataset.set(datasetId, dsPools);
  }
  let pool = dsPools.get(poolKey);
  if (!pool) {
    pool = createProxyAtlas(device, kind, slotDims, channel, requestedCapacity);
    dsPools.set(poolKey, pool);
  } else if (pool.requestedCapacity < requestedCapacity) {
    const evictedCount = pool.slots.size;
    for (const [slotKey, slotIndex] of Array.from(pool.slots)) {
      clearResidentProxyDescriptor(state, poolKey, pool.kind, slotKey, slotIndex);
    }
    state.proxyStats.evicted += evictedCount;
    state.proxyStats.evictedPolicy += evictedCount;
    destroyProxyAtlas(pool);
    pool = createProxyAtlas(device, kind, slotDims, channel, requestedCapacity);
    dsPools.set(poolKey, pool);
  }
  return { poolKey, pool };
}

/**
 * Upload a delivered proxy asset to the GPU. Returns an outcome
 * describing what changed so the caller can rebuild the descriptor
 * buffer and post wanted-set deltas as needed.
 */
export function handleProxyUpload(
  ctx: WorkerCtx,
  msg: ProxyAssetDataMessage,
): ProxyUploadOutcome {
  const state = ctx.state;

  // 0. Staleness — drop if older than the current cold-state epoch.
  if (isStaleDelivery(msg.epochs, state.currentEpochs)) {
    state.proxyStats.dropped++;
    state.proxyStats.droppedStale++;
    console.log(
      "[proxy.upload] dropped stale",
      msg.entityId,
      msg.kind,
      `T${msg.t}/C${msg.c}`,
      `(deliveryEpoch=${JSON.stringify(msg.epochs)})`,
    );
    return { rebuildDescriptor: false, wantedSetChanged: false };
  }
  const policy = evaluateProxyDeliveryPolicy(state.currentColdState, msg);
  if (policy.kind !== "accept") {
    state.proxyStats.dropped++;
    if (policy.kind === "not-desired") state.proxyStats.droppedNotDesired++;
    else state.proxyStats.droppedStaleRequest++;
    console.log(
      "[proxy.upload] dropped",
      policy.kind,
      msg.entityId,
      msg.kind,
      `T${msg.t}/C${msg.c}`,
      `(deliveryEpoch=${JSON.stringify(msg.epochs)})`,
    );
    return {
      rebuildDescriptor: false,
      wantedSetChanged: policy.kind === "stale-request" && policy.desired,
    };
  }

  // 1. Validate buffer length.
  const slotDims = msg.dims;
  const [slotZ, slotY, slotX] = slotDims;
  const expectedBytes = slotZ * slotY * slotX * 2;
  if (msg.data.byteLength < expectedBytes) {
    console.warn(
      `[proxy.upload] short buffer (have ${msg.data.byteLength}, need ${expectedBytes}) for ${msg.entityId} ${msg.kind}`,
    );
    return { rebuildDescriptor: false, wantedSetChanged: false };
  }

  // 2. Resolve pool.
  const desiredCount = desiredProxyCountForPool(
    state.currentColdState,
    msg.datasetId,
    msg.kind,
    msg.c,
  );
  const requestedCapacity =
    desiredCount === null
      ? PROXY_FALLBACK_POOL_CAPACITY
      : Math.max(1, desiredCount);
  const { poolKey, pool } = getOrCreateProxyPool(
    ctx.device,
    state,
    msg.datasetId,
    msg.kind,
    slotDims,
    msg.c,
    requestedCapacity,
  );

  // 3. Allocate slot (may evict LRU).
  const compositeKey = proxySlotKey(msg.entityId, msg.t, msg.c);
  const allocation = allocateProxySlotWithEviction(pool, compositeKey);
  const { slotIndex } = allocation;
  if (allocation.evictedKey !== null) {
    state.proxyStats.evicted++;
    state.proxyStats.evictedLru++;
    clearResidentProxyDescriptor(
      state,
      poolKey,
      pool.kind,
      allocation.evictedKey,
      slotIndex,
    );
  }

  // 4. Upload to the slot region.
  const origin = proxySlotOrigin(pool, slotIndex);
  ctx.device.queue.writeTexture(
    { texture: pool.texture, origin },
    msg.data,
    { bytesPerRow: slotX * 2, rowsPerImage: slotY },
    [slotX, slotY, slotZ],
  );

  // 5. Update descriptors.
  const handle: ProxyHandle = { poolKey, slotIndex };
  const desc = getOrCreateProxyDescriptor(
    state.proxyDescriptorsByEntity,
    msg.entityId,
    msg.t,
    msg.c,
  );
  if (msg.kind === "TileProxy3D") {
    desc.tileProxyHandle = handle;
  } else {
    // GroupProxy3D — set on the group itself AND propagate to all child
    // tiles so their `groupProxyHandle` points at the parent's slot.
    desc.groupProxyHandle = handle;
    propagateGroupProxyToTiles(
      handle,
      msg.entityId,
      msg.t,
      msg.c,
      state.groupToTiles,
      state.proxyDescriptorsByEntity,
    );
  }

  state.proxyStats.uploaded++;
  console.log(
    "[proxy.upload] uploaded",
    msg.entityId,
    msg.kind,
    `T${msg.t}/C${msg.c}`,
    `pool=${poolKey}`,
    `slot=${slotIndex}/${pool.capacity}`,
    `dims=${slotDims}`,
  );

  return { rebuildDescriptor: true, wantedSetChanged: true };
}
