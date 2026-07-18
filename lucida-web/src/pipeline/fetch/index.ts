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
  FETCH_CONCURRENCY_MULTIPLIER,
  TRANSIENT_RETRY_DELAY_MS,
  MAX_TRANSIENT_RETRIES,
  INTERACTION_MODE_WINDOW,
} from "./cpuCache.ts";
export type {
  DatasetPlanPublication,
  DatasetPlanDeltaPublication,
} from "./cpuCache.ts";
export type {
  CpuCacheConfig,
  EvictionTier,
  ReadyDelivery,
  ReadyChunkDelivery,
  ResidencyTier,
  CacheTelemetry,
  TierResidencyEntry,
  TierCounters,
} from "./types.ts";

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
  NeverRetry,
} from "./retry.ts";
export type { FetchErrorKind, RetryPolicy } from "./retry.ts";
