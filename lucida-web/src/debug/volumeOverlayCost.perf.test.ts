/**
 * The volume overlay's cost contract: a surface that draws while a run is
 * open must not show up in the run it draws. It polls ten times a
 * second, never per frame, and does no work while hidden. This file times one
 * poll at the 600-cell cap: projection, draw list, and edges, silhouette, and
 * stroke batched by style, plus the pointer hit test. The camera is a
 * JavaScript pinhole, since the runner has no scene.
 *
 * The design gives a poll 4 ms at the cap (4% of the main thread at ten polls
 * a second) and the hit test 0.2 ms, since pointer moves arrive far more often
 * than polls. Each line logs where the figure stands against that ceiling.
 * What fails the test is a budget at about twice the typical figure, held on
 * any host the way `perfBudget.ts` describes. The hit test is held against a
 * walk over the same silhouettes instead of the generic reference: hosts
 * differ more in what that walk costs than in what the reference does.
 */

import { describe, expect, it } from "vitest";

import { describeTiming, expectWithinBudget, timeAgainstBaseline, timeStep } from "../test/perfBudget.ts";

import type { ChunkReading } from "../trace/diagnose/chunkStates.ts";
import type { RowState } from "../trace/diagnose/types.ts";
import { type ChunkCell, type OverlayModes, type ScreenPoint } from "./overlayDrawList.ts";
import { OVERLAY_TEST_COLORS } from "./overlayFixtures.ts";
import { BOX_EDGES, buildVolumeDrawList, hitTestBox, projectChunkBox, type Projector } from "./volumeWireframe.ts";

/** The overlay's MAX_CHUNK_RECTS. */
const BOXES_PER_POLL = 600;
const POLL_CEILING_US = 4_000;
const HIT_TEST_CEILING_US = 200;
/** In nominal microseconds, about twice the typical figure. */
const POLL_BUDGET_US = 4_900;
/** Ten hit tests against a walk of every silhouette's edges at the same ten points: about twice the typical ratio. */
const HIT_TEST_RATIO_BUDGET = 2.1;

const MODES: OverlayModes = { chunkTier: false, cachedTier: false, plannedRank: false, phaseColor: true, churnTint: true };
const STATES: RowState[] = ["plan", "queue", "wire", "decode", "upload", "present", "complete", "retired", "unstamped"];

/** 10 × 10 × 6 unit boxes, the cap, through a camera turned so no silhouette is a rectangle. */
const GRID = { x: 10, y: 10, z: 6 } as const;

function camera(): Projector {
  const yaw = 0.6;
  const pitch = 0.35;
  const distance = 30;
  const focal = 900;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return (vx, vy, vz) => {
    const x0 = vx - GRID.x / 2;
    const y0 = vy - GRID.y / 2;
    const z0 = vz - GRID.z / 2;
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const y2 = y0 * cp - z1 * sp;
    const z2 = y0 * sp + z1 * cp + distance;
    if (z2 <= 0) return null;
    return [720 + (focal * x1) / z2, 450 + (focal * y2) / z2];
  };
}

interface BoxSpec {
  min: [number, number, number];
  max: [number, number, number];
  identity: Omit<ChunkCell, "left" | "top" | "width" | "height" | "corners" | "depth">;
}

function boxes(): BoxSpec[] {
  const out: BoxSpec[] = [];
  let i = 0;
  for (let z = 0; z < GRID.z; z++) {
    for (let y = 0; y < GRID.y; y++) {
      for (let x = 0; x < GRID.x; x++, i++) {
        const chunkKey = `1/0/0/${z}/${y}/${x}`;
        out.push({
          min: [x, y, z],
          max: [x + 1, y + 1, z + 1],
          identity: {
            key: `ds/m-${i % 4}/detail/${chunkKey}`,
            datasetId: "ds",
            entityId: `m-${i % 4}`,
            chunkKey,
            level: 1,
            t: 0,
            c: 0,
            z,
            y,
            x,
            status: i % 3 === 0 ? "cached" : i % 3 === 1 ? "in-flight" : "planned",
            sourceTier: i % 2 === 0 ? "detail" : "coarse",
          },
        });
      }
    }
  }
  return out;
}

/** A reading per cell, in constant time, as the recorder's identity index answers one. */
function readings(specs: BoxSpec[]): Map<string, ChunkReading> {
  const out = new Map<string, ChunkReading>();
  specs.forEach((spec, i) => {
    if (i % 5 === 4) return;
    out.set(spec.identity.key, { state: STATES[i % STATES.length], rows: 1 + (i % 4), fetches: i % 4, ageMs: i * 3 });
  });
  return out;
}

/**
 * Every edge of every silhouette at one point, the arithmetic a hit test does
 * on each edge it reaches, with none of its decisions or early exits.
 */
function walkHulls(hulls: readonly (readonly ScreenPoint[])[], x: number, y: number): number {
  let acc = 0;
  for (const hull of hulls) {
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % n];
      acc += (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) > 0 ? 1 : 0;
    }
  }
  return acc;
}

function poll(specs: BoxSpec[], project: Projector, byKey: Map<string, ChunkReading>) {
  const cells: ChunkCell[] = [];
  for (const spec of specs) {
    const box = projectChunkBox(project, spec.min, spec.max);
    if (!box) continue;
    const center = [(spec.min[0] + spec.max[0]) / 2, (spec.min[1] + spec.max[1]) / 2, (spec.min[2] + spec.max[2]) / 2];
    cells.push({
      ...spec.identity,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      corners: box.corners,
      depth: center[0] ** 2 + center[1] ** 2 + (center[2] + 30) ** 2,
    });
  }
  return buildVolumeDrawList({ cells, colors: OVERLAY_TEST_COLORS, modes: MODES, readingOf: (cell) => byKey.get(cell.key) ?? null, windowMs: 12_000 });
}

describe("the volume overlay's cost contract", () => {
  it("projects, lists and strokes a poll's boxes, and hit-tests them, inside the budget", () => {
    const specs = boxes();
    expect(specs).toHaveLength(BOXES_PER_POLL);
    const project = camera();
    const byKey = readings(specs);

    let list = poll(specs, project, byKey);
    const polled = timeStep(() => {
      list = poll(specs, project, byKey);
    }, { samples: 41, warmup: 5 });

    let hits = 0;
    let walked = 0;
    const hulls = list.items.map((item) => item.hull);
    const hitTests = timeAgainstBaseline(
      () => {
        for (let k = 0; k < 10; k++) if (hitTestBox(list.items, 600 + k * 24, 400 + k * 10)) hits += 1;
      },
      () => {
        for (let k = 0; k < 10; k++) walked += walkHulls(hulls, 600 + k * 24, 400 + k * 10);
      },
      { samples: 41, warmup: 5 },
    );

    const segments = list.items.reduce((n, item) => n + item.path.split("M").length - 1, 0);

    console.log(
      `[#1063] volume overlay poll: ${list.items.length} boxes projected, listed and stroked | ` +
        `${describeTiming(polled, POLL_BUDGET_US)} | ceiling ${POLL_CEILING_US}µs | ${segments} edge segments in ` +
        `${list.batches.length} paths`,
    );
    console.log(
      `[#1063] volume overlay hit test x10: p50=${hitTests.stepUs.toFixed(1)}µs against a hull walk at ` +
        `${hitTests.baselineUs.toFixed(1)}µs | ratio ${hitTests.ratio.toFixed(2)}, budget ${HIT_TEST_RATIO_BUDGET} ` +
        `(${(hitTests.ratio / HIT_TEST_RATIO_BUDGET).toFixed(2)} of it) | ceiling ${HIT_TEST_CEILING_US}µs each`,
    );

    expect(list.items).toHaveLength(BOXES_PER_POLL);
    expect(segments).toBeLessThanOrEqual(BOXES_PER_POLL * BOX_EDGES.length);
    expect(list.batches.reduce((n, batch) => n + batch.count, 0)).toBe(BOXES_PER_POLL);
    expect(list.batches.length).toBeLessThan(40);
    expect(hits).toBeGreaterThan(0);
    expect(walked).toBeGreaterThan(0);
    expectWithinBudget("volume overlay poll", polled, POLL_BUDGET_US);
    expect(hitTests.ratio, `ten hit tests at ${hitTests.ratio.toFixed(2)}x a hull walk`).toBeLessThan(HIT_TEST_RATIO_BUDGET);
  });
});
