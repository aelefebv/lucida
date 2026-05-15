/**
 * Asset Catalog (web mirror) — tracks per-entity proxy availability for
 * Planning's promotion decisions.
 *
 * Authority for the catalog is Rust/WASM; this class is a *local mirror*
 * that:
 *   1. forwards every change through `WasmScene.apply_asset_catalog_delta`
 *      so `epochs.asset` stays consistent across native, WASM, and web,
 *      and
 *   2. maintains a JS-side `Map` flattened across datasets that Planning
 *      can read via `snapshot()` without paying a JSON round-trip per tick.
 *
 * S3 scaffold: bridge wires this up but never receives non-empty data,
 * so `snapshot()` always returns an empty `byEntity`. S5 fills in real
 * data; S6 makes Planning consume it.
 */

export type ProxyKind = "WellProxy3D" | "FieldProxy3D";

export interface ProxyAvailabilitySnapshot {
  kinds: Set<ProxyKind>;
}

export interface AssetCatalogSnapshot {
  /** `entityId` -> kinds available for that entity, flattened across datasets. */
  byEntity: Map<string, ProxyAvailabilitySnapshot>;
}

/** Wire shape — matches `lucida_protocol::ProxyAvailability` (snake_case). */
export interface WireProxyAvailability {
  entity_id: string;
  kinds: ProxyKind[];
}

/** Wire shape — matches `lucida_protocol::AssetCatalog`. */
export interface WireAssetCatalog {
  entries: WireProxyAvailability[];
}

/** Wire shape — matches `lucida_protocol::AssetCatalogDelta`. */
export interface WireAssetCatalogDelta {
  added: WireProxyAvailability[];
}

/** Minimal WASM surface needed by `AssetCatalog`. Real `WasmScene` satisfies this. */
export interface AssetCatalogWasm {
  apply_asset_catalog_delta(json: string): void;
}

export class AssetCatalog {
  /** datasetId → entityId → set of available proxy kinds. */
  private readonly byDataset = new Map<string, Map<string, Set<ProxyKind>>>();
  private readonly wasmScene: AssetCatalogWasm;

  constructor(wasmScene: AssetCatalogWasm) {
    this.wasmScene = wasmScene;
  }

  /**
   * Apply an initial catalog snapshot for a dataset (the `catalog` field
   * of `DatasetOpened`). Implemented as a delta apply so that the WASM
   * side bumps `epochs.asset` and the local mirror grows monotonically.
   *
   * Note: when invoked after `WasmScene.apply_command(dataset_opened)`,
   * Rust already seeded `asset_catalogs` from the same entries — the
   * delta merge here is a no-op on Rust state thanks to dedupe, but it
   * keeps `epochs.asset` consistent and populates the JS mirror.
   */
  applyInitial(datasetId: string, catalog: WireAssetCatalog): void {
    this.applyDelta(datasetId, { added: catalog.entries });
  }

  /**
   * Apply an incremental delta to a dataset. Pushes through WASM first
   * (for epoch consistency) then merges into the local mirror.
   */
  applyDelta(datasetId: string, delta: WireAssetCatalogDelta): void {
    // Forward to WASM so the native scene state and asset epoch stay in
    // sync. WASM is the authority; we mirror only what we sent.
    const body = JSON.stringify({ dataset_id: datasetId, delta });
    this.wasmScene.apply_asset_catalog_delta(body);

    // Update local mirror.
    let datasetMap = this.byDataset.get(datasetId);
    if (!datasetMap) {
      datasetMap = new Map();
      this.byDataset.set(datasetId, datasetMap);
    }
    for (const entry of delta.added) {
      let kinds = datasetMap.get(entry.entity_id);
      if (!kinds) {
        kinds = new Set();
        datasetMap.set(entry.entity_id, kinds);
      }
      for (const kind of entry.kinds) {
        kinds.add(kind);
      }
    }
  }

  /**
   * Drop a dataset's mirror entries. Mirror-only — the WASM side handles
   * its own removal via `RemoveDataset` (which also clears the catalog).
   */
  removeDataset(datasetId: string): void {
    this.byDataset.delete(datasetId);
  }

  /**
   * Snapshot for Planning. Flattens all datasets into a single
   * `byEntity` map. Returns a fresh map each call but reuses the inner
   * `Set` references so entries are cheap to read.
   */
  snapshot(): AssetCatalogSnapshot {
    const byEntity = new Map<string, ProxyAvailabilitySnapshot>();
    for (const datasetMap of this.byDataset.values()) {
      for (const [entityId, kinds] of datasetMap) {
        const existing = byEntity.get(entityId);
        if (existing) {
          for (const kind of kinds) existing.kinds.add(kind);
        } else {
          // New Set so callers can't mutate the per-dataset backing store.
          byEntity.set(entityId, { kinds: new Set(kinds) });
        }
      }
    }
    return { byEntity };
  }

  /**
   * Convenience predicate. True if any dataset advertises `kind` for
   * `entityId`.
   */
  hasProxy(entityId: string, kind: ProxyKind): boolean {
    for (const datasetMap of this.byDataset.values()) {
      const kinds = datasetMap.get(entityId);
      if (kinds && kinds.has(kind)) return true;
    }
    return false;
  }
}

/**
 * Free-function predicate over an {@link AssetCatalogSnapshot}: true if
 * the snapshot advertises `kind` for `entityId`.
 *
 * Mirrors {@link AssetCatalog.hasProxy} but operates on the flat
 * snapshot shape so callers (notably `planning.ts`) don't need to keep a
 * reference to the live `AssetCatalog` instance.
 */
export function snapshotHasProxy(
  snapshot: AssetCatalogSnapshot,
  entityId: string,
  kind: ProxyKind,
): boolean {
  return snapshot.byEntity.get(entityId)?.kinds.has(kind) ?? false;
}
