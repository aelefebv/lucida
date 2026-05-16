import type { Bridge } from "./bridge.ts";
import type { ProxiedContentSource, CpuCache, DecodePool } from "./pipeline/fetch/index.ts";
import { AssetCatalog } from "./pipeline/assetCatalog.ts";
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

  scene: WasmScene | null = null;
  assetCatalog: AssetCatalog | null = null;
  layoutRegistry: LayoutRegistry | null = null;

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
