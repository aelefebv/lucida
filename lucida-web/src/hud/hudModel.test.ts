/**
 * The HUD model is pure: a sample in, readouts out. These tests feed fixture
 * samples and assert what the strip draws, so the strip is correct when the
 * numbers it draws from are correct.
 */

import { describe, expect, it } from "vitest";

import { FALLBACK, HARDWARE, hudSample, lanes, MIB } from "./hudFixtures.ts";
import {
  buildHudView,
  createHudHistory,
  HUD_COLORS,
  HUD_HISTORY,
  HUD_TICK_MS,
  pushSample,
  type HudHistory,
  type HudReadingSample,
  type HudSample,
} from "./hudModel.ts";
import type { PoolResidencyReport } from "../pipeline/fetch/types.ts";

function pools(overrides: Partial<PoolResidencyReport> = {}): PoolResidencyReport {
  return {
    main: { bytes: 128 * MIB, budgetBytes: 512 * MIB },
    overview: { bytes: 63 * MIB, budgetBytes: 64 * MIB },
    proxy: { bytes: 0, budgetBytes: 256 * MIB },
    ...overrides,
  };
}

function reading(overrides: Partial<HudReadingSample> = {}): HudReadingSample {
  return { seq: 1, frameTimeUs: 4_200, gpuPassUs: null, ...overrides };
}

function after(samples: HudSample[]): HudHistory {
  const history = createHudHistory();
  for (const s of samples) pushSample(history, s);
  return history;
}

function series(history: HudHistory, key: string) {
  const found = buildHudView(history).series.find((s) => s.key === key);
  if (!found) throw new Error(`no series ${key}`);
  return found;
}

describe("bytes each way", () => {
  it("reads a rate by differencing the totals across the tick", () => {
    const history = after([
      hudSample(0, { bytesReceived: 1_000, bytesSent: 100 }),
      hudSample(250, { bytesReceived: 251_000, bytesSent: 600 }),
    ]);
    const received = series(history, "received");
    const sent = series(history, "sent");
    expect(received.values.at(-1)).toBe(1_000_000);
    expect(received.latest).toBe("1.0 MB/s");
    expect(sent.values.at(-1)).toBe(2_000);
    expect(sent.latest).toBe("2.0 kB/s");
    expect(received.state).toBeNull();
  });

  it("has no rate on the first sample, and says so rather than drawing zero", () => {
    const history = after([hudSample(0, { bytesReceived: 1_000 })]);
    const received = series(history, "received");
    expect(received.values.at(-1)).toBeNaN();
    expect(received.absent).toBe("no rate until a second sample");
    expect(received.tone).toBe("absent");
  });

  it("keeps only the history's worth of samples, oldest first", () => {
    const samples: HudSample[] = [];
    for (let i = 0; i <= HUD_HISTORY + 5; i++) {
      samples.push(hudSample(i * HUD_TICK_MS, { bytesReceived: i * 1_000 }));
    }
    const received = series(after(samples), "received");
    expect(received.values).toHaveLength(HUD_HISTORY);
    expect(received.values.every((v) => v === 4_000)).toBe(true);
  });
});

describe("frame time", () => {
  it("labels main-thread time as such and takes a fresh reading once", () => {
    const history = after([hudSample(0, { reading: reading() }), hudSample(250, { reading: reading() })]);
    const frame = series(history, "frame");
    expect(frame.label).toBe("frame (main thread)");
    expect(frame.values.slice(-2)).toEqual([4.2, Number.NaN]);
    expect(frame.absent).toBe("no frame since the last tick");
  });

  it("pairs the frame tone with a word for it", () => {
    const at = (frameTimeUs: number) => series(after([hudSample(0, { reading: reading({ frameTimeUs }) })]), "frame");
    expect([at(4_200).state, at(4_200).tone]).toEqual(["within a frame", "ok"]);
    expect([at(20_000).state, at(20_000).tone]).toEqual(["over a frame", "busy"]);
    expect([at(40_000).state, at(40_000).tone]).toEqual(["over two frames", "warn"]);
  });

  it("shows GPU pass time as absent, with the reason, when the adapter offers no timestamp queries", () => {
    const gpu = series(after([hudSample(0, { gpu: FALLBACK })]), "gpu");
    expect(gpu.values.at(-1)).toBeNaN();
    expect(gpu.absent).toBe("not recorded: the adapter offers no timestamp queries");
  });

  it("shows GPU pass time when a reading carried one", () => {
    const gpu = series(after([hudSample(0, { reading: reading({ gpuPassUs: 2_500 }) })]), "gpu");
    expect(gpu.label).toBe("GPU pass");
    expect(gpu.values.at(-1)).toBe(2.5);
    expect(gpu.latest).toBe("2.5 ms");
    expect(gpu.state).toBe("within a frame");
  });
});

describe("in flight and pending by lane", () => {
  it("lists the view's lanes with their counts and totals", () => {
    const view = buildHudView(after([hudSample(0)]));
    expect(view.lanes.rows).toEqual([
      { label: "detail", inFlight: 6, pending: 40 },
      { label: "coarse", inFlight: 1, pending: 0 },
      { label: "minimap", inFlight: 0, pending: 3 },
      { label: "prefetch", inFlight: 2, pending: 120 },
    ]);
    expect(view.lanes.inFlightTotal).toBe(9);
    expect(view.lanes.pendingTotal).toBe(163);
    expect(view.lanes.note).toBeNull();
  });

  it("names the cap when the queue was too deep to split by lane", () => {
    const view = buildHudView(
      after([
        hudSample(0, {
          lanes: lanes({
            pending: { detail: 0, coarse: 0, minimap: 0, prefetch: 0, overview: 0 },
            pendingTotal: 9_000,
            pendingUnclassified: true,
          }),
        }),
      ]),
    );
    expect(view.lanes.pendingTotal).toBe(9_000);
    expect(view.lanes.note).toEqual({ text: "pending not split by lane: queue deeper than 4,096", tone: "busy" });
  });

  it("shows the historical and proxy buckets only when they carry work", () => {
    const view = buildHudView(
      after([
        hudSample(0, {
          lanes: lanes({ inFlight: { detail: 0, coarse: 0, minimap: 0, prefetch: 0, overview: 1 }, proxyPending: 2 }),
        }),
      ]),
    );
    expect(view.lanes.rows.map((r) => r.label)).toEqual(["detail", "coarse", "minimap", "prefetch", "overview", "proxy assets"]);
  });

  it("states that there is no session when the cache is not there to ask", () => {
    const view = buildHudView(after([hudSample(0, { lanes: null })]));
    expect(view.lanes.rows).toEqual([]);
    expect(view.lanes.note).toEqual({ text: "no session", tone: "absent" });
  });
});

describe("resident bytes against budget", () => {
  it("pairs each pool's fill with a state word and a color", () => {
    const view = buildHudView(after([hudSample(0)]));
    expect(view.pools.map((p) => [p.label, p.text, p.state, p.tone])).toEqual([
      ["main", "128 / 512 MiB", "under budget", "ok"],
      ["overview", "63 / 64 MiB", "at budget", "busy"],
      ["proxy", "0 / 256 MiB", "under budget", "ok"],
      ["GPU", "not reported", "not reported", "absent"],
    ]);
    expect(view.pools[0].fill).toBeCloseTo(0.25);
    expect(view.pools[3].fill).toBeNull();
  });

  it("calls a pool near its budget before it is at it", () => {
    const view = buildHudView(
      after([hudSample(0, { pools: pools({ main: { bytes: 470 * MIB, budgetBytes: 512 * MIB } }) })]),
    );
    expect(view.pools[0].state).toBe("near budget");
    expect(view.pools[0].tone).toBe("busy");
  });

  it("reads absent pools as absent when there is no session", () => {
    const view = buildHudView(after([hudSample(0, { pools: null })]));
    expect(view.pools.map((p) => p.state)).toEqual(["no session", "no session", "no session", "not reported"]);
  });
});

describe("target and displayed level per dataset", () => {
  it("names the levels and whether the screen is behind the target", () => {
    const view = buildHudView(after([hudSample(0)]));
    expect(view.levels).toEqual([
      { name: "a.zarr", text: "target 2 · displayed 3", state: "coarser than target", tone: "busy" },
    ]);
  });

  it("reads at target, finer, pinned, and nothing on screen", () => {
    const view = buildHudView(
      after([
        hudSample(0, {
          levels: [
            { datasetId: "a", name: "a", target: { min: 2, max: 2 }, pinned: false, displayed: { min: 2, max: 2 } },
            { datasetId: "b", name: "b", target: { min: 3, max: 4 }, pinned: true, displayed: { min: 1, max: 2 } },
            { datasetId: "c", name: "c", target: { min: 0, max: 0 }, pinned: false, displayed: null },
            { datasetId: "d", name: "d", target: null, pinned: false, displayed: null },
          ],
        }),
      ]),
    );
    expect(view.levels.map((l) => [l.text, l.state, l.tone])).toEqual([
      ["target 2 · displayed 2", "at target", "ok"],
      ["target 3-4 (pinned) · displayed 1-2", "finer than target", "info"],
      ["target 0 · displayed none", "nothing on screen", "absent"],
      ["target none · displayed none", "no target", "absent"],
    ]);
  });
});

describe("quiescence with its reason", () => {
  it("reads quiescent in the ok tone", () => {
    const view = buildHudView(after([hudSample(0, { quiescence: { quiescent: true, reason: "quiescent" } })]));
    expect(view.quiescence).toEqual({
      label: "quiescent",
      detail: "nothing pending, nothing in flight, the view resident",
      tone: "ok",
    });
  });

  it("reads working with the first unmet clause in words", () => {
    const view = buildHudView(after([hudSample(0, { quiescence: { quiescent: false, reason: "detail_not_resident" } })]));
    expect(view.quiescence).toEqual({ label: "working", detail: "detail not yet resident", tone: "busy" });
  });

  it("reads unpublished before the page has said anything", () => {
    const view = buildHudView(after([hudSample(0, { quiescence: null })]));
    expect(view.quiescence.label).toBe("unpublished");
    expect(view.quiescence.tone).toBe("absent");
  });
});

describe("the adapter", () => {
  it("shows a hardware adapter's description", () => {
    const view = buildHudView(after([hudSample(0)]));
    expect(view.adapter).toEqual({
      label: "Example Discrete Adapter",
      detail: "hardware adapter",
      tone: "ok",
      warning: false,
    });
  });

  it("warns on a software fallback", () => {
    const view = buildHudView(after([hudSample(0, { gpu: FALLBACK })]));
    expect(view.adapter).toEqual({
      label: "software fallback",
      detail: "warning: Software Rasterizer renders on the CPU",
      tone: "warn",
      warning: true,
    });
  });

  it("names the adapter from its parts when the description is empty", () => {
    const view = buildHudView(after([hudSample(0, { gpu: { ...HARDWARE, description: "" } })]));
    expect(view.adapter.label).toBe("vendor arch");
  });

  it("says when no adapter was identified", () => {
    const view = buildHudView(after([hudSample(0, { gpu: null })]));
    expect(view.adapter).toEqual({
      label: "adapter not identified",
      detail: "no WebGPU adapter resolved",
      tone: "absent",
      warning: false,
    });
  });
});

describe("the view's frame", () => {
  it("states its rolling window and pairs every tone with a color", () => {
    const view = buildHudView(after([hudSample(0)]));
    expect(view.window).toBe("15 s rolling window · 250 ms tick");
    expect(view.run).toEqual({ label: "run open", detail: "a run is recording", tone: "info" });
    for (const tone of ["ok", "busy", "warn", "absent", "info"] as const) {
      expect(HUD_COLORS[tone]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("reads before any sample without throwing", () => {
    const view = buildHudView(createHudHistory());
    expect(view.series.every((s) => s.absent !== null)).toBe(true);
    expect(view.quiescence.label).toBe("unpublished");
    expect(view.levels).toEqual([]);
  });
});
