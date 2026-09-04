import { describe, expect, it } from "vitest";
import { sameDatasetLevels, summarizeDatasetLevels } from "./datasetLevels.ts";
import type { EntityLevelReport } from "../renderer/workerProtocol.ts";

function entity(
  overrides: Partial<EntityLevelReport> & { targetLevel: number },
): EntityLevelReport {
  return {
    entityId: overrides.entityId ?? `e${overrides.targetLevel}`,
    visible: true,
    displayed: null,
    ...overrides,
  };
}

describe("summarizeDatasetLevels", () => {
  it("returns null for a dataset with no image entities", () => {
    expect(summarizeDatasetLevels([])).toBeNull();
  });

  it("reads a single entity showing its target as one level with no notice", () => {
    expect(summarizeDatasetLevels([
      entity({ targetLevel: 2, displayed: { min: 2, max: 2 } }),
    ])).toEqual({
      target: { min: 2, max: 2 },
      displayed: { min: 2, max: 2 },
      coarserThanTarget: false,
    });
  });

  it("flags a displayed level coarser than the target", () => {
    expect(summarizeDatasetLevels([
      entity({ targetLevel: 1, displayed: { min: 1, max: 3 } }),
    ])).toEqual({
      target: { min: 1, max: 1 },
      displayed: { min: 1, max: 3 },
      coarserThanTarget: true,
    });
  });

  it("leaves displayed null while nothing is on screen yet", () => {
    expect(summarizeDatasetLevels([entity({ targetLevel: 0 })])).toEqual({
      target: { min: 0, max: 0 },
      displayed: null,
      coarserThanTarget: false,
    });
  });

  it("ranges the target and displayed levels across the visible entities of a collection", () => {
    expect(summarizeDatasetLevels([
      entity({ entityId: "a", targetLevel: 1, displayed: { min: 1, max: 1 } }),
      entity({ entityId: "b", targetLevel: 3, displayed: { min: 3, max: 3 } }),
      entity({ entityId: "c", targetLevel: 2 }),
    ])).toEqual({
      target: { min: 1, max: 3 },
      displayed: { min: 1, max: 3 },
      coarserThanTarget: false,
    });
  });

  it("compares each entity against its own target, not against the range", () => {
    // a displays 3 for a target of 1; b displays its target of 3. The ranges
    // alone (target 1..3, displayed 3..3) hide that a lags.
    expect(summarizeDatasetLevels([
      entity({ entityId: "a", targetLevel: 1, displayed: { min: 3, max: 3 } }),
      entity({ entityId: "b", targetLevel: 3, displayed: { min: 3, max: 3 } }),
    ])?.coarserThanTarget).toBe(true);
  });

  it("scopes the readout to visible entities, falling back to all when none is visible", () => {
    const offScreen = entity({ entityId: "off", targetLevel: 4, visible: false });
    expect(summarizeDatasetLevels([
      entity({ entityId: "on", targetLevel: 1, displayed: { min: 1, max: 1 } }),
      offScreen,
    ])).toEqual({
      target: { min: 1, max: 1 },
      displayed: { min: 1, max: 1 },
      coarserThanTarget: false,
    });
    expect(summarizeDatasetLevels([offScreen])).toEqual({
      target: { min: 4, max: 4 },
      displayed: null,
      coarserThanTarget: false,
    });
  });
});

describe("sameDatasetLevels", () => {
  const base = summarizeDatasetLevels([
    entity({ targetLevel: 1, displayed: { min: 1, max: 2 } }),
  ]);

  it("treats structurally equal readouts as the same", () => {
    const again = summarizeDatasetLevels([
      entity({ targetLevel: 1, displayed: { min: 1, max: 2 } }),
    ]);
    expect(sameDatasetLevels(base, again)).toBe(true);
    expect(sameDatasetLevels(null, null)).toBe(true);
  });

  it("tells apart a change in any field", () => {
    expect(sameDatasetLevels(base, null)).toBe(false);
    expect(sameDatasetLevels(base, { ...base!, target: { min: 0, max: 1 } })).toBe(false);
    expect(sameDatasetLevels(base, { ...base!, displayed: null })).toBe(false);
    expect(sameDatasetLevels(base, { ...base!, coarserThanTarget: false })).toBe(false);
  });
});
