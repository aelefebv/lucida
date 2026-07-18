/**
 * Session-wide accounting and ownership for WebGPU resources.
 *
 * WebGPU does not expose an adapter VRAM budget, so Lucida uses a conservative
 * process-local ceiling. Every destroyable renderer allocation goes through this
 * object. A tracked allocation owns both the byte reservation and the WebGPU
 * handle; destroying it is idempotent and releases both exactly once.
 */

export type GpuResourceKind =
  | "volume-atlas"
  | "slice-atlas"
  | "label-volume"
  | "label-slice"
  | "descriptor"
  | "offscreen"
  | "minimap"
  | "depth"
  | "lookup"
  | "buffer";

export interface GpuResourceOwner {
  /** Stable, session-unique ownership key. */
  key: string;
  kind: GpuResourceKind;
  /** Dataset-scoped resources are reclaimed together on dataset removal. */
  datasetId?: string;
}

export interface GpuBudgetSnapshot {
  limitBytes: number;
  usedBytes: number;
  peakBytes: number;
  allocationCount: number;
  createdCount: number;
  destroyedCount: number;
  createdBytes: number;
  destroyedBytes: number;
  byKind: Partial<Record<GpuResourceKind, number>>;
  byDataset: Record<string, number>;
}

export class GpuBudgetExceededError extends Error {
  readonly requestedBytes: number;
  readonly availableBytes: number;
  readonly ownerKey: string;

  constructor(
    requestedBytes: number,
    availableBytes: number,
    ownerKey: string,
  ) {
    super(
      `WebGPU session budget exceeded for ${ownerKey}: requested ` +
        `${requestedBytes} bytes with ${availableBytes} bytes available`,
    );
    this.name = "GpuBudgetExceededError";
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
    this.ownerKey = ownerKey;
  }
}

interface Destroyable {
  destroy(): void;
}

interface LiveAllocation<T extends Destroyable> {
  id: number;
  owner: GpuResourceOwner;
  bytes: number;
  resource: T;
}

/** Idempotent owner handle for one WebGPU resource. */
export class TrackedGpuResource<T extends Destroyable> {
  readonly resource: T;
  private readonly budget: GpuResourceBudget;
  private readonly id: number;

  constructor(
    resource: T,
    budget: GpuResourceBudget,
    id: number,
  ) {
    this.resource = resource;
    this.budget = budget;
    this.id = id;
  }

  get destroyed(): boolean {
    return !this.budget.hasAllocation(this.id);
  }

  destroy(): void {
    this.budget.destroyAllocation(this.id);
  }
}

/**
 * One allocator per GPUDevice/renderer session.
 *
 * `allocate` reserves first and rolls the reservation back if the browser
 * rejects resource creation. Stable owner keys make accidental double-live
 * resources an error instead of silently losing the handle needed to reclaim
 * the first allocation.
 */
export class GpuResourceBudget {
  private nextId = 1;
  private used = 0;
  private peak = 0;
  private created = 0;
  private destroyed = 0;
  private createdBytes = 0;
  private destroyedBytes = 0;
  private allocations = new Map<number, LiveAllocation<Destroyable>>();
  private idByOwnerKey = new Map<string, number>();

  readonly limitBytes: number;

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error(`Invalid WebGPU session budget: ${limitBytes}`);
    }
    this.limitBytes = limitBytes;
  }

  get usedBytes(): number {
    return this.used;
  }

  get availableBytes(): number {
    return this.limitBytes - this.used;
  }

  /** The largest legal request at this instant, capped by `preferredMax`. */
  availableUpTo(preferredMax: number): number {
    return Math.max(0, Math.min(preferredMax, this.availableBytes));
  }

  allocate<T extends Destroyable>(
    owner: GpuResourceOwner,
    bytes: number,
    create: () => T,
  ): TrackedGpuResource<T> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Invalid WebGPU allocation size for ${owner.key}: ${bytes}`);
    }
    if (this.idByOwnerKey.has(owner.key)) {
      throw new Error(`WebGPU owner already has a live allocation: ${owner.key}`);
    }
    if (bytes > this.availableBytes) {
      throw new GpuBudgetExceededError(bytes, this.availableBytes, owner.key);
    }

    // Reserve before touching the device. If resource creation throws, no
    // accounting entry survives and no partially-owned handle can be leaked.
    this.used += bytes;
    let resource: T;
    try {
      resource = create();
    } catch (err) {
      this.used -= bytes;
      throw err;
    }

    this.peak = Math.max(this.peak, this.used);
    this.created++;
    this.createdBytes += bytes;

    const id = this.nextId++;
    const allocation: LiveAllocation<T> = { id, owner: { ...owner }, bytes, resource };
    this.allocations.set(id, allocation);
    this.idByOwnerKey.set(owner.key, id);
    return new TrackedGpuResource(resource, this, id);
  }

  /** The only production gate for destroyable GPU buffers. */
  createBuffer(
    device: GPUDevice,
    owner: GpuResourceOwner,
    descriptor: GPUBufferDescriptor,
  ): TrackedGpuResource<GPUBuffer> {
    const bytes = Number(descriptor.size);
    return this.allocate(owner, bytes, () => device.createBuffer(descriptor));
  }

  /** The only production gate for destroyable GPU textures. */
  createTexture(
    device: GPUDevice,
    owner: GpuResourceOwner,
    descriptor: GPUTextureDescriptor,
  ): TrackedGpuResource<GPUTexture> {
    return this.allocate(
      owner,
      texturePayloadBytes(descriptor),
      () => device.createTexture(descriptor),
    );
  }

  /** Reclaim every tracked resource owned by a dataset. Idempotent. */
  destroyDataset(datasetId: string): void {
    const ids = [...this.allocations.values()]
      .filter(allocation => allocation.owner.datasetId === datasetId)
      .map(allocation => allocation.id);
    for (const id of ids) this.destroyAllocation(id);
  }

  /** Reclaim a composed owner (renderer/cache) by its stable key namespace. */
  destroyOwnerPrefix(prefix: string): void {
    const ids = [...this.allocations.values()]
      .filter(allocation => allocation.owner.key.startsWith(prefix))
      .map(allocation => allocation.id);
    for (const id of ids) this.destroyAllocation(id);
  }

  /** Final safety net at worker teardown. Idempotent. */
  destroyAll(): void {
    for (const id of [...this.allocations.keys()]) this.destroyAllocation(id);
  }

  snapshot(): GpuBudgetSnapshot {
    const byKind: Partial<Record<GpuResourceKind, number>> = {};
    const byDataset: Record<string, number> = {};
    for (const allocation of this.allocations.values()) {
      byKind[allocation.owner.kind] =
        (byKind[allocation.owner.kind] ?? 0) + allocation.bytes;
      if (allocation.owner.datasetId) {
        byDataset[allocation.owner.datasetId] =
          (byDataset[allocation.owner.datasetId] ?? 0) + allocation.bytes;
      }
    }
    return {
      limitBytes: this.limitBytes,
      usedBytes: this.used,
      peakBytes: this.peak,
      allocationCount: this.allocations.size,
      createdCount: this.created,
      destroyedCount: this.destroyed,
      createdBytes: this.createdBytes,
      destroyedBytes: this.destroyedBytes,
      byKind,
      byDataset,
    };
  }

  /** Whether an owner handle still refers to a live allocation. */
  hasAllocation(id: number): boolean {
    return this.allocations.has(id);
  }

  /** Internal counterpart to {@link TrackedGpuResource.destroy}. */
  destroyAllocation(id: number): void {
    const allocation = this.allocations.get(id);
    if (!allocation) return;
    this.allocations.delete(id);
    this.idByOwnerKey.delete(allocation.owner.key);
    this.used -= allocation.bytes;
    this.destroyed++;
    this.destroyedBytes += allocation.bytes;
    allocation.resource.destroy();
  }
}

const FORMAT_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  r16uint: 2,
  r32uint: 4,
  rgba8unorm: 4,
  rgba16float: 8,
  // WebGPU leaves the implementation-specific backing layout opaque. Four
  // bytes/texel is the conservative portable payload charge for depth24plus.
  depth24plus: 4,
};

function extentDimensions(size: GPUExtent3D): [number, number, number] {
  if (Symbol.iterator in Object(size)) {
    const values = [...(size as Iterable<number>)];
    return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
  }
  const dict = size as GPUExtent3DDict;
  return [dict.width, dict.height ?? 1, dict.depthOrArrayLayers ?? 1];
}

/** Portable payload footprint used for session accounting. */
export function texturePayloadBytes(descriptor: GPUTextureDescriptor): number {
  const bytesPerTexel = FORMAT_BYTES[descriptor.format];
  if (!bytesPerTexel) {
    throw new Error(`Unaccounted WebGPU texture format: ${descriptor.format}`);
  }
  const [baseWidth, baseHeight, baseDepth] = extentDimensions(descriptor.size);
  const mipLevels = descriptor.mipLevelCount ?? 1;
  const samples = descriptor.sampleCount ?? 1;
  const dimension = descriptor.dimension ?? "2d";
  let texels = 0;
  for (let level = 0; level < mipLevels; level++) {
    const width = Math.max(1, Math.floor(baseWidth / 2 ** level));
    const height = Math.max(1, Math.floor(baseHeight / 2 ** level));
    const depth = dimension === "3d"
      ? Math.max(1, Math.floor(baseDepth / 2 ** level))
      : baseDepth;
    texels += width * height * depth;
  }
  const bytes = texels * bytesPerTexel * samples;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Invalid WebGPU texture payload size: ${bytes}`);
  }
  return bytes;
}
