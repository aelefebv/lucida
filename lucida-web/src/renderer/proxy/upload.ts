/**
 * Proxy asset upload orchestrator.
 *
 * Extracted from `gpu.worker.ts:handleProxyAssetData` (Slice 5). Owns
 * the GPU upload path for a delivered proxy asset:
 *
 *   1. Stale-check against the worker's current cold-state epochs.
 *   2. Validate buffer length against the declared slot dims.
 *   3. Resolve / lazily-create the per-`(datasetId, kind, dims, channel)`
 *      proxy atlas pool.
 *   4. Allocate (or look up) the slot for `(entityId, t, c)` — may evict
 *      the LRU head if the pool is full.
 *   5. Upload via `device.queue.writeTexture`.
 *   6. Update the entity's descriptor. For `WellProxy3D`, fan out the
 *      handle to every child field's descriptor (see
 *      {@link propagateWellProxyToFields}).
 *
 * Returns an outcome describing what changed so the caller can decide
 * whether to rebuild the per-dataset descriptor buffer (only when the
 * upload's dataset matches the current cold state) and whether to post
 * a wanted-set delta. Keeping those two decisions out of this module
 * means the descriptor-rebuild + wanted-set policies stay co-located in
 * the worker dispatcher.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ProxyAssetDataMessage } from "../workerProtocol.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import type {
  ProxyAtlasState,
  ProxyHandle,
  ProxyKind,
} from "../proxyAtlas.ts";
import {
  createProxyAtlas,
  allocateProxySlot,
  proxyPoolKey,
  proxySlotKey,
  proxySlotOrigin,
} from "../proxyAtlas.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { propagateWellProxyToFields } from "./propagate.ts";
import type { EntityProxyDescriptor } from "../workerContext.ts";

/**
 * Default capacity per proxy pool. 64 keeps memory modest (a 64³ slot
 * × 64 = 16 MiB per pool at u16) while comfortably covering visible
 * wells/fields in typical plate views. Mirrors the value in
 * `gpu.worker.ts` (intentionally duplicated until Slice 10 centralizes
 * hardware/limit constants).
 */
const PROXY_POOL_CAPACITY = 64;

/**
 * Registries `handleProxyUpload` reads + mutates. Passed in explicitly
 * so this slice doesn't depend on Slice 8 (state ownership cleanup);
 * the worker module still owns the actual Maps. Same pattern as
 * `ColdStateRegistries` in `coldState/apply.ts`.
 */
export interface ProxyUploadRegistries {
  proxyPoolsByDataset: Map<string, Map<string, ProxyAtlasState>>;
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>;
  wellToFields: Map<string, Set<string>>;
  proxyStats: { uploaded: number; dropped: number; evicted: number };
}

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
): EntityProxyDescriptor {
  let d = proxyDescriptorsByEntity.get(entityId);
  if (!d) {
    d = { fieldProxyHandle: null, wellProxyHandle: null };
    proxyDescriptorsByEntity.set(entityId, d);
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
  poolsByDataset: Map<string, Map<string, ProxyAtlasState>>,
  datasetId: string,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
): { poolKey: string; pool: ProxyAtlasState } {
  const poolKey = proxyPoolKey(datasetId, kind, slotDims, channel);
  let dsPools = poolsByDataset.get(datasetId);
  if (!dsPools) {
    dsPools = new Map();
    poolsByDataset.set(datasetId, dsPools);
  }
  let pool = dsPools.get(poolKey);
  if (!pool) {
    pool = createProxyAtlas(device, kind, slotDims, channel, PROXY_POOL_CAPACITY);
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
  currentEpochs: SceneEpochs | null,
  registries: ProxyUploadRegistries,
): ProxyUploadOutcome {
  // 0. Staleness — drop if older than the current cold-state epoch.
  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    registries.proxyStats.dropped++;
    console.log(
      "[proxy.upload] dropped stale",
      msg.entityId,
      msg.kind,
      `T${msg.t}/C${msg.c}`,
      `(deliveryEpoch=${JSON.stringify(msg.epochs)})`,
    );
    return { rebuildDescriptor: false, wantedSetChanged: false };
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
  const { poolKey, pool } = getOrCreateProxyPool(
    ctx.device,
    registries.proxyPoolsByDataset,
    msg.datasetId,
    msg.kind,
    slotDims,
    msg.c,
  );

  // 3. Allocate slot (may evict LRU). An eviction happens iff this is
  // a brand-new key AND the pool has no free slots before the call.
  const compositeKey = proxySlotKey(msg.entityId, msg.t, msg.c);
  const willEvict =
    !pool.slots.has(compositeKey) && pool.freeSlots.length === 0;
  const slotIndex = allocateProxySlot(pool, compositeKey);
  if (willEvict) registries.proxyStats.evicted++;

  // 4. Upload to the slot region. Layout is 1-D-along-X.
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
    registries.proxyDescriptorsByEntity,
    msg.entityId,
  );
  if (msg.kind === "FieldProxy3D") {
    desc.fieldProxyHandle = handle;
  } else {
    // WellProxy3D — set on the well itself AND propagate to all child
    // fields so their `wellProxyHandle` points at the parent's slot.
    desc.wellProxyHandle = handle;
    propagateWellProxyToFields(
      handle,
      msg.entityId,
      registries.wellToFields,
      registries.proxyDescriptorsByEntity,
    );
  }

  registries.proxyStats.uploaded++;
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
