/**
 * Tests for {@link validatePlanningInputs} and its nine internal check
 * helpers. Each helper gets at least one passing case and one violating
 * case; the composing function gets a fully-valid passing case and a
 * smoke test that violations propagate.
 *
 * PRD #578 / Slice 3 (ADR 0031): per-check coverage colocated with the
 * validator.
 */

import { describe, it, expect } from "vitest";
import type { LevelGeometry } from "../../manifestTypes.ts";
import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
} from "./synthetic.ts";
import type {
  AssetCatalogSnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  PlanningState,
} from "./types.ts";
import {
  checkAssetCatalogRefs,
  checkFieldParentRefs,
  checkLevelShapeArity,
  checkMinimapKeys,
  checkPrevActiveSetKindAgreement,
  checkPrevActiveSetUnique,
  checkUniqueEntityIds,
  checkUniqueImageIds,
  checkVisibleRegionBounds,
  validatePlanningInputs,
} from "./validate.ts";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Build a 5D LevelGeometry with the given shape + chunk_shape. */
function makeLevel(
  shape: [number, number, number, number, number],
  chunkShape: [number, number, number, number, number],
): LevelGeometry {
  return {
    level_index: 0,
    shape,
    chunk_shape: chunkShape,
    grid_shape: [1, 1, 1, 1, 1],
    scale: [1, 1, 1, 1, 1],
  };
}

/**
 * Build a minimal valid snapshot with one well + one field. Shared
 * baseline for the per-check tests; each test mutates the result to
 * inject the specific violation it wants to assert.
 */
function makeValidSnapshot(): PlanningSnapshot {
  const well = createSyntheticEntity({
    entityId: "well-A",
    imageId: "img-well-A",
    kind: "Well",
    levels: [makeLevel([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])],
  });
  const field = createSyntheticEntity({
    entityId: "field-A1",
    imageId: "img-field-A1",
    kind: "Field",
    parentId: "well-A",
    levels: [makeLevel([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])],
  });
  return createSyntheticSnapshot({ entities: [well, field] });
}

// ===========================================================================
// Check 1 — checkFieldParentRefs
// ===========================================================================

describe("checkFieldParentRefs", () => {
  it("passes when every field's parentId resolves to a Well in entities", () => {
    expect(() => checkFieldParentRefs(makeValidSnapshot())).not.toThrow();
  });

  it("passes when a field's parentId is absent from entities (parent invisible / not in this tick)", () => {
    // Production reality: WASM's view_query may surface a visible field
    // whose parent well is not in the snapshot. The planner's
    // groupByWell handles this gracefully; the validator must not flag it.
    const snap = makeValidSnapshot();
    snap.entities = snap.entities.filter((e) => e.kind !== "Well");
    expect(() => checkFieldParentRefs(snap)).not.toThrow();
  });

  it("throws when a field's parentId resolves to a non-Well entity in entities", () => {
    const snap = makeValidSnapshot();
    // Replace the Well with an Image carrying the same id.
    const wellIdx = snap.entities.findIndex((e) => e.kind === "Well");
    const replacement = createSyntheticEntity({
      entityId: "well-A",
      imageId: "img-well-A",
      kind: "Image",
    });
    snap.entities[wellIdx] = replacement;
    expect(() => checkFieldParentRefs(snap)).toThrow(
      /parentId references non-Well entity/,
    );
  });
});

// ===========================================================================
// Check 2 — checkUniqueEntityIds
// ===========================================================================

describe("checkUniqueEntityIds", () => {
  it("passes when every entityId is unique", () => {
    expect(() => checkUniqueEntityIds(makeValidSnapshot())).not.toThrow();
  });

  it("throws on duplicate entityId", () => {
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({
        entityId: "well-A", // duplicate
        imageId: "img-dup",
        kind: "Image",
      }),
    );
    expect(() => checkUniqueEntityIds(snap)).toThrow(
      /duplicate entityId well-A/,
    );
  });
});

// ===========================================================================
// Check 3 — checkUniqueImageIds
// ===========================================================================

describe("checkUniqueImageIds", () => {
  it("passes when every non-empty imageId is unique", () => {
    expect(() => checkUniqueImageIds(makeValidSnapshot())).not.toThrow();
  });

  it("passes when multiple wells share the conventional empty imageId", () => {
    // Wells use imageId === "" as the placeholder for "this entity has
    // no image to key against". Multi-well plates legitimately carry
    // multiple wells with imageId === "".
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({ entityId: "well-B", imageId: "", kind: "Well" }),
      createSyntheticEntity({ entityId: "well-C", imageId: "", kind: "Well" }),
    );
    // Wipe well-A's image id too so all three wells share "".
    const wellA = snap.entities.find((e) => e.entityId === "well-A");
    if (wellA) wellA.imageId = "";
    expect(() => checkUniqueImageIds(snap)).not.toThrow();
  });

  it("throws on duplicate non-empty imageId", () => {
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({
        entityId: "well-B",
        imageId: "img-well-A", // duplicate of well-A's
        kind: "Well",
      }),
    );
    expect(() => checkUniqueImageIds(snap)).toThrow(
      /duplicate imageId img-well-A/,
    );
  });
});

// ===========================================================================
// Check 4 — checkLevelShapeArity
// ===========================================================================

describe("checkLevelShapeArity", () => {
  it("passes when every level has 5D shape and chunk_shape", () => {
    expect(() => checkLevelShapeArity(makeValidSnapshot())).not.toThrow();
  });

  it("throws when a level's shape is not 5D", () => {
    const snap = makeValidSnapshot();
    snap.entities[0].levels[0] = {
      ...snap.entities[0].levels[0],
      shape: [1, 1, 1, 1] as unknown as number[], // 4D — wrong
    };
    expect(() => checkLevelShapeArity(snap)).toThrow(
      /shape\.length=4, expected 5/,
    );
  });

  it("throws when a level's chunk_shape is not 5D", () => {
    const snap = makeValidSnapshot();
    snap.entities[0].levels[0] = {
      ...snap.entities[0].levels[0],
      chunk_shape: [1, 1, 1, 1, 1, 1] as unknown as number[], // 6D — wrong
    };
    expect(() => checkLevelShapeArity(snap)).toThrow(
      /chunk_shape\.length=6, expected 5/,
    );
  });

  it("passes when an entity has empty levels", () => {
    const snap = makeValidSnapshot();
    snap.entities[0].levels = [];
    expect(() => checkLevelShapeArity(snap)).not.toThrow();
  });
});

// ===========================================================================
// Check 5 — checkVisibleRegionBounds
// ===========================================================================

describe("checkVisibleRegionBounds", () => {
  it("passes when xyBoundsVox is a valid bbox and zRangeVox is ordered", () => {
    expect(() => checkVisibleRegionBounds(makeValidSnapshot())).not.toThrow();
  });

  it("passes when xMin equals xMax (zero-width but non-degenerate)", () => {
    const snap = makeValidSnapshot();
    snap.visibleRegion.xyBoundsVox = [10, 0, 10, 100];
    expect(() => checkVisibleRegionBounds(snap)).not.toThrow();
  });

  it("throws when xMin > xMax in xyBoundsVox", () => {
    const snap = makeValidSnapshot();
    snap.visibleRegion.xyBoundsVox = [100, 0, 50, 100];
    expect(() => checkVisibleRegionBounds(snap)).toThrow(
      /xMin .* > xMax/,
    );
  });

  it("throws when yMin > yMax in xyBoundsVox", () => {
    const snap = makeValidSnapshot();
    snap.visibleRegion.xyBoundsVox = [0, 100, 100, 50];
    expect(() => checkVisibleRegionBounds(snap)).toThrow(
      /yMin .* > yMax/,
    );
  });

  it("throws when zRangeVox start > end", () => {
    const snap = makeValidSnapshot();
    snap.visibleRegion.zRangeVox = [10, 5];
    expect(() => checkVisibleRegionBounds(snap)).toThrow(
      /zRangeVox has start/,
    );
  });
});

// ===========================================================================
// Check 6 — checkAssetCatalogRefs
// ===========================================================================

describe("checkAssetCatalogRefs", () => {
  it("passes when assetCatalog is null (opt-out)", () => {
    const snap = makeValidSnapshot();
    snap.assetCatalog = null;
    expect(() => checkAssetCatalogRefs(snap)).not.toThrow();
  });

  it("passes when every catalog entry references a known entity", () => {
    const snap = makeValidSnapshot();
    const catalog: AssetCatalogSnapshot = {
      byEntity: new Map([
        ["well-A", { kinds: new Set(["WellProxy3D"]) }],
        ["field-A1", { kinds: new Set(["FieldProxy3D"]) }],
      ]),
    };
    snap.assetCatalog = catalog;
    expect(() => checkAssetCatalogRefs(snap)).not.toThrow();
  });

  it("throws when the catalog references an unknown entityId", () => {
    const snap = makeValidSnapshot();
    const catalog: AssetCatalogSnapshot = {
      byEntity: new Map([["ghost-entity", { kinds: new Set(["WellProxy3D"]) }]]),
    };
    snap.assetCatalog = catalog;
    expect(() => checkAssetCatalogRefs(snap)).toThrow(
      /assetCatalog references unknown entityId ghost-entity/,
    );
  });
});

// ===========================================================================
// Check 7 — checkMinimapKeys
// ===========================================================================

describe("checkMinimapKeys", () => {
  it("passes when minimapPending is empty", () => {
    expect(() => checkMinimapKeys(makeValidSnapshot())).not.toThrow();
  });

  it("passes when every key matches a known imageId", () => {
    const snap = makeValidSnapshot();
    const coord: MinimapChunkCoord = {
      level: 0, x: 0, y: 0, z: 0, t: 0, c: 0, key: "0/0/0/0/0/0",
    };
    snap.minimapPending = new Map([["img-field-A1", [coord]]]);
    expect(() => checkMinimapKeys(snap)).not.toThrow();
  });

  it("throws when a minimapPending key is not a known imageId", () => {
    const snap = makeValidSnapshot();
    const coord: MinimapChunkCoord = {
      level: 0, x: 0, y: 0, z: 0, t: 0, c: 0, key: "0/0/0/0/0/0",
    };
    snap.minimapPending = new Map([["img-ghost", [coord]]]);
    expect(() => checkMinimapKeys(snap)).toThrow(
      /minimapPending key img-ghost is not a known imageId/,
    );
  });
});

// ===========================================================================
// Check 8 — checkPrevActiveSetUnique
// ===========================================================================

describe("checkPrevActiveSetUnique", () => {
  it("passes when previousActiveSet is empty", () => {
    expect(() => checkPrevActiveSetUnique(createSyntheticState())).not.toThrow();
  });

  it("passes when every entry has a unique entityId", () => {
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "well-as-proxy", entityId: "well-A" },
        { kind: "well-as-proxy", entityId: "well-B" },
      ],
    };
    expect(() => checkPrevActiveSetUnique(state)).not.toThrow();
  });

  it("throws on duplicate entityId in previousActiveSet", () => {
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "well-as-proxy", entityId: "well-A" },
        { kind: "well-as-proxy", entityId: "well-A" }, // duplicate
      ],
    };
    expect(() => checkPrevActiveSetUnique(state)).toThrow(
      /duplicate entityId well-A in state\.previousActiveSet/,
    );
  });
});

// ===========================================================================
// Check 9 — checkPrevActiveSetKindAgreement
// ===========================================================================

describe("checkPrevActiveSetKindAgreement", () => {
  it("passes when entry kinds agree with entity kinds", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "well-as-proxy", entityId: "well-A" },
        {
          kind: "field",
          entityId: "field-A1",
          imageId: "img-field-A1",
          mode: "fields-with-detail",
          targetLod: 0,
          coarsestDetailLod: 0,
          detailOwnedLodRange: [0, 0],
          proxyAvailable: false,
          wellProxyAvailable: false,
        },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("passes when an invisible entry covers any entity kind (permissive)", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // Well that's now invisible — invisible permits any entity kind.
        { kind: "invisible", entityId: "well-A", imageId: "img-well-A", coarsestLod: 0 },
        // Field that's now invisible — same story.
        { kind: "invisible", entityId: "field-A1", imageId: "img-field-A1", coarsestLod: 0 },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("passes (no violation) when an entry's entityId disappears from snapshot", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // entityId not present in snapshot — disappeared, NOT a violation.
        { kind: "well-as-proxy", entityId: "well-gone-last-tick" },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("throws when a well-as-proxy entry references a non-Well entity", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // field-A1 is a Field but the entry says it was a well-as-proxy.
        { kind: "well-as-proxy", entityId: "field-A1" },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).toThrow(
      /disagrees with entity kind Field \(expected Well\)/,
    );
  });

  it("throws when a field entry references a non-Field entity", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        {
          kind: "field",
          entityId: "well-A", // Well, not Field
          imageId: "img-well-A",
          mode: "fields-with-detail",
          targetLod: 0,
          coarsestDetailLod: 0,
          detailOwnedLodRange: [0, 0],
          proxyAvailable: false,
          wellProxyAvailable: false,
        },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).toThrow(
      /disagrees with entity kind Well \(expected Field\)/,
    );
  });
});

// ===========================================================================
// Composing validatePlanningInputs
// ===========================================================================

describe("validatePlanningInputs (composing)", () => {
  it("passes when the snapshot and state are fully valid", () => {
    expect(() =>
      validatePlanningInputs(makeValidSnapshot(), createSyntheticState()),
    ).not.toThrow();
  });

  it("propagates a violation from any single check (smoke)", () => {
    // Use a check 3 violation (duplicate imageId) to demonstrate
    // propagation through the composing function.
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({
        entityId: "well-B",
        imageId: "img-well-A", // duplicate of well-A's
        kind: "Well",
      }),
    );
    expect(() => validatePlanningInputs(snap, createSyntheticState())).toThrow(
      /duplicate imageId/,
    );
  });

  it("propagates a state-side violation (smoke)", () => {
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "well-as-proxy", entityId: "well-X" },
        { kind: "well-as-proxy", entityId: "well-X" },
      ],
    };
    expect(() => validatePlanningInputs(makeValidSnapshot(), state)).toThrow(
      /duplicate entityId well-X in state\.previousActiveSet/,
    );
  });
});

