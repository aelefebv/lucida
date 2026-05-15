/** WebGPU render worker — thin dispatcher to handler modules. */
import type { MainToWorkerMessage, WorkerToMainMessage, ColdStateMessage, ProxyAssetDataMessage } from "./workerProtocol.ts";
import { initGPU, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerCtx, EntityProxyDescriptor } from "./workerContext.ts";
import { handleSliceChunkData, handleSliceRenderMultiPass, removeSliceResources, destroyAllSliceResources, getSliceAtlases, getOrCreateSlicePool, resizeSliceIndirection, remapSliceIndirection } from "./sliceHandlers.ts";
import { handleVolumeChunkData, handleVolumeRenderMultiPass, removeVolumeResources, destroyAllVolumeResources, getVolumeAtlases, getOrCreateVolumePool, resizeIndirection, remapIndirection, applyViewHotState, type LodIndirectionMeta } from "./volumeHandlers.ts";
import { computeWantedSet, type ProxyAtlasSnapshot } from "./wantedSet.ts";
import {
  createProxyAtlas,
  allocateProxySlot,
  proxyPoolKey,
  proxySlotKey,
  proxySlotOrigin,
  destroyProxyAtlas,
  type ProxyAtlasState,
  type ProxyHandle,
  type ProxyKind,
} from "./proxyAtlas.ts";
import { isStaleDelivery } from "./epochCheck.ts";
import { handleMinimapInit, handleMinimapRender, handleMinimapSetOverview, handleMinimapUploadOverviewChunks, handleMinimapDestroy, removeMinimapResources, destroyAllMinimapResources } from "./minimapHandlers.ts";
import { getColormapData } from "../colormaps.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
  type EntityDescriptorIndex,
} from "./descriptorBuffer.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;
let compositor: LayerCompositor | null = null;
let cursorRenderer: CursorRenderer | null = null;

let currentEpochs: SceneEpochs | null = null;
let currentColdState: ColdStateMessage | null = null;

/** Map from worker member ID (imageId or imageId:chN) to the dataset ID it belongs to. */
const memberToDataset = new Map<string, string>();

/** Map from worker member ID to the shared pool key it currently belongs to.
 *  Pool key encodes chunk dims so fields with different target LODs use different pools. */
const memberToPool = new Map<string, string>();

/**
 * Per-dataset entityMetas snapshot captured during the most recent cold
 * state. Each cold state replaces this for its dataset so the descriptor
 * build sees only the offsets/dims of the pool(s) the current cold state
 * actually populated — not stale entries left over in other pools from
 * earlier cold states (which would point into a different pool's
 * indirection layout than the one bound at draw time).
 */
const currentEntityMetasByDataset = new Map<string, Map<string, LodIndirectionMeta[]>>();

/**
 * S7: GPU residency for proxies. One pool per
 * `(datasetId, kind, slotDims, channel)` combo (see `proxyPoolKey()`).
 * Outer map keyed by datasetId so per-dataset cleanup is cheap.
 */
const proxyPoolsByDataset = new Map<string, Map<string, ProxyAtlasState>>();

/**
 * Per-entity proxy descriptor table. Keyed by entityId. Field-mode
 * entities get their `wellProxyHandle` populated when the parent
 * well's proxy lands (see `propagateWellProxyToFields`).
 *
 * The {@link EntityProxyDescriptor} type lives in `workerContext.ts` so
 * render handlers can read it via `WorkerCtx.lookupProxyDescriptor`.
 */
const proxyDescriptorsByEntity = new Map<string, EntityProxyDescriptor>();

/**
 * Well → set of child field entityIds, populated from cold state (main
 * thread sends `parentWellId` per field entry). Used so a `WellProxy3D`
 * upload can fan out to its child fields' descriptors.
 */
const wellToFields = new Map<string, Set<string>>();

/**
 * M1 (DOMAINS step 8a): per-dataset entity descriptor buffer + index
 * maps. Built fresh on each cold state. Render handlers bind
 * `idx.buffer` plus a small uniform with the layer's `entityIndex`.
 */
const descriptorBuffersByDataset = new Map<string, EntityDescriptorIndex>();

/**
 * Default capacity per proxy pool. 64 keeps memory modest (a 64³ slot
 * × 64 = 16 MiB per pool at u16) while comfortably covering visible
 * wells/fields in typical plate views.
 */
const PROXY_POOL_CAPACITY = 64;

/**
 * Worker-side counters for HITL: how many proxy uploads we've handled
 * and how many were dropped due to staleness. Inspect from DevTools
 * via `self.__lucidaProxyStats`.
 */
const proxyStats = { uploaded: 0, dropped: 0, evicted: 0 };
(self as unknown as { __lucidaProxyStats?: typeof proxyStats }).__lucidaProxyStats =
  proxyStats;
(self as unknown as { __lucidaProxyPools?: typeof proxyPoolsByDataset }).__lucidaProxyPools =
  proxyPoolsByDataset;
(self as unknown as { __lucidaProxyDescriptors?: typeof proxyDescriptorsByEntity }).__lucidaProxyDescriptors =
  proxyDescriptorsByEntity;

// LUT texture cache for colormap rendering
const lutCache = new Map<string, GPUTexture>();

function getOrCreateLUT(name: string): GPUTexture {
  let tex = lutCache.get(name);
  if (tex) return tex;
  const data = getColormapData(name);
  tex = device.createTexture({
    size: [256, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
  device.queue.writeTexture({ texture: tex }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, [256, 1]);
  lutCache.set(name, tex);
  return tex;
}

// Shared offscreen texture pool (used by slice + volume render)
let offscreenPool: GPUTexture[] = [];
let poolWidth = 0;
let poolHeight = 0;

function ensureOffscreenPool(count: number, w: number, h: number): GPUTexture[] {
  if (w !== poolWidth || h !== poolHeight) {
    for (const tex of offscreenPool) tex.destroy();
    offscreenPool = [];
    poolWidth = w;
    poolHeight = h;
  }
  while (offscreenPool.length < count) {
    offscreenPool.push(createOffscreenTarget(device, w, h));
  }
  return offscreenPool;
}

// 1x1 dummy texture for unset bindings (slice renderer)
let dummyTexture: GPUTexture | null = null;
function getDummyTexture(): GPUTexture {
  if (!dummyTexture) {
    dummyTexture = device.createTexture({
      size: [1, 1],
      format: "r16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummyTexture;
}

// 1x1x1 dummy 3D texture for unset bindings (minimap renderer)
let dummy3DTexture: GPUTexture | null = null;
function getDummy3DTexture(): GPUTexture {
  if (!dummy3DTexture) {
    dummy3DTexture = device.createTexture({
      size: [1, 1, 1],
      format: "r16uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  return dummy3DTexture;
}

function post(msg: WorkerToMainMessage) {
  self.postMessage(msg);
}

/**
 * Build a flat snapshot of all proxy pools for this dataset, in the
 * shape `wantedSet.computeWantedSet()` expects. Cheap — pool maps are
 * small.
 */
function buildProxyAtlasSnapshot(datasetId: string): Map<string, ProxyAtlasSnapshot> {
  const snap = new Map<string, ProxyAtlasSnapshot>();
  const pools = proxyPoolsByDataset.get(datasetId);
  if (!pools) return snap;
  for (const [poolKey, pool] of pools) {
    snap.set(poolKey, { kind: pool.kind, slots: pool.slots });
  }
  return snap;
}

/**
 * Look up the entity metas snapshot captured during the most recent
 * cold state for `datasetId`. Returns an empty map if no cold state has
 * touched that dataset yet (e.g., proxy upload arrived before the first
 * cold state).
 */
function entityMetasForDataset(datasetId: string): Map<string, LodIndirectionMeta[]> {
  return currentEntityMetasByDataset.get(datasetId) ?? new Map();
}

/** Compute and post wanted-set delta from current cold state + atlas state. */
function postWantedSet() {
  if (!currentColdState || !currentEpochs) return;
  const proxySnap = buildProxyAtlasSnapshot(currentColdState.datasetId);
  const result = computeWantedSet(
    currentColdState,
    getVolumeAtlases(),
    getSliceAtlases(),
    memberToPool,
    proxySnap,
  );
  post({ type: "wantedSetDelta", epochs: currentEpochs, missing: result.missing });
}

/** Get-or-create the proxy descriptor for an entity. */
function getOrCreateProxyDescriptor(entityId: string): EntityProxyDescriptor {
  let d = proxyDescriptorsByEntity.get(entityId);
  if (!d) {
    d = { fieldProxyHandle: null, wellProxyHandle: null };
    proxyDescriptorsByEntity.set(entityId, d);
  }
  return d;
}

/**
 * Get-or-create a proxy atlas pool for the given dataset / kind /
 * dims / channel. Pool key encodes all four so different shapes get
 * independent pools.
 */
function getOrCreateProxyPool(
  datasetId: string,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
): { poolKey: string; pool: ProxyAtlasState } {
  const poolKey = proxyPoolKey(datasetId, kind, slotDims, channel);
  let dsPools = proxyPoolsByDataset.get(datasetId);
  if (!dsPools) {
    dsPools = new Map();
    proxyPoolsByDataset.set(datasetId, dsPools);
  }
  let pool = dsPools.get(poolKey);
  if (!pool) {
    pool = createProxyAtlas(device, kind, slotDims, channel, PROXY_POOL_CAPACITY);
    dsPools.set(poolKey, pool);
  }
  return { poolKey, pool };
}

/**
 * S7: real GPU upload for a delivered proxy asset.
 *
 *   1. Stale-check vs current cold-state epochs; drop on stale.
 *   2. Resolve / create the per-(dataset, kind, dims, channel) pool.
 *   3. Allocate (or look up) the slot for `(entityId, t, c)`; LRU-evict
 *      from the pool's `touchOrder` if full.
 *   4. `device.queue.writeTexture` the raw u16 buffer into the slot
 *      region (origin = `[slotIndex * X, 0, 0]`; size = slotDims).
 *   5. Update the entity's descriptor; if this is a `WellProxy3D`,
 *      fan out to all child fields' descriptors so their
 *      `wellProxyHandle` points at the same slot.
 */
function handleProxyAssetData(msg: ProxyAssetDataMessage): void {
  if (!device) return;

  // 0. Staleness — drop if older than the current cold-state epoch.
  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    proxyStats.dropped++;
    console.log(
      "[gpu.worker] proxyAssetData: dropped stale",
      msg.entityId,
      msg.kind,
      `T${msg.t}/C${msg.c}`,
      `(deliveryEpoch=${JSON.stringify(msg.epochs)})`,
    );
    return;
  }

  const slotDims = msg.dims;
  const [slotZ, slotY, slotX] = slotDims;
  const expectedBytes = slotZ * slotY * slotX * 2;
  if (msg.data.byteLength < expectedBytes) {
    console.warn(
      `[gpu.worker] proxyAssetData: short buffer (have ${msg.data.byteLength}, need ${expectedBytes}) for ${msg.entityId} ${msg.kind}`,
    );
    return;
  }

  // 1-2. Resolve pool.
  const { poolKey, pool } = getOrCreateProxyPool(msg.datasetId, msg.kind, slotDims, msg.c);

  // 3. Allocate slot (may evict LRU). An eviction happens iff this is
  // a brand-new key AND the pool has no free slots before the call.
  const compositeKey = proxySlotKey(msg.entityId, msg.t, msg.c);
  const willEvict =
    !pool.slots.has(compositeKey) && pool.freeSlots.length === 0;
  const slotIndex = allocateProxySlot(pool, compositeKey);
  if (willEvict) proxyStats.evicted++;

  // 4. Upload to the slot region. Layout is 1-D-along-X.
  const origin = proxySlotOrigin(pool, slotIndex);
  device.queue.writeTexture(
    { texture: pool.texture, origin },
    msg.data,
    { bytesPerRow: slotX * 2, rowsPerImage: slotY },
    [slotX, slotY, slotZ],
  );

  // 5. Update descriptors.
  const handle: ProxyHandle = { poolKey, slotIndex };
  const desc = getOrCreateProxyDescriptor(msg.entityId);
  if (msg.kind === "FieldProxy3D") {
    desc.fieldProxyHandle = handle;
  } else {
    // WellProxy3D — set on the well itself AND propagate to all child
    // fields so their `wellProxyHandle` points at the parent's slot.
    desc.wellProxyHandle = handle;
    const childFields = wellToFields.get(msg.entityId);
    if (childFields) {
      for (const fid of childFields) {
        const fdesc = getOrCreateProxyDescriptor(fid);
        fdesc.wellProxyHandle = handle;
      }
    }
  }

  proxyStats.uploaded++;
  console.log(
    "[gpu.worker] proxyAssetData uploaded",
    msg.entityId,
    msg.kind,
    `T${msg.t}/C${msg.c}`,
    `pool=${poolKey}`,
    `slot=${slotIndex}/${pool.capacity}`,
    `dims=${slotDims}`,
  );

  // M1: proxy handles changed → rebuild this dataset's descriptor
  // buffer so the GPU sees the new pool/slot indices on the next draw.
  // Cheap relative to a per-frame buffer write since cold-state churn
  // already triggers full rebuilds.
  if (currentColdState && currentColdState.datasetId === msg.datasetId) {
    const oldDesc = descriptorBuffersByDataset.get(msg.datasetId);
    if (oldDesc) destroyDescriptorBuffer(oldDesc);
    descriptorBuffersByDataset.set(
      msg.datasetId,
      buildDescriptorBuffer(
        device,
        currentColdState,
        proxyDescriptorsByEntity,
        proxyPoolsByDataset,
        entityMetasForDataset(msg.datasetId),
      ),
    );
  }

  // Recompute wanted-set: this proxy may satisfy outstanding requests.
  postWantedSet();
}

let ctx: WorkerCtx;

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case "init": {
        const result = await initGPU(msg.canvas);
        device = result.device;
        context = result.context;
        format = result.format;
        ctx = {
          device,
          context,
          format,
          getSliceRenderer() {
            if (!sliceRenderer) sliceRenderer = new SliceRenderer(device);
            return sliceRenderer;
          },
          getVolumeRenderer() {
            if (!volumeRenderer) volumeRenderer = new VolumeRenderer(device);
            return volumeRenderer;
          },
          getCompositor() {
            if (!compositor) compositor = new LayerCompositor(device, format);
            return compositor;
          },
          getCursorRenderer() {
            if (!cursorRenderer) cursorRenderer = new CursorRenderer(device, format);
            return cursorRenderer;
          },
          ensureOffscreenPool,
          getDummyTexture,
          getDummy3DTexture,
          getOrCreateLUT,
          post,
          postWantedSet,
          lookupProxyDescriptor(entityId: string) {
            return proxyDescriptorsByEntity.get(entityId) ?? null;
          },
          lookupProxyPool(datasetId: string, poolKey: string) {
            const dsPools = proxyPoolsByDataset.get(datasetId);
            if (!dsPools) return null;
            return dsPools.get(poolKey) ?? null;
          },
          lookupEntityDescriptor(datasetId: string) {
            return descriptorBuffersByDataset.get(datasetId) ?? null;
          },
        };
        post({ type: "ready" });
        break;
      }

      case "resize": {
        const canvas = context.canvas as OffscreenCanvas;
        canvas.width = msg.width;
        canvas.height = msg.height;
        break;
      }

      case "sliceChunkData": {
        const memberId = msg.datasetId;
        const poolKey = memberToPool.get(memberId);
        if (!poolKey) break;
        handleSliceChunkData(ctx, msg, currentEpochs, poolKey, memberId);
        break;
      }
      case "sliceRenderMultiPass":
        handleSliceRenderMultiPass(ctx, msg, (memberId) => {
          const poolKey = memberToPool.get(memberId);
          const datasetId = memberToDataset.get(memberId) ?? null;
          if (!poolKey) {
            // No chunk pool — still report dataset so the handler can
            // bind a dummy chunk atlas and proceed with proxy-only render
            // (e.g. well-as-proxy entries).
            return datasetId ? { poolKey: null, datasetId } : null;
          }
          return { poolKey, datasetId };
        });
        break;

      case "volumeChunkData": {
        const memberId = msg.datasetId; // protocol still names it datasetId; orchestrator sends memberId here
        const poolKey = memberToPool.get(memberId);
        if (!poolKey) {
          // No pool registered yet (cold state hasn't arrived for this member)
          break;
        }
        handleVolumeChunkData(ctx, msg, currentEpochs, poolKey, memberId);
        break;
      }
      case "volumeRenderMultiPass":
        handleVolumeRenderMultiPass(ctx, msg, (memberId) => {
          const poolKey = memberToPool.get(memberId);
          const datasetId = memberToDataset.get(memberId) ?? null;
          if (!poolKey) {
            // S8: no chunk pool — still report datasetId so the handler
            // can bind a dummy chunk atlas and proceed with a proxy-only
            // render (well-as-proxy entries take this path).
            return datasetId ? { poolKey: null, datasetId } : null;
          }
          return { poolKey, datasetId };
        });
        break;

      case "proxyAssetData": {
        // S7: real GPU upload into a dedicated proxy atlas pool.
        handleProxyAssetData(msg);
        break;
      }

      case "minimapInit":
        handleMinimapInit(ctx, msg);
        break;
      case "minimapRender":
        handleMinimapRender(ctx, msg);
        break;
      case "minimapSetOverviewForLayer":
        handleMinimapSetOverview(ctx, msg);
        break;
      case "minimapUploadOverviewChunksForLayer":
        handleMinimapUploadOverviewChunks(ctx, msg);
        break;
      case "minimapDestroy":
        handleMinimapDestroy();
        break;

      case "updateCursorData": {
        if (!ctx) break;
        const cr = ctx.getCursorRenderer();
        cr.updateCursors(new Float32Array(msg.data), msg.count);
        break;
      }

      case "viewHotState": {
        applyViewHotState(msg);
        break;
      }

      case "coldState": {
        currentColdState = msg;
        currentEpochs = msg.epochs;

        // Manage atlases from cold state — create, remap, or rebuild as needed
        const isMultiCh = msg.visibleChannels.length > 1;

        // S7: refresh well→fields map so well-proxy uploads can fan
        // out to child fields' descriptors. Cold state is the source
        // of truth for active set membership; we rebuild fully each tick.
        wellToFields.clear();
        for (const entry of msg.activeSet) {
          if (entry.parentWellId) {
            let set = wellToFields.get(entry.parentWellId);
            if (!set) {
              set = new Set();
              wellToFields.set(entry.parentWellId, set);
            }
            set.add(entry.entityId);
          }
        }

        // First pass: register member→dataset mappings for all entries.
        // S8: well-as-proxy entries have `imageId === ""` per planning;
        // the volume/slice path emits layers keyed by the well's
        // entityId (multi-channel: composite of entityId + channel).
        // Register both keys so layerToPool can resolve them.
        for (const entry of msg.activeSet) {
          if (isMultiCh) {
            for (const ch of msg.visibleChannels) {
              if (entry.imageId) {
                memberToDataset.set(`${entry.imageId}:ch${ch}`, msg.datasetId);
              }
              if (entry.mode === "well-as-proxy") {
                memberToDataset.set(`${entry.entityId}:ch${ch}`, msg.datasetId);
              }
            }
          } else {
            if (entry.imageId) {
              memberToDataset.set(entry.imageId, msg.datasetId);
            }
            if (entry.mode === "well-as-proxy") {
              memberToDataset.set(entry.entityId, msg.datasetId);
            }
          }
        }

        // M1 fix: capture the entityMetas this cold state actually
        // produces (across pools), so the descriptor build doesn't pick
        // up stale offsets/dims left over in pools from earlier cold
        // states with different target LODs.
        const currentEntityMetas = new Map<string, LodIndirectionMeta[]>();

        if (msg.viewMode === "volume") {
          // Multi-pool: group entries by (channel, chunk dims). Pools have unique chunk dims,
          // so fields with different target LODs end up in different pools.
          // poolKey = datasetId[:chN]:chunkDimsKey
          const channels = isMultiCh ? msg.visibleChannels : [msg.visibleChannels[0]];

          // Group entries by (channel, chunk dims key) → list of (entry, memberId)
          interface PoolGroup {
            poolKey: string;
            channel: number;
            chunkDims: [number, number, number]; // [Z, Y, X]
            entries: Array<{ entry: typeof msg.activeSet[0]; memberId: string }>;
          }
          const groups = new Map<string, PoolGroup>();

          for (const channel of channels) {
            for (const entry of msg.activeSet) {
              const targetLevel = entry.levels.find(l => l.level === entry.targetLod);
              if (!targetLevel) continue;
              const [chunkZ, chunkY, chunkX] = targetLevel.chunkShape;
              const chunkDimsKey = `${chunkX}x${chunkY}x${chunkZ}`;
              const poolKey = isMultiCh
                ? `${msg.datasetId}:ch${channel}:${chunkDimsKey}`
                : `${msg.datasetId}:${chunkDimsKey}`;
              const memberId = isMultiCh ? `${entry.imageId}:ch${channel}` : entry.imageId;

              memberToPool.set(memberId, poolKey);

              let group = groups.get(poolKey);
              if (!group) {
                group = { poolKey, channel, chunkDims: [chunkZ, chunkY, chunkX], entries: [] };
                groups.set(poolKey, group);
              }
              group.entries.push({ entry, memberId });
            }
          }

          // Build each pool with its grouped entries
          for (const group of groups.values()) {
            const [pcZ, pcY, pcX] = group.chunkDims;
            const newEntityMetas = new Map<string, LodIndirectionMeta[]>();
            let offset = 0;

            for (const { entry, memberId } of group.entries) {
              // Build per-entity LOD sections (only LODs with matching chunk dims)
              const [finest, coarsest] = entry.detailOwnedLodRange;
              const entityLodMetas: LodIndirectionMeta[] = [];
              for (let lvl = finest; lvl <= coarsest; lvl++) {
                const lm = entry.levels.find(l => l.level === lvl);
                if (!lm) continue;
                const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
                if (lChunkX !== pcX || lChunkY !== pcY || lChunkZ !== pcZ) continue;
                const [lGridZ, lGridY, lGridX] = lm.gridShape;
                const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
                entityLodMetas.push({
                  level: lvl,
                  gridDims: [lGridZ, lGridY, lGridX],
                  chunkDims: [lChunkZ, lChunkY, lChunkX],
                  levelDims: [lLevelD, lLevelH, lLevelW],
                  offset,
                });
                offset += lGridX * lGridY * lGridZ;
              }
              // Fallback: include target LOD only (no multi-LOD across mismatched dims)
              if (entityLodMetas.length === 0) {
                const targetLevel = entry.levels.find(l => l.level === entry.targetLod)!;
                const [tGridZ, tGridY, tGridX] = targetLevel.gridShape;
                const [tLevelD, tLevelH, tLevelW] = targetLevel.levelDims;
                entityLodMetas.push({
                  level: entry.targetLod,
                  gridDims: [tGridZ, tGridY, tGridX],
                  chunkDims: [pcZ, pcY, pcX],
                  levelDims: [tLevelD, tLevelH, tLevelW],
                  offset,
                });
                offset += tGridX * tGridY * tGridZ;
              }
              newEntityMetas.set(memberId, entityLodMetas);
            }

            const atlas = getOrCreateVolumePool(ctx, group.poolKey, pcX, pcY, pcZ, msg.currentT, group.channel);
            atlas.entityMetas = newEntityMetas;
            resizeIndirection(ctx, atlas, offset);
            remapIndirection(atlas, msg.currentT, group.channel);
            for (const [memberId, metas] of newEntityMetas) {
              currentEntityMetas.set(memberId, metas);
            }
          }
        } else {
          // Slice mode — multi-pool by (channel, chunk dims), same pattern as volume
          const channels = isMultiCh ? msg.visibleChannels : [msg.visibleChannels[0]];

          interface SlicePoolGroup {
            poolKey: string;
            channel: number;
            chunkDims: [number, number]; // [Y, X] for slice (2D)
            entries: Array<{ entry: typeof msg.activeSet[0]; memberId: string }>;
          }
          const groups = new Map<string, SlicePoolGroup>();

          for (const channel of channels) {
            for (const entry of msg.activeSet) {
              const targetLevel = entry.levels.find(l => l.level === entry.targetLod);
              if (!targetLevel) continue;
              const [, chunkY, chunkX] = targetLevel.chunkShape;
              const chunkDimsKey = `${chunkX}x${chunkY}`;
              const poolKey = isMultiCh
                ? `${msg.datasetId}:ch${channel}:${chunkDimsKey}`
                : `${msg.datasetId}:${chunkDimsKey}`;
              const memberId = isMultiCh ? `${entry.imageId}:ch${channel}` : entry.imageId;

              memberToPool.set(memberId, poolKey);

              let group = groups.get(poolKey);
              if (!group) {
                group = { poolKey, channel, chunkDims: [chunkY, chunkX], entries: [] };
                groups.set(poolKey, group);
              }
              group.entries.push({ entry, memberId });
            }
          }

          for (const group of groups.values()) {
            const [pcY, pcX] = group.chunkDims;
            const newEntityMetas = new Map<string, LodIndirectionMeta[]>();
            let offset = 0;

            for (const { entry, memberId } of group.entries) {
              const [finest, coarsest] = entry.detailOwnedLodRange;
              const entityLodMetas: LodIndirectionMeta[] = [];
              for (let lvl = finest; lvl <= coarsest; lvl++) {
                const lm = entry.levels.find(l => l.level === lvl);
                if (!lm) continue;
                const [lChunkZ, lChunkY, lChunkX] = lm.chunkShape;
                if (lChunkX !== pcX || lChunkY !== pcY) continue;
                const [lGridZ, lGridY, lGridX] = lm.gridShape;
                const [lLevelD, lLevelH, lLevelW] = lm.levelDims;
                entityLodMetas.push({
                  level: lvl,
                  gridDims: [lGridZ, lGridY, lGridX],
                  chunkDims: [lChunkZ, lChunkY, lChunkX],
                  levelDims: [lLevelD, lLevelH, lLevelW],
                  offset,
                });
                offset += lGridX * lGridY; // 2D indirection
              }
              if (entityLodMetas.length === 0) {
                const targetLevel = entry.levels.find(l => l.level === entry.targetLod)!;
                const [tChunkZ, tChunkY, tChunkX] = targetLevel.chunkShape;
                const [tGridZ, tGridY, tGridX] = targetLevel.gridShape;
                const [tLevelD, tLevelH, tLevelW] = targetLevel.levelDims;
                entityLodMetas.push({
                  level: entry.targetLod,
                  gridDims: [tGridZ, tGridY, tGridX],
                  chunkDims: [tChunkZ, tChunkY, tChunkX],
                  levelDims: [tLevelD, tLevelH, tLevelW],
                  offset,
                });
                offset += tGridX * tGridY;
              }
              newEntityMetas.set(memberId, entityLodMetas);
            }

            const atlas = getOrCreateSlicePool(ctx, group.poolKey, pcX, pcY, msg.currentZ, msg.currentT, group.channel);
            atlas.entityMetas = newEntityMetas;
            resizeSliceIndirection(ctx, atlas, offset);
            remapSliceIndirection(atlas, msg.currentT, group.channel, msg.currentZ);
            for (const [memberId, metas] of newEntityMetas) {
              currentEntityMetas.set(memberId, metas);
            }
          }
        }

        currentEntityMetasByDataset.set(msg.datasetId, currentEntityMetas);

        // M1: build per-dataset entity descriptor buffer. Replaces any
        // previous buffer for the same dataset (proxy pool index churn
        // is acceptable in M1 — descriptors are rebuilt fresh each
        // cold state, same as `entityMetas`).
        const oldDesc = descriptorBuffersByDataset.get(msg.datasetId);
        if (oldDesc) destroyDescriptorBuffer(oldDesc);
        descriptorBuffersByDataset.set(
          msg.datasetId,
          buildDescriptorBuffer(
            device,
            msg,
            proxyDescriptorsByEntity,
            proxyPoolsByDataset,
            currentEntityMetas,
          ),
        );

        postWantedSet();
        break;
      }

      case "removeLayerResources": {
        removeSliceResources(msg.datasetId);
        removeVolumeResources(msg.datasetId);
        removeMinimapResources(msg.datasetId);
        // S7: also destroy proxy pools for this dataset (and clear
        // descriptors that referenced it).
        const dsPools = proxyPoolsByDataset.get(msg.datasetId);
        if (dsPools) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
          proxyPoolsByDataset.delete(msg.datasetId);
        }
        // M1: drop the per-dataset descriptor buffer.
        const desc = descriptorBuffersByDataset.get(msg.datasetId);
        if (desc) {
          destroyDescriptorBuffer(desc);
          descriptorBuffersByDataset.delete(msg.datasetId);
        }
        currentEntityMetasByDataset.delete(msg.datasetId);
        break;
      }

      case "destroy":
        currentEpochs = null;
        currentColdState = null;
        memberToDataset.clear();
        memberToPool.clear();
        currentEntityMetasByDataset.clear();
        // S7: tear down proxy atlas pools and descriptors.
        for (const dsPools of proxyPoolsByDataset.values()) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
        }
        proxyPoolsByDataset.clear();
        proxyDescriptorsByEntity.clear();
        wellToFields.clear();
        // M1: tear down all entity descriptor buffers.
        for (const desc of descriptorBuffersByDataset.values()) {
          destroyDescriptorBuffer(desc);
        }
        descriptorBuffersByDataset.clear();
        destroyAllSliceResources();
        destroyAllVolumeResources();
        destroyAllMinimapResources();
        for (const tex of offscreenPool) tex.destroy();
        offscreenPool = [];
        for (const tex of lutCache.values()) tex.destroy();
        lutCache.clear();
        dummyTexture?.destroy();
        dummyTexture = null;
        dummy3DTexture?.destroy();
        dummy3DTexture = null;
        sliceRenderer = null;
        volumeRenderer = null;
        compositor = null;
        cursorRenderer = null;
        self.close();
        break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
