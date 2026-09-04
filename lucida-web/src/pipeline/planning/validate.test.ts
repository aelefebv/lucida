/**
 * Tests for {@link validatePlanningInputs} and its nine internal check
 * helpers. Each helper gets at least one passing case and one violating
 * case; the composing function gets a fully-valid passing case and a
 * smoke test that violations propagate.
 *
 * Per ADR 0031, per-check coverage is colocated with the validator.
 */

import { describe, it, expect } from "vitest";
import type { LevelGeometry } from "../../manifestTypes.ts";
import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
} from "./synthetic.ts";
import type {
  PlanningSnapshot,
  PlanningState,
} from "./types.ts";
import {
  checkTileParentRefs,
  checkLevelShapeArity,
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
 * Build a minimal valid snapshot with one group + one tile. Shared
 * baseline for the per-check tests; each test mutates the result to
 * inject the specific violation it wants to assert.
 */
function makeValidSnapshot(): PlanningSnapshot {
  const group = createSyntheticEntity({
    entityId: "group-A",
    imageId: "img-group-A",
    kind: "Group",
    levels: [makeLevel([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])],
  });
  const tile = createSyntheticEntity({
    entityId: "tile-A1",
    imageId: "img-tile-A1",
    kind: "Tile",
    parentId: "group-A",
    levels: [makeLevel([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])],
  });
  return createSyntheticSnapshot({ entities: [group, tile] });
}

// ===========================================================================
// Check 1 — checkTileParentRefs
// ===========================================================================

describe("checkTileParentRefs", () => {
  it("passes when every tile's parentId resolves to a Group in entities", () => {
    expect(() => checkTileParentRefs(makeValidSnapshot())).not.toThrow();
  });

  it("passes when a tile's parentId is absent from entities (parent invisible / not in this tick)", () => {
    // Production reality: WASM's view_query may surface a visible tile
    // whose parent group is not in the snapshot. The planner's
    // groupMembers handles this gracefully; the validator must not flag it.
    const snap = makeValidSnapshot();
    snap.entities = snap.entities.filter((e) => e.kind !== "Group");
    expect(() => checkTileParentRefs(snap)).not.toThrow();
  });

  it("throws when a tile's parentId resolves to a non-Group entity in entities", () => {
    const snap = makeValidSnapshot();
    // Replace the Group with an Image carrying the same id.
    const groupIdx = snap.entities.findIndex((e) => e.kind === "Group");
    const replacement = createSyntheticEntity({
      entityId: "group-A",
      imageId: "img-group-A",
      kind: "Image",
    });
    snap.entities[groupIdx] = replacement;
    expect(() => checkTileParentRefs(snap)).toThrow(
      /parentId references non-Group entity/,
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
        entityId: "group-A", // duplicate
        imageId: "img-dup",
        kind: "Image",
      }),
    );
    expect(() => checkUniqueEntityIds(snap)).toThrow(
      /duplicate entityId group-A/,
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

  it("passes when multiple groups share the conventional empty imageId", () => {
    // Groups use imageId === "" as the placeholder for "this entity has
    // no image to key against". Multi-group collections legitimately carry
    // multiple groups with imageId === "".
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({ entityId: "group-B", imageId: "", kind: "Group" }),
      createSyntheticEntity({ entityId: "group-C", imageId: "", kind: "Group" }),
    );
    // Wipe group-A's image id too so all three groups share "".
    const groupA = snap.entities.find((e) => e.entityId === "group-A");
    if (groupA) groupA.imageId = "";
    expect(() => checkUniqueImageIds(snap)).not.toThrow();
  });

  it("throws on duplicate non-empty imageId", () => {
    const snap = makeValidSnapshot();
    snap.entities.push(
      createSyntheticEntity({
        entityId: "group-B",
        imageId: "img-group-A", // duplicate of group-A's
        kind: "Group",
      }),
    );
    expect(() => checkUniqueImageIds(snap)).toThrow(
      /duplicate imageId img-group-A/,
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
// Check 6 — withdrawn (assetCatalog refs)
// ===========================================================================
//
// The original "every assetCatalog key must be a known entityId" check
// was withdrawn. The catalog is flattened across all datasets the
// catalog has ever seen; the snapshot is for one dataset's current
// tick. They legitimately diverge. See validate.ts for the full
// rationale.

// ===========================================================================
// Check 7 — withdrawn (minimapPending keys)
// ===========================================================================
//
// The original "every minimapPending key must be a known imageId" check
// was withdrawn during the post-ship audit. minimapPath populates
// pendingFetch by iterating ALL dataset_images() (every image whose
// minimap chunks haven't been fully uploaded), keyed by image_id.
// snapshot.entities is view_query (only currently-visible entities).
// The two routinely diverge — minimap pending coords for off-screen
// images are legitimate. See validate.ts for the full rationale.

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
        { kind: "group-as-proxy", entityId: "group-A" },
        { kind: "group-as-proxy", entityId: "group-B" },
      ],
    };
    expect(() => checkPrevActiveSetUnique(state)).not.toThrow();
  });

  it("throws on duplicate entityId in previousActiveSet", () => {
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "group-as-proxy", entityId: "group-A" },
        { kind: "group-as-proxy", entityId: "group-A" }, // duplicate
      ],
    };
    expect(() => checkPrevActiveSetUnique(state)).toThrow(
      /duplicate entityId group-A in state\.previousActiveSet/,
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
        { kind: "group-as-proxy", entityId: "group-A" },
        {
          kind: "tile",
          entityId: "tile-A1",
          imageId: "img-tile-A1",
          mode: "tiles-with-detail",
          detailLevels: [0],
          coarseLevel: null,
          proxyAvailable: false,
          groupProxyAvailable: false,
        },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("passes when an invisible entry covers any entity kind (permissive)", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // Group that's now invisible — invisible permits any entity kind.
        { kind: "invisible", entityId: "group-A", imageId: "img-group-A", coarsestLod: 0 },
        // Tile that's now invisible — same story.
        { kind: "invisible", entityId: "tile-A1", imageId: "img-tile-A1", coarsestLod: 0 },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("passes (no violation) when an entry's entityId disappears from snapshot", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // entityId not present in snapshot — disappeared, NOT a violation.
        { kind: "group-as-proxy", entityId: "group-gone-last-tick" },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
  });

  it("throws when a group-as-proxy entry references a non-Group entity", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        // tile-A1 is a Tile but the entry says it was a group-as-proxy.
        { kind: "group-as-proxy", entityId: "tile-A1" },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).toThrow(
      /disagrees with entity kind Tile \(expected Group\)/,
    );
  });

  it("throws when a tile entry references a Group entity (only Tile/Image allowed)", () => {
    const snap = makeValidSnapshot();
    const state: PlanningState = {
      previousActiveSet: [
        {
          kind: "tile",
          entityId: "group-A", // Group, not Tile/Image
          imageId: "img-group-A",
          mode: "tiles-with-detail",
          detailLevels: [0],
          coarseLevel: null,
          proxyAvailable: false,
          groupProxyAvailable: false,
        },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).toThrow(
      /disagrees with entity kind Group \(expected Tile or Image\)/,
    );
  });

  it("passes when a tile entry references an Image entity (singleton case)", () => {
    // Image entities are treated as singleton "groups with one tile" by
    // groupMembers — the active-set entry is a TileEntry even though the
    // entity is an ImageSnapshot. See activeSet.ts::groupMembers.
    const snap = createSyntheticSnapshot({
      datasetId: "ds-singleton",
      entities: [
        createSyntheticEntity({
          entityId: "img-only",
          kind: "Image",
          imageId: "img-only-image",
        }),
      ],
    });
    const state: PlanningState = {
      previousActiveSet: [
        {
          kind: "tile",
          entityId: "img-only",
          imageId: "img-only-image",
          mode: "tiles-with-detail",
          detailLevels: [0],
          coarseLevel: null,
          proxyAvailable: false,
          groupProxyAvailable: false,
        },
      ],
    };
    expect(() => checkPrevActiveSetKindAgreement(snap, state)).not.toThrow();
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
        entityId: "group-B",
        imageId: "img-group-A", // duplicate of group-A's
        kind: "Group",
      }),
    );
    expect(() => validatePlanningInputs(snap, createSyntheticState())).toThrow(
      /duplicate imageId/,
    );
  });

  it("propagates a state-side violation (smoke)", () => {
    const state: PlanningState = {
      previousActiveSet: [
        { kind: "group-as-proxy", entityId: "group-X" },
        { kind: "group-as-proxy", entityId: "group-X" },
      ],
    };
    expect(() => validatePlanningInputs(makeValidSnapshot(), state)).toThrow(
      /duplicate entityId group-X in state\.previousActiveSet/,
    );
  });
});

