/**
 * Memory budgets fitted to the device.
 *
 * The GPU total is the one figure the device decides, and the CPU stores
 * follow it. No browser reports how much memory the GPU has, so the total
 * comes from what kind of device this is and how much memory it reports, and
 * a person can set it in Settings (`pageBudgets.ts`).
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface DeviceBudgets {
  /**
   * Everything the render worker holds on the GPU: chunk pools and each
   * view's indirection over them, label pools, render targets, and minimap
   * textures. Chunk pools grow toward it as chunks arrive and share what the
   * rest leave.
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
  /** Fetched bytes the CPU cache allows outstanding. */
  cpuBytesInFlight: number;
}

/** What the page can tell about the device it runs on. */
export interface DeviceFacts {
  /**
   * The device's memory in GiB as the browser reports it, an assumed figure
   * for a touch-only device that reports none, or null.
   */
  memoryGiB: number | null;
  /** Touch is its only pointer: a phone, or a tablet with nothing attached. */
  touchOnly: boolean;
  /**
   * Whether the WebGPU adapter is a software rasterizer, null while unknown
   * or when the browser doesn't say. The adapter's vendor and architecture
   * say nothing reliable about how much memory it has, or whether it shares
   * the device's, so they aren't read.
   */
  fallbackAdapter: boolean | null;
}

/**
 * `desktop`: a hardware adapter with a fine pointer, whose GPU most likely
 * has memory of its own. `constrained`: a phone, a tablet or a software
 * adapter, whose GPU draws on the device's own memory, which the system takes
 * back by ending the page.
 */
export type DeviceClass = "desktop" | "constrained";

export function deviceClassOf(facts: DeviceFacts): DeviceClass {
  return facts.touchOnly || facts.fallbackAdapter === true ? "constrained" : "desktop";
}

/**
 * A desktop's GPU total, unless its memory is small: half of a mid-range
 * desktop GPU's 8 GB. The level selection fills its budget, so the total is
 * how much detail a large volume draws. At this total a workstation GPU's
 * gestures over a large volume keep the lag of a smaller one: their frames
 * sample the coarser levels the selection keeps resident, no pool grows
 * while the view moves, a zoom holds refinement until it ends, and the
 * stages after the plan take a zoom's thousands of changes a few
 * milliseconds a frame rather than all on one. A larger GPU is the person's
 * to claim in Settings.
 */
const DESKTOP_GPU_TOTAL = 4 * GIB;

/**
 * A constrained device's GPU total at 8 GiB of memory, the most a phone's
 * browser reports. The detail store follows it, so the selection is no larger
 * than the 512 MiB store gave it before. A desktop that has fallen back to a
 * software adapter is as constrained as the phone the adapter stands in for.
 */
const CONSTRAINED_GPU_TOTAL = 512 * MIB;

/**
 * The share of a desktop's memory its detail store may take: a quarter, the
 * share of physical memory V8 sets as a page's heap limit.
 */
const MEMORY_SHARE = 1 / 4;

/**
 * The share of the device's memory a GPU total set in Settings may draw CPU
 * stores from. The person chose the total and the stores follow it, up to
 * this, so a total set past what the device holds can't take its memory too.
 */
const SET_MEMORY_SHARE = 1 / 2;

/**
 * What a desktop that reports no memory is taken to have, as Safari and
 * Firefox report none. A Mac shares it with its GPU, and an 8 GiB machine
 * given a 16 GiB machine's budgets is the one that swaps.
 */
const ASSUMED_DESKTOP_MEMORY_GIB = 8;

/**
 * What a touch-only device that doesn't report its memory is taken to have.
 * Safari reports none, and a phone given desktop budgets is the one the
 * system kills.
 */
export const ASSUMED_TOUCH_MEMORY_GIB = 4;

/**
 * The smallest GPU total. Below it one viewport's chunks stop fitting.
 */
export const GPU_TOTAL_FLOOR_BYTES = 192 * MIB;

/** The smallest detail store, for the same reason. */
const CPU_MAIN_FLOOR_BYTES = 64 * MIB;

/** The smallest label budget: one 256³ label level of 32-bit samples. */
const LABEL_VOLUME_FLOOR_BYTES = 64 * MIB;

/**
 * The coarse overview store: the room the coarse tier keeps however much
 * detail is wanted. Past it the coarse tier borrows from the detail store,
 * so it need only hold the coarse levels of the datasets open at once, a few
 * MiB each for a multichannel volume of 24 GiB.
 */
const CPU_OVERVIEW_BYTES = 64 * MIB;
/** Enough for the coarse levels of two such volumes. */
const CPU_OVERVIEW_FLOOR_BYTES = 16 * MIB;

/**
 * The most fetched bytes outstanding, which they hold in memory until they
 * land. Under it the link's measured rate and round trip size them, since a
 * move's first chunks wait behind what is in flight: on a broadband link
 * these 32 MiB would take about two seconds. On one machine twice as much,
 * enough for all 128 concurrent fetches of 64³ chunks, fills a store only
 * about a tenth faster.
 */
const CPU_BYTES_IN_FLIGHT = 32 * MIB;
/**
 * Twice the bytes allowed before anything lands
 * (`INITIAL_BYTES_IN_FLIGHT`), so the allowance still has room to grow.
 */
const CPU_BYTES_IN_FLIGHT_FLOOR = 8 * MIB;

/**
 * The memory below which a constrained device's GPU total, the overview store
 * and the bytes in flight shrink in proportion. A phone reports at most this,
 * shares it with its GPU, and is also the device on the slowest link.
 */
const SMALL_DEVICE_MEMORY_GIB = 8;

/**
 * Labels shown at once take at most a third of the GPU total, so the
 * intensity pools beside them keep two thirds.
 */
const LABEL_SHARE = 1 / 3;

/**
 * One label level is one texture, and no texture may grow past the largest
 * buffer a desktop adapter commonly allows, 2 GiB, as the chunk pools don't
 * (`renderer/atlasSizing.ts`). A D3D12 device refuses a 4 GiB texture however
 * much memory its GPU has.
 */
const LABEL_VOLUME_MAX_BYTES = 2 * GIB;

/** `bytes` rounded down to whole MiB, and no less than `floor`. */
function mib(bytes: number, floor: number): number {
  return Math.max(floor, Math.floor(bytes / MIB) * MIB);
}

/** The memory the budgets are fitted to: the reported figure, or an assumed one. */
function memoryOf(facts: DeviceFacts): number {
  return facts.memoryGiB ?? ASSUMED_DESKTOP_MEMORY_GIB;
}

/** The GPU total the device starts at when no one has set one: its class's, or less when its memory is small. */
export function deviceGpuTotal(facts: DeviceFacts): number {
  return mib(fittedGpuTotal(facts), GPU_TOTAL_FLOOR_BYTES);
}

/** {@link deviceGpuTotal} before its floor. */
function fittedGpuTotal(facts: DeviceFacts): number {
  if (deviceClassOf(facts) === "desktop") {
    // The detail store copies the whole total, so it alone counts against
    // memory, which binds below 16 GiB.
    return Math.min(DESKTOP_GPU_TOTAL, memoryOf(facts) * GIB * MEMORY_SHARE);
  }
  return CONSTRAINED_GPU_TOTAL * smallDeviceFraction(facts);
}

function smallDeviceFraction(facts: DeviceFacts): number {
  return Math.min(1, memoryOf(facts) / SMALL_DEVICE_MEMORY_GIB);
}

/**
 * The budgets for `facts`, under a GPU total a person set, or the device's
 * own when `gpuTotalSet` is null.
 */
export function fitBudgets(facts: DeviceFacts, gpuTotalSet: number | null = null): DeviceBudgets {
  const gpuTotalBytes = gpuTotalSet === null ? deviceGpuTotal(facts) : mib(gpuTotalSet, GPU_TOTAL_FLOOR_BYTES);
  const memory = memoryOf(facts) * GIB;
  const storesShare = gpuTotalSet === null ? MEMORY_SHARE : SET_MEMORY_SHARE;
  // The detail store holds a decoded copy of every chunk the GPU's pools
  // hold, so it holds as much as the whole total. The total's share that
  // render targets and labels take, and the share the level selection leaves
  // unselected, are its room for what the GPU doesn't hold: prefetch, and
  // chunks the GPU let go that may come back. It follows the total as the
  // device fits it, before the total's floor, so a small phone's store is no
  // larger than it was.
  const followed = gpuTotalSet ?? fittedGpuTotal(facts);
  const cpuMainBytes = mib(Math.min(followed, memory * storesShare), CPU_MAIN_FLOOR_BYTES);
  const smallDevice = smallDeviceFraction(facts);
  const labelVolumeBytes = mib(Math.min(LABEL_VOLUME_MAX_BYTES, gpuTotalBytes * LABEL_SHARE), LABEL_VOLUME_FLOOR_BYTES);
  return {
    gpuTotalBytes,
    labelVolumeBytes,
    labelTotalVolumeBytes: labelVolumeBytes,
    cpuMainBytes,
    cpuOverviewBytes: mib(CPU_OVERVIEW_BYTES * smallDevice, CPU_OVERVIEW_FLOOR_BYTES),
    cpuBytesInFlight: mib(CPU_BYTES_IN_FLIGHT * smallDevice, CPU_BYTES_IN_FLIGHT_FLOOR),
  };
}

/**
 * A desktop's budgets with plenty of memory: what the CPU cache and the
 * render worker fall back to when no budgets are handed to them.
 */
export const DESKTOP_BUDGETS: Readonly<DeviceBudgets> = fitBudgets({
  memoryGiB: 16,
  touchOnly: false,
  fallbackAdapter: false,
});

/**
 * The GPU total after the device ran out of memory under `bytes`: half, down
 * to the floor. Returns `bytes` unchanged when it is already at the floor.
 */
export function halvedGpuTotal(bytes: number): number {
  if (bytes <= GPU_TOTAL_FLOOR_BYTES) return bytes;
  return Math.max(GPU_TOTAL_FLOOR_BYTES, Math.floor(bytes / 2 / MIB) * MIB);
}

/** The parts of the page {@link readDeviceFacts} reads, so a test can supply its own. */
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

function isTouchOnly(source: DeviceMemorySource): boolean {
  const media = source.matchMedia;
  return media !== undefined && media("(pointer: coarse)").matches && !media("(any-pointer: fine)").matches;
}

/**
 * The device's memory in GiB as the browser reports it, an assumed figure for
 * a touch-only device that reports none, or null when neither applies.
 * Chrome reports up to 32 on a desktop and 8 on a phone.
 */
export function readDeviceMemoryGiB(source: DeviceMemorySource = pageSource()): number | null {
  const reported = source.deviceMemory;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;
  return isTouchOnly(source) ? ASSUMED_TOUCH_MEMORY_GIB : null;
}

/** What the page reads of the device synchronously: everything but the adapter. */
export function readDeviceFacts(source: DeviceMemorySource = pageSource()): Omit<DeviceFacts, "fallbackAdapter"> {
  return { memoryGiB: readDeviceMemoryGiB(source), touchOnly: isTouchOnly(source) };
}
