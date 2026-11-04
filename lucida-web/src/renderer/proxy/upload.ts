/**
 * Proxy asset upload: stale-check, slot allocation (LRU eviction when the
 * pool is full), texture write, and descriptor update, with `GroupProxy3D`
 * handles fanned out to every child tile.
 *
 * It returns what changed instead of acting on it, so the descriptor-rebuild
 * and wanted-set policies stay together in the worker dispatcher.
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
 * Pool capacity when no cold-state desired set is available. Otherwise a
 * pool requests one slot per desired proxy for its `(dataset, kind, channel)`.
 */
const PROXY_FALLBACK_POOL_CAPACITY = 64;

/** What a proxy upload changed. The caller applies the rebuild and wanted-set policies. */
export interface ProxyUploadOutcome {
  /** A descriptor was written. Rebuild the descriptor buffer iff the dataset is the current cold state. */
  rebuildDescriptor: boolean;
  /** Which proxies are resident changed. Post a wanted-set delta. */
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

/** Get or create the proxy atlas pool for `(datasetId, kind, slotDims, channel)`. */
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

/** Upload a delivered proxy asset to the GPU and report what changed. */
export function handleProxyUpload(
  ctx: WorkerCtx,
  msg: ProxyAssetDataMessage,
): ProxyUploadOutcome {
  const state = ctx.state;

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

  const slotDims = msg.dims;
  const [slotZ, slotY, slotX] = slotDims;
  const expectedBytes = slotZ * slotY * slotX * 2;
  if (msg.data.byteLength < expectedBytes) {
    console.warn(
      `[proxy.upload] short buffer (have ${msg.data.byteLength}, need ${expectedBytes}) for ${msg.entityId} ${msg.kind}`,
    );
    return { rebuildDescriptor: false, wantedSetChanged: false };
  }

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

  const origin = proxySlotOrigin(pool, slotIndex);
  ctx.device.queue.writeTexture(
    { texture: pool.texture, origin },
    msg.data,
    { bytesPerRow: slotX * 2, rowsPerImage: slotY },
    [slotX, slotY, slotZ],
  );

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
    // GroupProxy3D: set on the group and propagate to every child tile so
    // their `groupProxyHandle` points at the parent's slot.
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
