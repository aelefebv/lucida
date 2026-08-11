/**
 * The rollup's two placement fields: where a phase sat on the run's clock, and
 * which row was its worst.
 *
 * Both exist for the monitor page (#936). A timeline track cannot be drawn
 * from a percentile, and a drill-down that carries "the worst row" has to be handed a
 * row identity rather than a time coordinate — and every number a surface
 * prints has to exist in the document, so neither is computed in a component.
 */

import { describe, expect, it } from "vitest";
import { rollupPhases } from "./phaseRollup.ts";
import {
  coldRemoteOpen,
  healthyLocalOpen,
  makeMetadataRow,
  makeRow,
  makeRun,
  makeServerRow,
} from "./fixtures.ts";
import type { PhaseRollup } from "./types.ts";

const MS = 1_000;

function phase(phases: PhaseRollup[], id: string): PhaseRollup {
  const found = phases.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} in [${phases.map((p) => p.id).join(", ")}]`);
  return found;
}

describe("phase extents", () => {
  it("spans a browser phase from its first row's start to its last row's end", () => {
    const run = makeRun({
      header: { durationUs: 1_000 * MS },
      rows: [
        makeRow({ startUs: 100 * MS, durations: { plan: 5 * MS, wire: 20 * MS } }, 0),
        makeRow({ startUs: 400 * MS, durations: { plan: 5 * MS, wire: 60 * MS } }, 1),
      ],
    });

    const wire = phase(rollupPhases(run), "browser.wire");
    expect(wire.extent).toEqual({ firstStartMs: 105, lastEndMs: 465, positionedN: 2 });
  });

  it("places a metadata read inside the open it belongs to", () => {
    // The cold open's whole point: 3.7 s of reads before the first chunk row
    // exists. A track drawn from these has to start at the open, not at zero and
    // not at the first chunk.
    const reads = phase(rollupPhases(coldRemoteOpen()), "metadata.backend-read");
    expect(reads.extent).not.toBeNull();
    expect(reads.extent!.firstStartMs).toBe(28);
    expect(reads.extent!.lastEndMs).toBe(3_514);
    expect(reads.extent!.positionedN).toBe(340);
  });

  it("rolls the dataset open up as its own family, so a warm re-open is not silent", () => {
    // Every read inside a warm open quantises to zero against the clock floor
    // and drops out. Without the bracket the band draws nothing over the very
    // stretch the critical path blames.
    const run = makeRun({
      header: { durationUs: 5_000 * MS },
      datasetOpens: [{ requestId: "open-1", startUs: 40 * MS, endUs: 4_300 * MS }],
      serverRows: [makeMetadataRow("open-1", 1 * MS, 0, "cache-hit")],
    });

    const phases = rollupPhases(run);
    expect(phases.find((candidate) => candidate.id === "metadata.cache-hit")).toBeUndefined();
    const open = phase(phases, "metadata.dataset-open");
    expect(open.side).toBe("metadata");
    expect(open.extent).toEqual({ firstStartMs: 40, lastEndMs: 4_300, positionedN: 1 });
    expect(open.worst).toEqual({ label: "open-1", ms: 4_260 });
  });

  it("charges an open that never settled to the run's end and says so", () => {
    const run = makeRun({
      header: { durationUs: 2_000 * MS },
      datasetOpens: [{ requestId: "open-1", startUs: 100 * MS, endUs: null }],
    });

    const open = phase(rollupPhases(run), "metadata.dataset-open");
    expect(open.extent!.lastEndMs).toBe(2_000);
    expect(open.worst!.label).toContain("never settled");
  });

  it("leaves a metadata read unpositioned when its open was never bracketed", () => {
    const run = makeRun({
      header: { durationUs: 500 * MS },
      serverRows: [makeMetadataRow("open-unbracketed", 10 * MS, 30 * MS)],
    });

    expect(phase(rollupPhases(run), "metadata.backend-read").extent).toBeNull();
  });

  it("places a server phase inside the browser bracket the row was placed in", () => {
    // A server row carries no per-phase clock this side can trust (ADR 0050);
    // the bracket it was nested into is the only position it has.
    const run = makeRun({
      header: { durationUs: 800 * MS },
      serverRows: [
        makeServerRow({
          rid: 1,
          phases: { "permit-wait": 40 * MS },
          placement: { startUs: 200 * MS, endUs: 260 * MS, gapUs: 20 * MS, overshootUs: 0 },
        }),
      ],
    });

    expect(phase(rollupPhases(run), "server.permit-wait").extent).toEqual({
      firstStartMs: 200,
      lastEndMs: 260,
      positionedN: 1,
    });
  });

  it("reports no extent for a phase whose rows could not be placed", () => {
    const chunkWork = phase(rollupPhases(coldRemoteOpen()), "server.backend-read");
    expect(chunkWork.n).toBe(60);
    expect(chunkWork.extent).toBeNull();
  });
});

describe("the worst row", () => {
  it("names the chunk behind a browser phase's maximum", () => {
    const wire = phase(rollupPhases(healthyLocalOpen()), "browser.wire");
    expect(wire.maxMs).toBe(240);
    // The one member whose chunk answers slowly, and the row the open finishes
    // on: a drill-down says which chunk, not when.
    expect(wire.worst).toEqual({ label: "1/0/0/0/119/0", ms: 240 });
  });

  it("names a server row by the join key rather than by a chunk it never saw", () => {
    const run = makeRun({
      header: { durationUs: 800 * MS },
      serverRows: [
        makeServerRow({ rid: 7, connectionGeneration: 2, phases: { "backend-read": 90 * MS } }),
        makeServerRow({ rid: 8, connectionGeneration: 2, phases: { "backend-read": 10 * MS } }),
      ],
    });

    expect(phase(rollupPhases(run), "server.backend-read").worst).toEqual({
      label: "rid 7 / gen 2",
      ms: 90,
    });
  });

  it("names a metadata read by the open it belongs to", () => {
    const run = makeRun({
      header: { durationUs: 800 * MS },
      datasetOpens: [{ requestId: "open-1", startUs: 0, endUs: 500 * MS }],
      serverRows: [
        makeMetadataRow("open-1", 10 * MS, 30 * MS),
        makeMetadataRow("open-1", 60 * MS, 120 * MS),
      ],
    });

    expect(phase(rollupPhases(run), "metadata.backend-read").worst).toEqual({
      label: "open-1 / rid 0",
      ms: 120,
    });
  });
});
