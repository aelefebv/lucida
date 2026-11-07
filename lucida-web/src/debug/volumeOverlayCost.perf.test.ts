/**
 * The volume overlay's cost contract: a surface that draws while a run is
 * open must not show up in the run it draws. It polls ten times a
 * second, never per frame, and does no work while hidden. This file times one
 * poll at the 600-cell cap: projection, draw list, and edges, silhouette, and
 * stroke batched by style, plus the pointer hit test. The camera is a
 * JavaScript pinhole, since the runner has no scene.
 *
 * The ceilings are tripwires at {@link CI_SLACK}× slack, not benchmarks: a
 * millisecond microbenchmark on CI measures the runner. A poll gets 4 ms at
 * the cap (4% of the main thread at ten polls a second); the hit test gets
 * 0.2 ms, since pointer moves arrive far more often than polls.
 */

import { describe, expect, it } from "vitest";

import type { ChunkReading } from "../trace/diagnose/chunkStates.ts";
import type { RowState } from "../trace/diagnose/types.ts";
import { type ChunkCell, type OverlayModes } from "./overlayDrawList.ts";
import { OVERLAY_TEST_COLORS } from "./overlayFixtures.ts";
import { BOX_EDGES, buildVolumeDrawList, hitTestBox, projectChunkBox, type Projector } from "./volumeWireframe.ts";

/** The overlay's MAX_CHUNK_RECTS. */
const BOXES_PER_POLL = 600;
const POLL_CEILING_US = 4_000;
const HIT_TEST_CEILING_US = 200;
/** The recorder's slack, for the recorder's reason: the same code measures 45× apart across hosts. */
const CI_SLACK = 16;

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

function median(samples: number[]): number {
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

describe("the volume overlay's cost contract", () => {
  it("projects, lists and strokes a poll's boxes, and hit-tests them, inside the budget", () => {
    const specs = boxes();
    expect(specs).toHaveLength(BOXES_PER_POLL);
    const project = camera();
    const byKey = readings(specs);

    for (let i = 0; i < 5; i++) poll(specs, project, byKey);

    const pollSamples: number[] = [];
    let list = poll(specs, project, byKey);
    for (let i = 0; i < 41; i++) {
      const start = performance.now();
      list = poll(specs, project, byKey);
      pollSamples.push((performance.now() - start) * 1_000);
    }

    const hitSamples: number[] = [];
    let hits = 0;
    for (let i = 0; i < 41; i++) {
      const start = performance.now();
      for (let k = 0; k < 10; k++) if (hitTestBox(list.items, 600 + k * 24, 400 + k * 10)) hits += 1;
      hitSamples.push(((performance.now() - start) * 1_000) / 10);
    }

    const pollUs = median(pollSamples);
    const hitUs = median(hitSamples);
    const segments = list.items.reduce((n, item) => n + item.path.split("M").length - 1, 0);

    console.log(
      `[#1063] volume overlay poll: ${list.items.length} boxes projected, listed and stroked p50=${pollUs.toFixed(0)}µs ` +
        `(ceiling ${POLL_CEILING_US}µs, gate ${POLL_CEILING_US * CI_SLACK}µs) | ${segments} edge segments in ` +
        `${list.batches.length} paths | ` +
        `hit test p50=${hitUs.toFixed(1)}µs (ceiling ${HIT_TEST_CEILING_US}µs, gate ${HIT_TEST_CEILING_US * CI_SLACK}µs)`,
    );

    expect(list.items).toHaveLength(BOXES_PER_POLL);
    expect(segments).toBeLessThanOrEqual(BOXES_PER_POLL * BOX_EDGES.length);
    expect(list.batches.reduce((n, batch) => n + batch.count, 0)).toBe(BOXES_PER_POLL);
    expect(list.batches.length).toBeLessThan(40);
    expect(hits).toBeGreaterThan(0);
    expect(pollUs).toBeLessThan(POLL_CEILING_US * CI_SLACK);
    expect(hitUs).toBeLessThan(HIT_TEST_CEILING_US * CI_SLACK);
  });
});
