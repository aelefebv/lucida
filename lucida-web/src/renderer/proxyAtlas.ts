/**
 * GPU residency for proxy assets.
 *
 * Proxies are small, generated 3-D textures (`r16uint`, single channel)
 * representing either a whole group (`GroupProxy3D`) or a single tile
 * (`TileProxy3D`). They live in dedicated atlas pools so they don't
 * compete with detail-chunk slots.
 *
 * Slot layout (3-D grid)
 * ---------------------
 * Each pool fixes its slot dimensions `[Z, Y, X]`. Slots are tiled in
 * a 3-D grid whose texture-space dimensions are
 * `[slotDims.X * slotsX, slotDims.Y * slotsY, slotDims.Z * slotsZ]`.
 * Slot `i` occupies the region
 *
 * ```text
 *   tileX  = i % slotsX
 *   tileY  = floor(i / slotsX) % slotsY
 *   tileZ  = floor(i / (slotsX * slotsY))
 *   origin = [tileX * slotDims.X, tileY * slotDims.Y, tileZ * slotDims.Z]
 *   size   = slotDims
 * ```
 *
 * Why 3-D grid: common tile proxies such as `128x128x1` can fit only
 * 16 slots in an X-only layout on devices with
 * `maxTextureDimension3D = 2048`. A 3-D grid uses the Y/Z texture axes
 * too, so pool capacity tracks the proxy residency budget instead of
 * the single-axis texture limit.
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
  /** 3-D `r16uint` texture; slots tiled in a 3-D grid. */
  texture: GPUTexture;
  /** Composite key `${entityId}|${t}|${c}` → slot index. */
  slots: Map<string, number>;
  freeSlots: number[];
  capacity: number;
  /** Capacity requested by policy before device-limit clamping. */
  requestedCapacity: number;
  /** Voxel dimensions of one slot, `[Z, Y, X]`. */
  slotDims: [number, number, number];
  slotsX: number;
  slotsY: number;
  slotsZ: number;
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

export interface ProxySlotAllocation {
  slotIndex: number;
  evictedKey: string | null;
}

export interface ProxyAtlasLayout {
  capacity: number;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
  textureSize: [number, number, number];
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
 * Create a new proxy atlas pool. Slots are laid out in a 3-D grid whose
 * texture size is `[slotDims.X * slotsX, slotDims.Y * slotsY,
 * slotDims.Z * slotsZ]`.
 *
 * If the requested capacity exceeds what can fit under the device's max
 * 3-D texture dimensions, capacity is clamped downward and a warning is
 * logged.
 */
export function createProxyAtlas(
  device: GPUDevice,
  kind: ProxyKind,
  slotDims: [number, number, number],
  channel: number,
  capacity: number,
): ProxyAtlasState {
  const layout = computeProxyAtlasLayout(slotDims, capacity, getDeviceLimits(device).maxTextureDimension3D);
  const requestedCapacity = Math.max(1, Math.floor(capacity));
  if (layout.capacity < Math.max(1, Math.floor(capacity))) {
    console.warn(
      `[proxyAtlas] capacity ${capacity} exceeds 3D texture limit; ` +
        `clamping to ${layout.capacity} ` +
        `(grid=${layout.slotsX}x${layout.slotsY}x${layout.slotsZ})`,
    );
  }

  const [texW, texH, texD] = layout.textureSize;
  const texture = device.createTexture({
    size: [texW, texH, texD],
    format: "r16uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const freeSlots: number[] = [];
  for (let i = layout.capacity - 1; i >= 0; i--) freeSlots.push(i);

  return {
    texture,
    slots: new Map(),
    freeSlots,
    capacity: layout.capacity,
    requestedCapacity,
    slotDims,
    slotsX: layout.slotsX,
    slotsY: layout.slotsY,
    slotsZ: layout.slotsZ,
    kind,
    channel,
    touchOrder: [],
  };
}

export function computeProxyAtlasLayout(
  slotDims: [number, number, number],
  requestedCapacity: number,
  maxTextureDimension3D: number,
): ProxyAtlasLayout {
  const [slotZ, slotY, slotX] = slotDims;
  if (slotX <= 0 || slotY <= 0 || slotZ <= 0) {
    throw new Error(`[proxyAtlas] invalid slotDims=${slotDims.join(",")}`);
  }

  const maxSlotsX = Math.floor(maxTextureDimension3D / slotX);
  const maxSlotsY = Math.floor(maxTextureDimension3D / slotY);
  const maxSlotsZ = Math.floor(maxTextureDimension3D / slotZ);
  if (maxSlotsX < 1 || maxSlotsY < 1 || maxSlotsZ < 1) {
    throw new Error(
      `[proxyAtlas] slotDims=${slotDims.join(",")} exceed maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }

  const maxCapacity = maxSlotsX * maxSlotsY * maxSlotsZ;
  const capacity = Math.min(
    Math.max(1, Math.floor(requestedCapacity)),
    maxCapacity,
  );

  let best: ProxyAtlasLayout | null = null;
  const maxCandidateX = Math.min(maxSlotsX, capacity);
  for (let slotsX = 1; slotsX <= maxCandidateX; slotsX++) {
    const maxCandidateY = Math.min(maxSlotsY, Math.ceil(capacity / slotsX));
    for (let slotsY = 1; slotsY <= maxCandidateY; slotsY++) {
      const slotsZ = Math.ceil(capacity / (slotsX * slotsY));
      if (slotsZ < 1 || slotsZ > maxSlotsZ) continue;

      const textureSize: [number, number, number] = [
        slotsX * slotX,
        slotsY * slotY,
        slotsZ * slotZ,
      ];
      const candidate: ProxyAtlasLayout = {
        capacity,
        slotsX,
        slotsY,
        slotsZ,
        textureSize,
      };
      if (!best || compareLayouts(candidate, best) < 0) best = candidate;
    }
  }

  if (!best) {
    throw new Error(
      `[proxyAtlas] cannot pack capacity=${capacity} slotDims=${slotDims.join(",")} ` +
        `under maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }
  return best;
}

function compareLayouts(a: ProxyAtlasLayout, b: ProxyAtlasLayout): number {
  const aAllocated = a.slotsX * a.slotsY * a.slotsZ;
  const bAllocated = b.slotsX * b.slotsY * b.slotsZ;
  if (aAllocated !== bAllocated) return aAllocated - bAllocated;

  const aMaxAxis = Math.max(...a.textureSize);
  const bMaxAxis = Math.max(...b.textureSize);
  if (aMaxAxis !== bMaxAxis) return aMaxAxis - bMaxAxis;

  const aMinAxis = Math.min(...a.textureSize);
  const bMinAxis = Math.min(...b.textureSize);
  if (aMinAxis !== bMinAxis) return bMinAxis - aMinAxis;

  const aArea = a.textureSize[0] * a.textureSize[1] * a.textureSize[2];
  const bArea = b.textureSize[0] * b.textureSize[1] * b.textureSize[2];
  return aArea - bArea;
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
  return allocateProxySlotWithEviction(atlas, key).slotIndex;
}

/**
 * Allocate (or look up) a slot for `key`, returning the evicted slot key
 * when the allocation had to reuse an occupied slot.
 */
export function allocateProxySlotWithEviction(
  atlas: ProxyAtlasState,
  key: string,
): ProxySlotAllocation {
  const existing = atlas.slots.get(key);
  if (existing !== undefined) {
    moveToEnd(atlas.touchOrder, key);
    return { slotIndex: existing, evictedKey: null };
  }

  let slotIndex: number;
  let evictedKey: string | null = null;
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
    evictedKey = victim;
  }

  atlas.slots.set(key, slotIndex);
  atlas.touchOrder.push(key);
  return { slotIndex, evictedKey };
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
 * Release a resident slot without touching GPU memory. Returns the freed
 * slot index, or undefined if the key was not resident.
 */
export function releaseProxySlot(
  atlas: ProxyAtlasState,
  key: string,
): number | undefined {
  const slotIndex = atlas.slots.get(key);
  if (slotIndex === undefined) return undefined;
  atlas.slots.delete(key);
  const idx = atlas.touchOrder.indexOf(key);
  if (idx >= 0) atlas.touchOrder.splice(idx, 1);
  if (!atlas.freeSlots.includes(slotIndex)) atlas.freeSlots.push(slotIndex);
  return slotIndex;
}

/**
 * Compute the [x, y, z] origin in the atlas texture for a slot index.
 */
export function proxySlotOrigin(
  atlas: ProxyAtlasState,
  slotIndex: number,
): [number, number, number] {
  const tileX = slotIndex % atlas.slotsX;
  const tileY = Math.floor(slotIndex / atlas.slotsX) % atlas.slotsY;
  const tileZ = Math.floor(slotIndex / (atlas.slotsX * atlas.slotsY));
  return [
    tileX * atlas.slotDims[2],
    tileY * atlas.slotDims[1],
    tileZ * atlas.slotDims[0],
  ];
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
