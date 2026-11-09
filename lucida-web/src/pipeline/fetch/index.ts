/**
 * Fetch/decode subsystem barrel re-export.
 *
 * Public surface for callers outside `pipeline/fetch/`. Internal modules
 * import from sibling files directly.
 */

export {
  CpuCache,
  DEFAULT_MAIN_BUDGET,
  DEFAULT_OVERVIEW_BUDGET,
  DEFAULT_MAX_BYTES_IN_FLIGHT,
  DEFAULT_MAX_CONCURRENT_FETCHES,
  TRANSIENT_RETRY_DELAY_MS,
  MAX_TRANSIENT_RETRIES,
  INTERACTION_MODE_WINDOW,
} from "./cpuCache.ts";
export type { FailedChunk } from "./cpuCache.ts";
export type {
  CpuCacheConfig,
  EvictionTier,
  ReadyChunkDelivery,
  CacheTelemetry,
  TierResidencyEntry,
  TierCounters,
} from "./types.ts";

export {
  CACHE_KNOB_FIELDS,
  CACHE_KNOB_PREFERENCES,
  readCacheKnobs,
  subscribeCacheKnobs,
} from "./cacheKnobs.ts";
export type { CacheKnobField, CacheKnobs } from "./cacheKnobs.ts";

export { ProxiedContentSource } from "./contentSource.ts";
export type {
  ContentSource,
  FetchRequest,
  FetchResult,
} from "./contentSource.ts";

export {
  DecodePool,
  MIN_DECODE_WORKERS,
  DECODE_POOL_HEADROOM,
  defaultPoolSize,
} from "./decodePool.ts";

export { InteractionModeDetector } from "./interactionMode.ts";
export type { InteractionMode } from "./interactionMode.ts";

export { DeliveryState } from "./deliveryState.ts";

export {
  FetchError,
  classifyFetchError,
  OnceTransientRetry,
} from "./retry.ts";
export type { FetchErrorKind, RetryPolicy } from "./retry.ts";
