import type { Bridge } from "./bridge.ts";
import type { ProxiedContentSource, CpuCache, DecodePool } from "./pipeline/fetch/index.ts";
import { GeneratedAvailabilityCatalog } from "./pipeline/generatedAvailability.ts";
import { LayoutRegistry } from "./pipeline/layoutRegistry.ts";
import type { WasmScene } from "lucida-core";

/**
 * Per-bridge state container. Lifetime-coupled to the WebSocket connection,
 * not to a render mode. RenderLoop reads from Session so that mode switches
 * (which recreate RenderLoop) cannot lose this state.
 *
 * Eager fields are constructed with the Session. Lazy fields (`scene`,
 * `layoutRegistry`) become non-null after the first server snapshot;
 * consumers must null-guard or call the matching ensure*().
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
   * Release everything holding live resources: the WebSocket and its timers,
   * in-flight fetches, pending request timeouts, and the decode workers. The
   * layout registry and the scene reference hold none; the caller owns the
   * scene.
   *
   * Idempotent, so overlapping teardown paths (archive destroys the bridge,
   * unmount destroys the session) are safe in any order.
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
