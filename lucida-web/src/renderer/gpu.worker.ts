/** WebGPU render worker — thin dispatcher to handler modules. */
import type { MainToWorkerMessage, WorkerToMainMessage, ColdStateMessage } from "./workerProtocol.ts";
import { initGPU, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerCtx, EntityProxyDescriptor } from "./workerContext.ts";
import { handleSliceChunkData, handleSliceRenderMultiPass, removeSliceResources, destroyAllSliceResources, getSliceAtlases } from "./slice/index.ts";
import { handleVolumeChunkData, handleVolumeRenderMultiPass, removeVolumeResources, destroyAllVolumeResources, getVolumeAtlases, applyViewHotState, type LodIndirectionMeta } from "./volume/index.ts";
import { computeWantedSet, type ProxyAtlasSnapshot } from "./wantedSet.ts";
import {
  destroyProxyAtlas,
  type ProxyAtlasState,
} from "./proxyAtlas.ts";
import { handleMinimapInit, handleMinimapRender, handleMinimapSetOverview, handleMinimapUploadOverviewChunks, handleMinimapDestroy, removeMinimapResources, destroyAllMinimapResources } from "./minimapHandlers.ts";
import { getColormapData } from "../colormaps.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
  type EntityDescriptorIndex,
} from "./descriptorBuffer.ts";
import { applyColdState } from "./coldState/index.ts";
import { handleProxyUpload } from "./proxy/index.ts";

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
 * GPU residency for proxies. One pool per
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
 * Per-dataset entity descriptor buffer + index maps. Built fresh on
 * each cold state. Render handlers bind `idx.buffer` plus a small
 * uniform with the layer's `entityIndex`.
 */
const descriptorBuffersByDataset = new Map<string, EntityDescriptorIndex>();

/**
 * Worker-side counters for HITL: how many proxy uploads we've handled
 * and how many were dropped due to staleness. Inspect from DevTools
 * via `self.__lucidaProxyStats`. Mutated by `handleProxyUpload`.
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

/**
 * Rebuild the per-dataset entity descriptor buffer iff the upload's
 * dataset matches the current cold state. Proxy uploads for other
 * datasets stay resident in their pools, but their descriptor buffer
 * isn't refreshed until cold state lands for that dataset.
 */
function rebuildDescriptorIfMatching(datasetId: string): void {
  if (!currentColdState || currentColdState.datasetId !== datasetId) return;
  const oldDesc = descriptorBuffersByDataset.get(datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  descriptorBuffersByDataset.set(
    datasetId,
    buildDescriptorBuffer(
      device,
      currentColdState,
      proxyDescriptorsByEntity,
      proxyPoolsByDataset,
      entityMetasForDataset(datasetId),
    ),
  );
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
        const memberId = msg.memberId;
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
        const memberId = msg.memberId;
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
            // No chunk pool — still report datasetId so the handler can
            // bind a dummy chunk atlas and proceed with a proxy-only
            // render (well-as-proxy entries take this path).
            return datasetId ? { poolKey: null, datasetId } : null;
          }
          return { poolKey, datasetId };
        });
        break;

      case "proxyAssetData": {
        const outcome = handleProxyUpload(ctx, msg, currentEpochs, {
          proxyPoolsByDataset, proxyDescriptorsByEntity, wellToFields, proxyStats,
        });
        if (outcome.rebuildDescriptor) rebuildDescriptorIfMatching(msg.datasetId);
        if (outcome.wantedSetChanged) postWantedSet();
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
        applyColdState(ctx, msg, {
          memberToDataset,
          memberToPool,
          wellToFields,
          currentEntityMetasByDataset,
          proxyDescriptorsByEntity,
          proxyPoolsByDataset,
          descriptorBuffersByDataset,
        });
        postWantedSet();
        break;
      }

      case "removeLayerResources": {
        removeSliceResources(msg.datasetId);
        removeVolumeResources(msg.datasetId);
        removeMinimapResources(msg.datasetId);
        // Also destroy proxy pools for this dataset (and clear
        // descriptors that referenced it).
        const dsPools = proxyPoolsByDataset.get(msg.datasetId);
        if (dsPools) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
          proxyPoolsByDataset.delete(msg.datasetId);
        }
        // Drop the per-dataset descriptor buffer.
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
        // Tear down proxy atlas pools and descriptors.
        for (const dsPools of proxyPoolsByDataset.values()) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
        }
        proxyPoolsByDataset.clear();
        proxyDescriptorsByEntity.clear();
        wellToFields.clear();
        // Tear down all entity descriptor buffers.
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
