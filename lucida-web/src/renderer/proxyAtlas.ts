/**
 * GPU residency for proxy assets.
 *
 * Proxies are small, generated 3-D textures (`r16uint`, single channel)
 * representing either a whole well (`WellProxy3D`) or a single field
 * (`FieldProxy3D`). They live in dedicated atlas pools so they don't
 * compete with detail-chunk slots.
 *
 * Slot layout (1-D-along-X)
 * -------------------------
 * Each pool fixes its slot dimensions `[Z, Y, X]`. Slots are tiled
 * along the X axis, so the atlas texture is sized
 * `[slotDims.X * capacity, slotDims.Y, slotDims.Z]`. Slot `i` occupies
 * the region
 *
 * ```text
 *   origin = [i * slotDims.X, 0, 0]
 *   size   = slotDims
 * ```
 *
 * Why 1-D-along-X: simplest layout that keeps slot origin arithmetic
 * trivial (`i * X`). Proxy slots are typically modest (≤128³), pool
 * capacity is small (default 64), so a 1-D pack of `64 * 128 = 8192`
 * texels per axis fits comfortably under WebGPU's standard
 * `maxTextureDimension3D = 2048` limit for typical proxy dims. We
 * still validate against the limit at creation time and clamp
 * `capacity` downward if needed; if a future change pushes us past
 * that, swap in a 3-D pack.
 *
 * Eviction
 * --------
 * Pure LRU on `touchOrder`. We deliberately do NOT skip slots that
 * are currently in the active set: eviction only happens when the
 * pool is full AND a new key arrives, which means at least one
 * incumbent must give way regardless. The orchestrator's normal
 * wanted-set re-fetch will pull any victim back if it's still wanted.
 */

export type { ProxyKind } from "../pipeline/assetCatalog.ts";
import type { ProxyKind } from "../pipeline/assetCatalog.ts";
import { getDeviceLimits } from "./gpuContext.ts";

export interface ProxyAtlasState {
  /** 3-D `r16uint` texture; slots tiled along X. */
  texture: GPUTexture;
  /** Composite key `${entityId}|${t}|${c}` → slot index. */
  slots: Map<string, number>;
  freeSlots: number[];
  capacity: number;
  /** Voxel dimensions of one slot, `[Z, Y, X]`. */
  slotDims: [number, number, number];
  kind: ProxyKind;
  /** Single channel per pool — multi-channel uses multi-pool. */
  channel: number;
  /**
   * LRU touch order. Keys appear oldest-first. Each `allocateProxySlot`
   * for an existing key, and each `touchProxySlot`, moves the key to
   * the end. Eviction pops from the head.
   */
  touchOrder: string[];
}

export interface ProxyHandle {
  poolKey: string;
  slotIndex: number;
}

export function proxyPoolKey(
  datasetId: string,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
): string {
  const [z, y, x] = slotDims;
  return `${datasetId}|proxy|${kind}|${x}x${y}x${z}|ch${channel}`;
}

export function proxySlotKey(entityId: string, t: number, c: number): string {
  return `${entityId}|${t}|${c}`;
}

/**
 * Create a new proxy atlas pool. Slots are laid out 1-D along X; the
 * texture has size `[slotDims.X * capacity, slotDims.Y, slotDims.Z]`.
 *
 * If the requested layout exceeds the device's max 3-D texture
 * dimension on the X axis, capacity is clamped downward and a warning
 * is logged.
 */
export function createProxyAtlas(
  device: GPUDevice,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
  capacity: number,
): ProxyAtlasState {
  const [slotZ, slotY, slotX] = slotDims;

  // Clamp capacity to fit under the device's 3-D texture limits.
  const limit = getDeviceLimits(device).maxTextureDimension3D;
  let cap = capacity;
  if (slotX > 0 && slotX * cap > limit) {
    const maxCap = Math.max(1, Math.floor(limit / slotX));
    if (maxCap < cap) {
      console.warn(
        `[proxyAtlas] capacity ${cap} exceeds 3D texture limit ` +
          `(${slotX} * ${cap} > ${limit}); clamping to ${maxCap}`,
      );
      cap = maxCap;
    }
  }

  const texW = slotX * cap;
  const texH = slotY;
  const texD = slotZ;

  const texture = device.createTexture({
    size: [texW, texH, texD],
    format: "r16uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const freeSlots: number[] = [];
  for (let i = cap - 1; i >= 0; i--) freeSlots.push(i);

  return {
    texture,
    slots: new Map(),
    freeSlots,
    capacity: cap,
    slotDims,
    kind,
    channel,
    touchOrder: [],
  };
}

/**
 * Allocate (or look up) a slot for `key`. Returns the slot index.
 *
 * - Existing key → returns existing slot, moves key to end of LRU.
 * - Free slot available → consumes a free slot.
 * - Otherwise → evicts the LRU head and reuses its slot.
 */
export function allocateProxySlot(
  atlas: ProxyAtlasState,
  key: string,
): number {
  const existing = atlas.slots.get(key);
  if (existing !== undefined) {
    moveToEnd(atlas.touchOrder, key);
    return existing;
  }

  let slotIndex: number;
  if (atlas.freeSlots.length > 0) {
    slotIndex = atlas.freeSlots.pop()!;
  } else {
    // Pure LRU: evict the oldest entry. We accept that a still-wanted
    // proxy may get evicted; the wanted-set delta will pull it back.
    if (atlas.touchOrder.length === 0) {
      throw new Error(
        `[proxyAtlas] cannot allocate: full and empty touchOrder ` +
          `(capacity=${atlas.capacity})`,
      );
    }
    const victim = atlas.touchOrder.shift()!;
    slotIndex = atlas.slots.get(victim)!;
    atlas.slots.delete(victim);
  }

  atlas.slots.set(key, slotIndex);
  atlas.touchOrder.push(key);
  return slotIndex;
}

/** Does NOT touch LRU order. */
export function lookupProxySlot(
  atlas: ProxyAtlasState,
  key: string,
): number | undefined {
  return atlas.slots.get(key);
}

export function touchProxySlot(atlas: ProxyAtlasState, key: string): void {
  if (!atlas.slots.has(key)) return;
  moveToEnd(atlas.touchOrder, key);
}

/**
 * Compute the [x, y, z] origin in the atlas texture for a slot index.
 * Layout: 1-D along X, so `origin = [slotIndex * slotDims.X, 0, 0]`.
 */
export function proxySlotOrigin(
  atlas: ProxyAtlasState,
  slotIndex: number,
): [number, number, number] {
  return [slotIndex * atlas.slotDims[2], 0, 0];
}

export function destroyProxyAtlas(atlas: ProxyAtlasState): void {
  atlas.texture.destroy();
  atlas.slots.clear();
  atlas.touchOrder.length = 0;
  atlas.freeSlots.length = 0;
}

function moveToEnd(arr: string[], key: string): void {
  const idx = arr.indexOf(key);
  if (idx < 0) return;
  if (idx === arr.length - 1) return;
  arr.splice(idx, 1);
  arr.push(key);
}
