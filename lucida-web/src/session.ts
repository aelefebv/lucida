import type { Bridge } from "./bridge.ts";
import type { ProxiedContentSource, CpuCache, DecodePool } from "./pipeline/fetch/index.ts";
import { AssetCatalog } from "./pipeline/assetCatalog.ts";
import { GeneratedAvailabilityCatalog } from "./pipeline/generatedAvailability.ts";
import { LayoutRegistry } from "./pipeline/layoutRegistry.ts";
import type { WasmScene } from "lucida-core";

/**
 * Per-bridge state container. Lifetime-coupled to the WebSocket connection,
 * NOT to a particular render mode. RenderLoop reads from Session so that
 * mode switches (which recreate RenderLoop) cannot lose this state.
 *
 * Eager fields are constructed with the Session. Lazy fields (`scene`,
 * `assetCatalog`, `layoutRegistry`) become non-null after the first server
 * snapshot — consumers must null-guard or call the corresponding ensure*().
 *
 * If you're adding new persistent state and it should survive a 2D↔3D
 * toggle, it goes here. If it's tied to a specific worker / canvas / GPU
 * resource, it goes on RenderLoop.
 */
export class Session {
  readonly bridge: Bridge;
  readonly contentSource: ProxiedContentSource;
  readonly cpuCache: CpuCache;
  readonly decodePool: DecodePool;
  readonly generatedAvailability = new GeneratedAvailabilityCatalog();

  scene: WasmScene | null = null;
  assetCatalog: AssetCatalog | null = null;
  layoutRegistry: LayoutRegistry | null = null;

  private destroyed = false;

  constructor(opts: {
    bridge: Bridge;
    contentSource: ProxiedContentSource;
    cpuCache: CpuCache;
    decodePool: DecodePool;
  }) {
    this.bridge = opts.bridge;
    this.contentSource = opts.contentSource;
    this.cpuCache = opts.cpuCache;
    this.decodePool = opts.decodePool;
  }

  setScene(scene: WasmScene): void {
    this.scene = scene;
  }

  /**
   * Release everything this session owns that holds live resources:
   * the WebSocket + its reconnect/throttle timers (bridge), in-flight
   * fetches and their abort controllers / caches (cpuCache), pending
   * request timeouts (contentSource), and the decode workers
   * (decodePool). The lazily built catalogs/registry and the scene
   * reference hold no sockets/workers/timers, so dropping the Session
   * is enough for them (the scene itself is owned by the caller).
   *
   * Idempotent: a second call is a no-op, so overlapping teardown paths
   * (workspace archive destroys the bridge; unmount destroys the
   * session) are safe in any order.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bridge.destroy();
    this.cpuCache.reset();
    this.contentSource.rejectAll();
    this.decodePool.terminate();
  }

  /**
   * Lazy-construct AssetCatalog after WasmScene is available. Returns null
   * if scene is not yet set (caller should retry once scene exists).
   */
  ensureAssetCatalog(): AssetCatalog | null {
    if (this.assetCatalog) return this.assetCatalog;
    if (!this.scene) return null;
    this.assetCatalog = new AssetCatalog(this.scene);
    return this.assetCatalog;
  }

  /**
   * Lazy-construct LayoutRegistry after WasmScene is available. Returns null
   * if scene is not yet set.
   */
  ensureLayoutRegistry(): LayoutRegistry | null {
    if (this.layoutRegistry) return this.layoutRegistry;
    if (!this.scene) return null;
    this.layoutRegistry = new LayoutRegistry(this.scene);
    return this.layoutRegistry;
  }
}
