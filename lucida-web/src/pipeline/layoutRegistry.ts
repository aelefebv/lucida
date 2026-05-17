/**
 * Layout Registry (web mirror) — tracks per-dataset available layouts and
 * the currently active layout id. Mirrors the WASM-side `registered_layouts`
 * + `active_layout_ids` so the UI (`<LayoutSwitcher>`, `PlateSelector`) can
 * read without paying a JSON round-trip per render.
 *
 * Authority for layout state is Rust/WASM. This class:
 *
 *   1. Forwards every mutation as a document command via
 *      `wasmScene.apply_command(json)` AND `sendCommand(json)`, so it
 *      applies locally and broadcasts to peers (matching the
 *      `applyDocumentCommand` flow in `applyAndSend.ts`).
 *   2. Refreshes the available list from `wasmScene.available_layouts()`
 *      after every relevant mutation (and after inbound bridge events).
 *   3. Stores derived-layout `LayoutSpec` values locally so consumers like
 *      PlateSelector can read placements without a WASM round-trip
 *      (`available_layouts` only returns id+name).
 *   4. Notifies subscribers on every change for `useSyncExternalStore`.
 */

import type { LayoutSpec } from "../manifestTypes.ts";

export interface LayoutInfo {
  id: string;
  name: string;
}

/** Minimal WASM surface needed by `LayoutRegistry`. Real `WasmScene` satisfies this. */
export interface LayoutRegistryWasm {
  apply_command(json: string): void;
  available_layouts(datasetId: string): string;
}

export class LayoutRegistry {
  /** datasetId → ordered list of available layouts (source + registered, per WASM order). */
  private readonly availableByDataset = new Map<string, LayoutInfo[]>();
  /** datasetId → active layout id (mirror; updated locally on register/setActive/setActiveLocal). */
  private readonly activeByDataset = new Map<string, string>();
  /** datasetId → layoutId → LayoutSpec for derived layouts we registered.
   *  Source layouts are NOT mirrored here; consumers fall back to `manifest.source_layouts`. */
  private readonly specsByDataset = new Map<string, Map<string, LayoutSpec>>();
  private readonly listeners = new Set<() => void>();
  /** Monotonic counter bumped on every notify(); useful for `useSyncExternalStore`
   *  consumers that need a stable primitive snapshot. */
  private versionCounter = 0;
  private readonly wasmScene: LayoutRegistryWasm;

  constructor(wasmScene: LayoutRegistryWasm) {
    this.wasmScene = wasmScene;
  }

  /**
   * Register a derived layout with WASM and broadcast it. Idempotent on
   * `spec.id` thanks to Rust dedupe — re-registering with the same id
   * is a no-op for `available_layouts`, but the local `specsByDataset`
   * mirror updates so the latest spec content wins.
   */
  register(datasetId: string, spec: LayoutSpec, sendCommand: (json: string) => void): void {
    const cmd = { type: "register_layout", dataset_id: datasetId, layout: spec };
    const json = JSON.stringify(cmd);
    this.wasmScene.apply_command(json);
    sendCommand(json);

    let specs = this.specsByDataset.get(datasetId);
    if (!specs) {
      specs = new Map();
      this.specsByDataset.set(datasetId, specs);
    }
    specs.set(spec.id, spec);

    this.refresh(datasetId);
    this.notify();
  }

  /** Set the active layout for a dataset and broadcast. */
  setActive(datasetId: string, layoutId: string, sendCommand: (json: string) => void): void {
    const cmd = { type: "set_active_layout", dataset_id: datasetId, layout_id: layoutId };
    const json = JSON.stringify(cmd);
    this.wasmScene.apply_command(json);
    sendCommand(json);

    this.activeByDataset.set(datasetId, layoutId);
    this.notify();
  }

  /**
   * Update the local active mirror without re-broadcasting. Used by the
   * bridge when an inbound `set_active_layout` is applied (the WASM side
   * already changed; we just sync the mirror).
   */
  setActiveLocal(datasetId: string, layoutId: string): void {
    this.activeByDataset.set(datasetId, layoutId);
    this.notify();
  }

  /**
   * Pull the available list from WASM into the mirror. Called internally
   * after every register/setActive, and externally by the bridge after
   * applying an inbound `register_layout` / `set_active_layout` command.
   */
  refresh(datasetId: string): void {
    const json = this.wasmScene.available_layouts(datasetId);
    const list = JSON.parse(json) as LayoutInfo[];
    this.availableByDataset.set(datasetId, list);
    this.notify();
  }

  /** Drop all mirror entries for a dataset. WASM-side cleanup happens via RemoveDataset. */
  removeDataset(datasetId: string): void {
    this.availableByDataset.delete(datasetId);
    this.activeByDataset.delete(datasetId);
    this.specsByDataset.delete(datasetId);
    this.notify();
  }

  /** Available layouts for a dataset (source + registered). Empty array if unknown. */
  available(datasetId: string): LayoutInfo[] {
    return this.availableByDataset.get(datasetId) ?? [];
  }

  /** Currently active layout id, or null if none has been set on this client. */
  activeId(datasetId: string): string | null {
    return this.activeByDataset.get(datasetId) ?? null;
  }

  /**
   * Returns the registered `LayoutSpec` for `(datasetId, layoutId)`, or null
   * if it isn't a derived layout we registered (e.g., source layouts —
   * callers should fall back to `manifest.source_layouts`).
   */
  getSpec(datasetId: string, layoutId: string): LayoutSpec | null {
    return this.specsByDataset.get(datasetId)?.get(layoutId) ?? null;
  }

  /** Subscribe to mirror changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Monotonic version that bumps on every change. Use as the snapshot for
   *  `useSyncExternalStore` and read fresh state via `available()` / `activeId()`. */
  getVersion(): number {
    return this.versionCounter;
  }

  private notify(): void {
    this.versionCounter += 1;
    for (const l of this.listeners) l();
  }
}
