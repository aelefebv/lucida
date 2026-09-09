/**
 * The spatial summary: what is where, as counts and bounding boxes per state
 * and level. The text twin of the overlay, from the same rows, so an agent
 * reads the picture the overlay paints without a screenshot.
 *
 * Boxes are in chunk indices at each group's level, because that is what a
 * row records. The trace carries neither a chunk shape nor a level's shape,
 * so an extent in sample coordinates is not derivable from it, and the
 * summary says so rather than guessing one.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type { TraceRow, TraceRun } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { rowAgeUs, rowState, stateRank } from "./rowState.ts";
import type { RowState, SpatialBox, SpatialGroup, SpatialSummary } from "./types.ts";

/** The axes of a box, in the order a chunk key spells them after the level. */
export const SPATIAL_AXES = ["t", "c", "z", "y", "x"] as const;

const COORDINATES =
  `boxes are chunk indices [${SPATIAL_AXES.join(" ")}] at each group's level, inclusive; ` +
  "the trace records neither a chunk shape nor a level's shape, so extents in sample coordinates are not derivable from it";

const CANNOT_SHOW: readonly string[] = [
  "a chunk resident before the run opened and never touched since has no row here, so an absent region is unrecorded, not empty",
  "a chunk still queued at run close has no row either, because a row is born at dispatch, so the wanted set is wider than these boxes",
  "a chunk re-delivered from the CPU cache carries no second row, so residency restored without a fetch does not appear",
];

/** Detail before coarse, matching the tier index the row table stores. */
const TIER_ORDER: readonly ResidencyTier[] = ["detail", "coarse"];

interface MutableGroup {
  datasetId: string;
  residencyTier: ResidencyTier;
  level: number;
  state: RowState;
  n: number;
  entities: Set<string>;
  box: SpatialBox;
  oldestUs: number;
}

export function summariseSpace(run: TraceRun): SpatialSummary {
  const closeUs = run.header.durationUs;
  const groups = new Map<string, MutableGroup>();
  const levels = new Set<number>();

  for (const row of run.rows) {
    const state = rowState(row);
    levels.add(row.level);
    const key = JSON.stringify([row.datasetId, row.residencyTier, row.level, state]);
    const coordinates = coordinatesOf(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        datasetId: row.datasetId,
        residencyTier: row.residencyTier,
        level: row.level,
        state,
        n: 0,
        entities: new Set(),
        box: { min: [...coordinates], max: [...coordinates] },
        oldestUs: 0,
      };
      groups.set(key, group);
    }
    group.n += 1;
    group.entities.add(row.entityId);
    for (let axis = 0; axis < coordinates.length; axis += 1) {
      group.box.min[axis] = Math.min(group.box.min[axis], coordinates[axis]);
      group.box.max[axis] = Math.max(group.box.max[axis], coordinates[axis]);
    }
    group.oldestUs = Math.max(group.oldestUs, rowAgeUs(row, closeUs) ?? 0);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      stateRank(a.state) - stateRank(b.state) ||
      a.level - b.level ||
      a.datasetId.localeCompare(b.datasetId) ||
      TIER_ORDER.indexOf(a.residencyTier) - TIER_ORDER.indexOf(b.residencyTier),
  );

  return {
    rowCount: run.rows.length,
    groups: ordered.map(
      (group, index): SpatialGroup => ({
        id: index + 1,
        datasetId: group.datasetId,
        residencyTier: group.residencyTier,
        level: group.level,
        state: group.state,
        n: group.n,
        entityCount: group.entities.size,
        box: group.box,
        oldestMs: usToMs(group.oldestUs),
      }),
    ),
    groupCount: ordered.length,
    levelCount: levels.size,
    coordinates: COORDINATES,
    cannotShow: [...CANNOT_SHOW],
  };
}

function coordinatesOf(row: TraceRow): [number, number, number, number, number] {
  return [row.t, row.c, row.z, row.y, row.x];
}
