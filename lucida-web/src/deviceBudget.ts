/**
 * Memory budgets fitted to the device. The page reads the device's memory
 * once and hands it to the render worker, which fits its GPU total from it.
 */

const MIB = 1024 * 1024;

/** Reported device memory, in GiB, from which every budget is at its ceiling. */
export const FULL_BUDGET_MEMORY_GIB = 8;

/**
 * What a touch-only device that doesn't report its memory is taken to have.
 * Safari reports none, and a phone given desktop budgets is the one the
 * system kills; a desktop that reports none keeps the ceiling.
 */
export const ASSUMED_TOUCH_MEMORY_GIB = 4;

export interface DeviceBudgets {
  /**
   * Everything the render worker holds on the GPU: chunk, label, and proxy
   * pools, render targets, and minimap textures. Chunk pools grow toward it
   * as chunks arrive and share what the rest leave.
   */
  gpuTotalBytes: number;
  /** One label's volume atlas, chosen by level. */
  labelVolumeBytes: number;
  /** Every label volume atlas shown at once. */
  labelTotalVolumeBytes: number;
  /** The CPU cache's detail store. */
  cpuMainBytes: number;
  /** The CPU cache's coarse overview store. */
  cpuOverviewBytes: number;
  /** The CPU cache's proxy store. */
  cpuProxyBytes: number;
  /** Fetched bytes the CPU cache allows outstanding. */
  cpuBytesInFlight: number;
}

/** A capable desktop's budgets, which no device exceeds. */
export const CEILING_BUDGETS: Readonly<DeviceBudgets> = {
  gpuTotalBytes: 1536 * MIB,
  labelVolumeBytes: 512 * MIB,
  labelTotalVolumeBytes: 512 * MIB,
  cpuMainBytes: 512 * MIB,
  cpuOverviewBytes: 64 * MIB,
  cpuProxyBytes: 256 * MIB,
  cpuBytesInFlight: 32 * MIB,
};

/** Below these a viewport stops fitting its own chunks, whatever the device. */
const FLOOR_BUDGETS: Readonly<DeviceBudgets> = {
  gpuTotalBytes: 192 * MIB,
  labelVolumeBytes: 64 * MIB,
  labelTotalVolumeBytes: 64 * MIB,
  cpuMainBytes: 64 * MIB,
  cpuOverviewBytes: 16 * MIB,
  cpuProxyBytes: 32 * MIB,
  cpuBytesInFlight: 8 * MIB,
};

/**
 * The budgets for a device with `memoryGiB` of memory, or the ceiling when
 * that is unknown. Each scales linearly below {@link FULL_BUDGET_MEMORY_GIB}
 * down to its floor.
 */
export function fitBudgets(memoryGiB: number | null): DeviceBudgets {
  const fraction = memoryGiB === null ? 1 : Math.min(1, Math.max(0, memoryGiB / FULL_BUDGET_MEMORY_GIB));
  const fit = (key: keyof DeviceBudgets) =>
    Math.max(FLOOR_BUDGETS[key], Math.floor((CEILING_BUDGETS[key] * fraction) / MIB) * MIB);
  return {
    gpuTotalBytes: fit("gpuTotalBytes"),
    labelVolumeBytes: fit("labelVolumeBytes"),
    labelTotalVolumeBytes: fit("labelTotalVolumeBytes"),
    cpuMainBytes: fit("cpuMainBytes"),
    cpuOverviewBytes: fit("cpuOverviewBytes"),
    cpuProxyBytes: fit("cpuProxyBytes"),
    cpuBytesInFlight: fit("cpuBytesInFlight"),
  };
}

/** The smallest GPU total. Below it one viewport's chunks stop fitting. */
export const GPU_TOTAL_FLOOR_BYTES = FLOOR_BUDGETS.gpuTotalBytes;

/**
 * The GPU total after the device ran out of memory under `bytes`: half, down
 * to the floor. Returns `bytes` unchanged when it is already at the floor.
 */
export function halvedGpuTotal(bytes: number): number {
  if (bytes <= GPU_TOTAL_FLOOR_BYTES) return bytes;
  return Math.max(GPU_TOTAL_FLOOR_BYTES, Math.floor(bytes / 2 / MIB) * MIB);
}

/** The parts of the page {@link readDeviceMemoryGiB} reads, so a test can supply its own. */
export interface DeviceMemorySource {
  deviceMemory?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
}

function pageSource(): DeviceMemorySource {
  if (typeof navigator === "undefined") return {};
  const source: DeviceMemorySource = { deviceMemory: (navigator as { deviceMemory?: unknown }).deviceMemory };
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    source.matchMedia = (query) => window.matchMedia(query);
  }
  return source;
}

/**
 * The device's memory in GiB as the browser reports it, an assumed figure for
 * a touch-only device that reports none, or null when neither applies.
 */
export function readDeviceMemoryGiB(source: DeviceMemorySource = pageSource()): number | null {
  const reported = source.deviceMemory;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;
  const media = source.matchMedia;
  if (media && media("(pointer: coarse)").matches && !media("(any-pointer: fine)").matches) {
    return ASSUMED_TOUCH_MEMORY_GIB;
  }
  return null;
}

let pageBudgets: DeviceBudgets | null = null;

/**
 * The page's own budgets, from its memory alone. Read once: the reading
 * doesn't change while the page lives, and the fetch planner and the
 * renderer must agree on the label caps from it.
 */
export function pageDeviceBudgets(): DeviceBudgets {
  pageBudgets ??= fitBudgets(readDeviceMemoryGiB());
  return pageBudgets;
}
