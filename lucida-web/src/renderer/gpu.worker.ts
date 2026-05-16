/** WebGPU render worker — thin dispatcher to handler modules. */
import type { MainToWorkerMessage, WorkerToMainMessage } from "./workerProtocol.ts";
import { initGPU, createOffscreenTarget } from "./gpuContext.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { CursorRenderer } from "./cursorRenderer.ts";
import type { WorkerCtx } from "./workerContext.ts";
import { handleSliceChunkData, handleSliceRenderMultiPass, removeSliceResources, destroyAllSliceResources } from "./slice/index.ts";
import { handleVolumeChunkData, handleVolumeRenderMultiPass, removeVolumeResources, destroyAllVolumeResources, applyViewHotState } from "./volume/index.ts";
import { computeWantedSet, type ProxyAtlasSnapshot } from "./wantedSet.ts";
import { destroyProxyAtlas } from "./proxyAtlas.ts";
import { handleMinimapInit, handleMinimapRender, handleMinimapSetOverview, handleMinimapUploadOverviewChunks, handleMinimapDestroy, removeMinimapResources, destroyAllMinimapResources } from "./minimapHandlers.ts";
import { getColormapData } from "../colormaps.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
} from "./descriptorBuffer.ts";
import { applyColdState } from "./coldState/index.ts";
import { handleProxyUpload } from "./proxy/index.ts";
import { createInitialState } from "./worker/index.ts";

let device: GPUDevice;
let context: GPUCanvasContext;
let format: GPUTextureFormat;

// Renderer-class singletons (lazy-init on first use). Persisted across
// messages; not per-session state, so they stay at module scope. Slice 9
// lifts them into `worker/resources.ts`.
let sliceRenderer: SliceRenderer | null = null;
let volumeRenderer: VolumeRenderer | null = null;
let compositor: LayerCompositor | null = null;
let cursorRenderer: CursorRenderer | null = null;

// LUT texture cache for colormap rendering. Same rationale as the
// renderer-class singletons above — a per-device cache, not per-session
// state. Slice 9 owns it.
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

// Shared offscreen texture pool (used by slice + volume render). Per-canvas
// resource; Slice 9 lifts it into `worker/resources.ts`.
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

// 1x1 dummy texture for unset bindings (slice renderer). Per-device
// singleton; Slice 9 lifts it into `worker/resources.ts`.
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

// 1x1x1 dummy 3D texture for unset bindings (minimap renderer). Per-device
// singleton; Slice 9 lifts it into `worker/resources.ts`.
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
  const pools = ctx.state.proxyPoolsByDataset.get(datasetId);
  if (!pools) return snap;
  for (const [poolKey, pool] of pools) {
    snap.set(poolKey, { kind: pool.kind, slots: pool.slots });
  }
  return snap;
}

/** Compute and post wanted-set delta from current cold state + atlas state. */
function postWantedSet() {
  const state = ctx.state;
  if (!state.currentColdState || !state.currentEpochs) return;
  const proxySnap = buildProxyAtlasSnapshot(state.currentColdState.datasetId);
  const result = computeWantedSet(
    state.currentColdState,
    state.volumeAtlases,
    state.sliceAtlases,
    state.memberToPool,
    proxySnap,
  );
  post({ type: "wantedSetDelta", epochs: state.currentEpochs, missing: result.missing });
}

/**
 * Rebuild the per-dataset entity descriptor buffer iff the upload's
 * dataset matches the current cold state. Proxy uploads for other
 * datasets stay resident in their pools, but their descriptor buffer
 * isn't refreshed until cold state lands for that dataset.
 */
function rebuildDescriptorIfMatching(datasetId: string): void {
  const state = ctx.state;
  if (!state.currentColdState || state.currentColdState.datasetId !== datasetId) return;
  const oldDesc = state.descriptorBuffersByDataset.get(datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    datasetId,
    buildDescriptorBuffer(
      device,
      state.currentColdState,
      state.proxyDescriptorsByEntity,
      state.proxyPoolsByDataset,
      state.currentEntityMetasByDataset.get(datasetId) ?? new Map(),
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
        const state = createInitialState();
        ctx = {
          device,
          context,
          format,
          state,
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
            return state.proxyDescriptorsByEntity.get(entityId) ?? null;
          },
          lookupProxyPool(datasetId: string, poolKey: string) {
            const dsPools = state.proxyPoolsByDataset.get(datasetId);
            if (!dsPools) return null;
            return dsPools.get(poolKey) ?? null;
          },
          lookupEntityDescriptor(datasetId: string) {
            return state.descriptorBuffersByDataset.get(datasetId) ?? null;
          },
        };
        // Devtools/HITL surfaces — point at the ctx-owned state so a
        // DevTools breakpoint sees current values rather than a stale
        // pre-init pointer.
        (self as unknown as { __lucidaProxyStats?: typeof state.proxyStats }).__lucidaProxyStats =
          state.proxyStats;
        (self as unknown as { __lucidaProxyPools?: typeof state.proxyPoolsByDataset }).__lucidaProxyPools =
          state.proxyPoolsByDataset;
        (self as unknown as { __lucidaProxyDescriptors?: typeof state.proxyDescriptorsByEntity }).__lucidaProxyDescriptors =
          state.proxyDescriptorsByEntity;
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
        const poolKey = ctx.state.memberToPool.get(memberId);
        if (!poolKey) break;
        handleSliceChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
        break;
      }
      case "sliceRenderMultiPass":
        handleSliceRenderMultiPass(ctx, msg, (memberId) => {
          const poolKey = ctx.state.memberToPool.get(memberId);
          const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
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
        const poolKey = ctx.state.memberToPool.get(memberId);
        if (!poolKey) {
          // No pool registered yet (cold state hasn't arrived for this member)
          break;
        }
        handleVolumeChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
        break;
      }
      case "volumeRenderMultiPass":
        handleVolumeRenderMultiPass(ctx, msg, (memberId) => {
          const poolKey = ctx.state.memberToPool.get(memberId);
          const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
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
        const outcome = handleProxyUpload(ctx, msg);
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
        applyViewHotState(ctx, msg);
        break;
      }

      case "coldState": {
        ctx.state.currentColdState = msg;
        ctx.state.currentEpochs = msg.epochs;
        applyColdState(ctx, msg);
        postWantedSet();
        break;
      }

      case "removeLayerResources": {
        removeSliceResources(ctx, msg.datasetId);
        removeVolumeResources(ctx, msg.datasetId);
        removeMinimapResources(msg.datasetId);
        // Destroy proxy pools for this dataset.
        const dsPools = ctx.state.proxyPoolsByDataset.get(msg.datasetId);
        if (dsPools) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
          ctx.state.proxyPoolsByDataset.delete(msg.datasetId);
        }
        // Drop the per-dataset descriptor buffer.
        const desc = ctx.state.descriptorBuffersByDataset.get(msg.datasetId);
        if (desc) {
          destroyDescriptorBuffer(desc);
          ctx.state.descriptorBuffersByDataset.delete(msg.datasetId);
        }
        ctx.state.currentEntityMetasByDataset.delete(msg.datasetId);

        // Slice 8: clear member-id routing for entries owned by this
        // dataset so dropped layers don't keep stale memberToDataset /
        // memberToPool entries around. Previously these maps grew
        // monotonically across the worker's lifetime (#632 leak).
        for (const [memberId, dsId] of ctx.state.memberToDataset) {
          if (dsId === msg.datasetId) {
            ctx.state.memberToDataset.delete(memberId);
            ctx.state.memberToPool.delete(memberId);
          }
        }
        // Drop well→fields entries owned by this dataset. Tracked via
        // wellsByDataset so we don't have to scan every well's child set.
        const wells = ctx.state.wellsByDataset.get(msg.datasetId);
        if (wells) {
          for (const wellId of wells) ctx.state.wellToFields.delete(wellId);
          ctx.state.wellsByDataset.delete(msg.datasetId);
        }
        // If the dataset being dropped is the one whose cold state is
        // active, clear that pointer too — no more renders/uploads will
        // arrive against this state.
        if (ctx.state.currentColdState?.datasetId === msg.datasetId) {
          ctx.state.currentColdState = null;
        }
        break;
      }

      case "destroy":
        ctx.state.currentEpochs = null;
        ctx.state.currentColdState = null;
        ctx.state.memberToDataset.clear();
        ctx.state.memberToPool.clear();
        ctx.state.currentEntityMetasByDataset.clear();
        // Tear down proxy atlas pools and descriptors.
        for (const dsPools of ctx.state.proxyPoolsByDataset.values()) {
          for (const pool of dsPools.values()) destroyProxyAtlas(pool);
        }
        ctx.state.proxyPoolsByDataset.clear();
        ctx.state.proxyDescriptorsByEntity.clear();
        ctx.state.wellToFields.clear();
        ctx.state.wellsByDataset.clear();
        // Tear down all entity descriptor buffers.
        for (const desc of ctx.state.descriptorBuffersByDataset.values()) {
          destroyDescriptorBuffer(desc);
        }
        ctx.state.descriptorBuffersByDataset.clear();
        destroyAllSliceResources(ctx);
        destroyAllVolumeResources(ctx);
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
