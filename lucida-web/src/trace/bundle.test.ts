// @vitest-environment happy-dom
/**
 * The bundle, tested as the two callers use it: hand `exportBundle` a trace,
 * the services the page registered, and the options a caller passes, then
 * assert on the file that comes back.
 *
 * Nothing here asserts a threshold or a verdict. The diagnostic inside the
 * bundle is the same object the diagnose tests cover; these cases are about
 * what the bundle carries, where each field comes from, and what it says when
 * a section could not be captured.
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import {
  IDENTITY_HEADER_FIELDS,
  REPLAY_HEADER_FIELDS,
  bundleFilename,
  exportBundle,
  type BundleFrame,
} from "./bundle.ts";
import {
  PNG_BYTES,
  VIEW_URL,
  fixtureContext as context,
  fixtureDocument as document,
  fixtureHealth as health,
  fixtureServices as services,
} from "./bundleFixtures.ts";
import { healthyLocalOpen, interactionRun } from "./diagnose/fixtures.ts";
import { TRACE_SCHEMA_VERSION } from "./types.ts";

describe("what the bundle carries", () => {
  it("holds every section the ticket names, from one export", async () => {
    const bundle = await exportBundle(context());

    expect(bundle.format).toBe("lucida-trace-bundle");
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
    expect(bundle.header.runId).toBe("local-healthy");
    expect(bundle.trace.runs.map((run) => run.header.runId)).toEqual(["local-healthy"]);
    expect(bundle.diagnostic?.runId).toBe("local-healthy");
    expect(bundle.renderings.summary).toContain("local-healthy");
    expect(bundle.renderings.phases.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.renderings.perPhase).sort()).toEqual(
      bundle.diagnostic!.phases.map((phase) => phase.id).sort(),
    );
    expect(bundle.renderings.spatial).toContain("SPATIAL");
    expect(Object.keys(bundle.renderings.perChunk)).toEqual([bundle.diagnostic!.chunk.selector]);
    expect(bundle.renderings.perChunk[bundle.diagnostic!.chunk.selector!].section).toEqual(
      bundle.diagnostic!.chunk,
    );
    expect(bundle.frame).toEqual({
      png: "iVBORw0KGgo=",
      width: 2880,
      height: 1800,
      devicePixelRatio: 2,
      capturedBy: "page",
    });
    expect(bundle.health?.datasets[0].source_cache?.source_reads).toBe(12);
    expect(bundle.health?.fetchedAtEpochMs).toBe(1_700_000_200_000);
    expect(bundle.absent).toEqual([]);
    expect(bundle.perfetto).toBeNull();
  });

  it("names the file for the run it carries", async () => {
    const bundle = await exportBundle(context());
    expect(bundleFilename(bundle)).toBe("lucida-local-healthy.bundle.json");
  });
});

describe("the header", () => {
  it("lists every field the replay needs, and each has a value for a run with a view", async () => {
    const { header } = await exportBundle(context());

    for (const field of REPLAY_HEADER_FIELDS) {
      expect(header[field], field).not.toBeNull();
    }
    // The replay list and the identity list partition the header, so a field
    // added to the header has to be declared as one or the other. The CLI's
    // tests assert the same partition over the golden this header produces.
    const declared = [...REPLAY_HEADER_FIELDS, ...IDENTITY_HEADER_FIELDS].sort();
    expect(Object.keys(header).sort()).toEqual(declared);
    expect(header.savedAtEpochMs).toBe(1_700_000_200_000);
  });

  it("reads the replay conditions off the run's own record, not off the page at save time", async () => {
    const { header } = await exportBundle(context());

    expect(header.viewUrl).toBe(`https://lucida.example${VIEW_URL}`);
    expect(header.viewport).toEqual({
      cssWidth: 1440,
      cssHeight: 900,
      deviceWidth: 2880,
      deviceHeight: 1800,
    });
    expect(header.devicePixelRatio).toBe(2);
    expect(header.mode).toBe("slice");
    expect(header.build).toEqual({ version: "0.2.0", mode: "production", dev: false });
    expect(header.gpu?.vendor).toBe("apple");
    expect(header.cacheWarmth?.detailChunks).toBe(0);
    expect(header.quiescenceHoldMs).toBe(500);
    expect(header.endReason).toBe("quiescent");
    expect(header.cause?.source).toBe("dataset_added");
  });

  it("decodes the pins from the run's view URL", async () => {
    const { header } = await exportBundle(context());

    expect(header.pins).toEqual([
      {
        datasetId: "ds",
        level: 2,
        renderMode: "max_intensity",
        contrast: [
          { min: 100, max: 2000 },
          { min: 50, max: 900 },
        ],
        colormap: ["magenta", "green"],
        autoContrast: false,
      },
    ]);
  });

  it("names the dataset by its canonical source URL, from the health the server reported", async () => {
    const { header } = await exportBundle(context());
    expect(header.datasets).toEqual([
      { id: "ds", name: "sample set", sourceUrl: "gs://bucket/sample.zarr" },
    ]);
  });

  it("keeps the planning configuration it was handed", async () => {
    const planning = { ...DEFAULT_PLANNING_CONFIG, prefetchDepth: 7 };
    const { header } = await exportBundle(context({ planning }));
    expect(header.planning.prefetchDepth).toBe(7);
  });

  it("says nothing is pinned when the URL carries no view, rather than inventing defaults", async () => {
    const run = healthyLocalOpen();
    run.header.composedView = { url: "/w/ws-1", mode: "slice" };
    const { header } = await exportBundle(context({ exportTrace: () => document(run) }));

    expect(header.viewUrl).toBe("https://lucida.example/w/ws-1");
    expect(header.pins).toEqual([
      {
        datasetId: "ds",
        level: null,
        renderMode: null,
        contrast: null,
        colormap: null,
        autoContrast: null,
      },
    ]);
  });
});

describe("choosing the run", () => {
  it("carries the run a caller names, with that run's conditions", async () => {
    const older = healthyLocalOpen();
    older.header.composedView = { url: "/w/ws-1#older", mode: "slice" };
    const newer = interactionRun();
    newer.header.composedView = { url: "/w/ws-1#newer", mode: "volume" };
    const trace = document(older, newer);

    const chosen = await exportBundle(context({ exportTrace: () => trace }), {
      runId: "local-healthy",
    });
    expect(chosen.header.runId).toBe("local-healthy");
    expect(chosen.header.viewUrl).toBe("https://lucida.example/w/ws-1#older");
    expect(chosen.header.mode).toBe("slice");
    expect(chosen.diagnostic?.runId).toBe("local-healthy");
    expect(chosen.trace.runs).toHaveLength(2);

    const newest = await exportBundle(context({ exportTrace: () => trace }));
    expect(newest.header.runId).toBe(newer.header.runId);
    expect(newest.header.mode).toBe("volume");
  });

  it("refuses a run the trace does not hold rather than substituting another", async () => {
    await expect(exportBundle(context(), { runId: "run-that-never-was" })).rejects.toThrow(
      "run-that-never-was",
    );
  });

  it("still produces a readable file when the page recorded no run", async () => {
    const bundle = await exportBundle(context({ exportTrace: () => document() }));

    expect(bundle.header.runId).toBeNull();
    expect(bundle.diagnostic).toBeNull();
    expect(bundle.renderings.summary).toContain("no run was recorded");
    expect(bundle.header.pins).toEqual([]);
    expect(bundle.header.datasets).toEqual([]);
    expect(bundleFilename(bundle)).toBe("lucida-empty.bundle.json");
  });
});

describe("what could not be captured", () => {
  it("says why the frame and the health are missing when no viewer registered its services", async () => {
    const bundle = await exportBundle(context({ services: null }));

    expect(bundle.frame).toBeNull();
    expect(bundle.health).toBeNull();
    expect(bundle.absent.map((entry) => entry.section).sort()).toEqual(["frame", "health"]);
    for (const entry of bundle.absent) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it("carries the failure when a service throws, and the rest of the bundle with it", async () => {
    const bundle = await exportBundle(
      context({
        services: services({
          requestDatasetHealth: () => Promise.reject(new Error("WebSocket is not connected")),
          captureFrame: () => Promise.reject(new Error("worker gone")),
        }),
      }),
    );

    expect(bundle.health).toBeNull();
    expect(bundle.frame).toBeNull();
    expect(bundle.absent).toEqual([
      { section: "frame", reason: "the frame capture failed: worker gone" },
      { section: "health", reason: "the dataset health request failed: WebSocket is not connected" },
    ]);
    expect(bundle.header.runId).toBe("local-healthy");
    expect(bundle.header.datasets).toEqual([{ id: "ds", name: null, sourceUrl: null }]);
  });

  it("records a worker that could not read its canvas as an absent frame", async () => {
    const bundle = await exportBundle(
      context({ services: services({ captureFrame: () => Promise.resolve(null) }) }),
    );
    expect(bundle.frame).toBeNull();
    expect(bundle.absent).toEqual([
      { section: "frame", reason: "the render worker could not read its canvas" },
    ]);
  });
});

describe("the callers", () => {
  it("uses the frame a caller brings, as the driver does, without asking the page for one", async () => {
    const captureFrame = vi.fn(() =>
      Promise.resolve({ png: PNG_BYTES.buffer.slice(0), width: 1, height: 1 }),
    );
    const frame: BundleFrame = {
      png: "iVBORw0KGgo=",
      width: 2880,
      height: 1800,
      devicePixelRatio: 2,
      capturedBy: "driver",
    };

    const bundle = await exportBundle(context({ services: services({ captureFrame }) }), { frame });
    expect(bundle.frame).toEqual(frame);
    expect(captureFrame).not.toHaveBeenCalled();
  });

  it("labels a frame the page takes with the page's ratio now, and null where there is no page", async () => {
    const onScreen = await exportBundle(context({ devicePixelRatio: 3 }));
    expect(onScreen.frame?.devicePixelRatio).toBe(3);

    const noPage = await exportBundle(context({ devicePixelRatio: null }));
    expect(noPage.frame?.devicePixelRatio).toBeNull();
  });

  it("produces the same contents for the same run whoever asks, apart from who took the frame", async () => {
    const trace = context().exportTrace();
    const fromMonitor = await exportBundle(context({ exportTrace: () => trace }));
    const fromDriver = await exportBundle(context({ exportTrace: () => trace }), {
      runId: "local-healthy",
      frame: {
        png: "iVBORw0KGgo=",
        width: 2880,
        height: 1800,
        devicePixelRatio: 2,
        capturedBy: "driver",
      },
    });

    // The frame is the one section that depends on the caller.
    const { frame: monitorFrame, ...monitorRest } = fromMonitor;
    const { frame: driverFrame, ...driverRest } = fromDriver;
    expect(driverRest).toEqual(monitorRest);
    expect(monitorFrame?.capturedBy).toBe("page");
    expect(driverFrame?.capturedBy).toBe("driver");
  });

  it("leaves the Perfetto projection out unless asked", async () => {
    const without = await exportBundle(context());
    expect(without.perfetto).toBeNull();

    const withProjection = await exportBundle(context(), { perfetto: true });
    const file = JSON.parse(withProjection.perfetto!);
    expect(file.displayTimeUnit).toBe("ms");
    expect(file.otherData.runs[0].runId).toBe("local-healthy");
  });

  it("filters the health to the run's datasets when the run names any", async () => {
    const bundle = await exportBundle(
      context({
        services: services({
          requestDatasetHealth: () => Promise.resolve([health("other"), health("ds")]),
        }),
      }),
    );
    expect(bundle.health?.datasets.map((entry) => entry.workspace_dataset_id)).toEqual(["ds"]);

    const noRun = await exportBundle(
      context({
        exportTrace: () => document(),
        services: services({
          requestDatasetHealth: () => Promise.resolve([health("other"), health("ds")]),
        }),
      }),
    );
    expect(noRun.health?.datasets).toHaveLength(2);
  });
});
