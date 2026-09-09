// @vitest-environment happy-dom

/**
 * The dock, over the derivation's fixture runs.
 *
 * The document these render is the same object the agent surface renders, so
 * these cases are about ordering and reachability: what leads, what a click
 * carries, where the dock draws. Never about a threshold. A test here that
 * asserted a verdict would be asserting the derivation through two layers of
 * DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { diagnoseDocument, diagnoseRun } from "../trace/diagnose/diagnose.ts";
import {
  coldRemoteOpen,
  healthyLocalOpen,
  lateStallOpen,
  makeDocument,
  makeHeader,
  makeReading,
  makeReadingSeries,
  makeTick,
  saturatedReopen,
} from "../trace/diagnose/fixtures.ts";
import { deriveProvisional, type ProvisionalReading } from "../trace/diagnose/provisional.ts";
import {
  deriveLiveTimeline,
  TIMELINE_CHARTS,
  type LiveTimeline,
} from "../trace/diagnose/timeline.ts";
import { currentChunkSelection, publishChunkSelection } from "../trace/linkedSelection.ts";
import { PHASES, type TraceDocument, type TraceReading, type TraceRun } from "../trace/types.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import type { MonitorRead, MonitorRunSummary } from "./monitorSource.ts";
import { buildTimelineDrawList, xAtMs } from "./timelineDraw.ts";

/** A run in progress, as the recorder reports one. */
function progress(overrides: Partial<LiveProgress> = {}): LiveProgress {
  return {
    runId: "run-open",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" },
    elapsedMs: 4_200,
    planned: 1_000,
    visible: 600,
    inFlight: 300,
    retired: 100,
    unrecorded: 0,
    occupancy: PHASES.map((phase) => ({ phase, rows: phase === "wire" ? 300 : 0 })),
    unstamped: 0,
    quiescent: false,
    quiescenceReason: "chunks_in_flight",
    ...overrides,
  };
}

/**
 * A provisional reading over the run in progress, derived the way the
 * recorder derives one: from the progress above and a window of readings
 * pinned at a cap with a backlog that is not shrinking.
 */
function provisional(
  overrides: Partial<LiveProgress> = {},
  shape: (index: number) => Partial<TraceReading> = () => ({ inFlight: 24, queueDepth: 20_000 }),
): ProvisionalReading {
  return deriveProvisional({
    progress: progress(overrides),
    atUs: 4_200_000,
    readings: makeReadingSeries(0, 4_200_000, 100_000, shape),
    readingsDropped: 0,
  });
}

/** The live charts over the same run in progress: readings, one tick sample, and no rows. */
function liveCharts(): LiveTimeline {
  return deriveLiveTimeline({
    runId: "run-open",
    cause: { epoch: "content", dirtyKind: "interactive", source: "dataset_open_request" },
    atUs: 4_200_000,
    readings: Array.from({ length: 40 }, (_, i) =>
      makeReading(i * 100_000, { queueDepth: 20_000, inFlight: 24, frameTimeUs: 6_000 }),
    ),
    readingsDropped: 0,
    ticks: [makeTick(50_000, {}, { chunkRequest: { messages: 24, bytes: 2_400 } })],
    ticksDropped: 0,
    events: [],
    eventsDropped: 0,
    connections: [
      { generation: 1, openedAtUs: null, closedAtUs: null, gapUs: null, firstRid: null, lastRid: null },
    ],
    gpu: makeHeader().gpu,
    intervals: [],
    sentTotalBytes: 2_400,
  });
}

const read = vi.hoisted(() => ({ value: null as MonitorRead | null }));
const runs = vi.hoisted(() => ({ value: [] as MonitorRunSummary[] }));
const trace = vi.hoisted(() => ({ value: null as TraceDocument | null }));
const live = vi.hoisted(() => ({ value: null as unknown }));
const reading = vi.hoisted(() => ({ value: null as unknown }));
const charts = vi.hoisted(() => ({ value: null as unknown }));
const downloadTraceFile = vi.hoisted(() => vi.fn(() => "lucida-run-1.trace.json"));
const downloadBundle = vi.hoisted(() => vi.fn(() => Promise.resolve("lucida-run-1.bundle.json")));
const sendReport = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ entryId: "5d1f0c2e-7b3a", expiresAt: "2026-09-23T14:05:00Z" })),
);
const readMonitor = vi.hoisted(() =>
  vi.fn(() => ({ read: read.value, runs: runs.value, trace: trace.value })),
);
const readProgress = vi.hoisted(() => vi.fn(() => live.value));
const readProvisional = vi.hoisted(() => vi.fn(() => reading.value));
const readLiveTimeline = vi.hoisted(() => vi.fn(() => charts.value));
const stopRun = vi.hoisted(() =>
  vi.fn(() => {
    live.value = null;
    reading.value = null;
    charts.value = null;
  }),
);

// Only the reads that touch the seam are replaced. readWindow stays real: it
// derives from the document the snapshot already holds, and the brush tests
// assert what it derives.
vi.mock("./monitorSource.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitorSource.ts")>()),
  readMonitor,
  downloadTraceFile,
  downloadBundle,
  sendReport,
  readProgress,
  readProvisional,
  readLiveTimeline,
  stopRun,
}));

const { MonitorDock } = await import("./MonitorDock.tsx");

function showing(run: TraceRun) {
  read.value = { ok: true, document: diagnoseRun(run) };
  trace.value = makeDocument([run]);
  return render(<MonitorDock onClose={() => {}} />);
}

/**
 * Drag across the axis from one instant of the run's clock to another. The
 * canvas has no layout here, so its client rectangle sits at the origin and
 * a CSS x on its own scale is the pointer's client x.
 */
function brush(run: TraceRun, startMs: number, endMs: number) {
  const canvas = screen.getByTestId("monitor-timeline-canvas");
  const { scale } = buildTimelineDrawList(diagnoseRun(run).timeline, {
    width: parseFloat(canvas.style.width),
    devicePixelRatio: 1,
  });
  fireEvent.pointerDown(canvas, { clientX: xAtMs(scale, startMs), clientY: 20, button: 0 });
  fireEvent.pointerMove(document, { clientX: xAtMs(scale, endMs), clientY: 20 });
  fireEvent.pointerUp(document, { clientX: xAtMs(scale, endMs), clientY: 20 });
}

beforeEach(() => {
  downloadTraceFile.mockClear();
  downloadBundle.mockClear();
  downloadBundle.mockImplementation(() => Promise.resolve("lucida-run-1.bundle.json"));
  sendReport.mockClear();
  sendReport.mockImplementation(() =>
    Promise.resolve({ entryId: "5d1f0c2e-7b3a", expiresAt: "2026-09-23T14:05:00Z" }),
  );
  readMonitor.mockClear();
  readProgress.mockClear();
  readProvisional.mockClear();
  readLiveTimeline.mockClear();
  stopRun.mockClear();
  runs.value = [];
  trace.value = null;
  live.value = null;
  reading.value = null;
  charts.value = null;
  window.localStorage.removeItem("monitor.dock.height");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  publishChunkSelection(null);
});

describe("what leads", () => {
  it("puts the verdict callout above the per-phase table", () => {
    showing(coldRemoteOpen());

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings.indexOf("Verdict")).toBeLessThan(headings.indexOf("Phases"));
  });

  it("puts coverage above the verdict, so a headline is never read unqualified", () => {
    showing(healthyLocalOpen());

    const banner = screen.getByTestId("monitor-banner-coverage");
    const verdict = screen.getAllByTestId("monitor-callout-verdict")[0];
    // Node.DOCUMENT_POSITION_FOLLOWING: the verdict comes after the banner.
    expect(banner.compareDocumentPosition(verdict) & 4).toBeTruthy();
  });

  it("leads with the truncation record when the run stopped recording", () => {
    const run = saturatedReopen();
    run.header.truncation = {
      reason: "per-run-cap",
      atUs: 6_000_000,
      capBytes: 8_388_608,
      rowsRecorded: 18_000,
      rowsUnrecorded: 45_412,
      ticksUnrecorded: 0,
      eventsUnrecorded: 0,
      serverRowsUnrecorded: 0,
    };
    showing(run);

    const banners = screen.getByLabelText("Coverage");
    expect(banners.firstElementChild).toHaveProperty("dataset.testid", "monitor-banner-truncation");
    expect(banners.textContent).toContain("63,412");
  });

  it("renders the not-a-health-signal line on a clean run too", () => {
    showing(healthyLocalOpen());

    expect(screen.getByTestId("monitor-banner-not-health").textContent).toContain("retries");
  });
});

describe("the cold open's first seconds", () => {
  it("draws dataset-open metadata reads in a band of their own", () => {
    showing(coldRemoteOpen());

    const band = screen.getByTestId("monitor-track-band-metadata");
    const track = within(band).getByTestId("monitor-track-metadata.backend-read");
    expect(track).toBeDefined();
    // Positioned over the run's own clock rather than stacked at the origin.
    const bar = track.querySelector<HTMLElement>(".monitor-track-bar");
    expect(bar).not.toBeNull();
    expect(parseFloat(bar!.style.width)).toBeGreaterThan(80);
  });

  it("says a phase has no position rather than drawing it at zero", () => {
    showing(coldRemoteOpen());

    const track = screen.getByTestId("monitor-track-server.permit-wait");
    expect(track.querySelector(".monitor-track-bar")).toBeNull();
    expect(track.textContent).toContain("no position");
  });
});

describe("drill-down", () => {
  it("is one click and carries the callout's question and the worst row", () => {
    showing(coldRemoteOpen());

    const callout = screen
      .getAllByTestId(/^monitor-callout-/)
      .find((node) => node.querySelector("button"))!;
    const question = callout.querySelector("h3")!.textContent;

    fireEvent.click(within(callout).getByRole("button"));

    const panel = screen.getByTestId("monitor-drill-panel");
    expect(screen.getByTestId("monitor-drill-question").textContent).toBe(question);
    // A row identity, not a time coordinate.
    expect(within(panel).getByTestId("monitor-drill-worst").textContent).toContain("open-1");
    expect(panel.textContent).not.toContain("Raw spans are on this page");
  });

  it("keeps the per-phase table as the second section while a drill-down is open", () => {
    // The drill belongs to the verdict flow it was opened from. Injecting it
    // between the two would push the table into third place.
    showing(coldRemoteOpen());
    fireEvent.click(screen.getAllByTestId(/^monitor-drill-/)[0]);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toBe("Verdict");
    expect(headings[1]).toBe("Phases");
    expect(screen.getByTestId("monitor-drill-panel")).toBeTruthy();
  });

  it("scopes the phase table to the phase the question was about", () => {
    showing(coldRemoteOpen());
    const callout = screen
      .getAllByTestId(/^monitor-callout-/)
      .find((node) => node.querySelector("button"))!;

    fireEvent.click(within(callout).getByRole("button"));

    const scoped = screen.getByTestId("monitor-phase-table").querySelector(".monitor-row-scoped");
    expect(scoped?.textContent).toContain("metadata.backend-read");
  });
});

describe("saving a run", () => {
  it("writes the run through the export seam and says what it wrote", () => {
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-save-run"));

    // Named for the run on screen, so the file and the follow-up command that
    // names that run agree.
    expect(downloadTraceFile).toHaveBeenCalledWith("trace", "remote-cold");
    expect(screen.getByTestId("monitor-saved").textContent).toContain(".trace.json");
  });

  it("offers the same run as a Perfetto file, for the questions this page does not answer", () => {
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-save-perfetto"));

    expect(downloadTraceFile).toHaveBeenCalledWith("perfetto", "remote-cold");
  });

  it("saves the run as a bundle through the seam's own bundle function, and says what it wrote", async () => {
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-save-bundle"));
    expect(screen.getByTestId("monitor-save-bundle").textContent).toContain("Saving");
    expect(screen.getByTestId("monitor-save-bundle")).toHaveProperty("disabled", true);

    expect(downloadBundle).toHaveBeenCalledWith("remote-cold");
    await screen.findByTestId("monitor-saved");
    expect(screen.getByTestId("monitor-saved").textContent).toContain(".bundle.json");
    expect(screen.getByTestId("monitor-save-bundle").textContent).toBe("Save bundle");
  });

  it("shows why a bundle could not be saved, where the file name would have been", async () => {
    downloadBundle.mockImplementation(() => Promise.reject(new Error("no trace seam on this page")));
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-save-bundle"));

    const failed = await screen.findByTestId("monitor-save-failed");
    expect(failed.textContent).toContain("no trace seam on this page");
    expect(screen.queryByTestId("monitor-saved")).toBeNull();
  });

  /**
   * The report goes somewhere the person who sent it cannot see, so the
   * page hands back the one thing that reaches it again: the entry, and
   * the command that fetches it (#1067).
   */
  it("sends the run to the workspace inbox and names the entry it landed in", async () => {
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-send-report"));
    expect(screen.getByTestId("monitor-send-report").textContent).toContain("Sending");
    expect(screen.getByTestId("monitor-send-report")).toHaveProperty("disabled", true);

    expect(sendReport).toHaveBeenCalledWith("remote-cold");
    const sent = await screen.findByTestId("monitor-sent");
    expect(sent.textContent).toContain("5d1f0c2e-7b3a");
    expect(sent.textContent).toContain("2026-09-23T14:05:00Z");
    expect(sent.textContent).toContain("lucida trace inbox fetch 5d1f0c2e-7b3a");
    expect(screen.getByTestId("monitor-send-report").textContent).toBe("Send report");
  });

  it("shows why a report could not be sent, rather than looking sent", async () => {
    sendReport.mockImplementation(() =>
      Promise.reject(new Error("the bundle carries no header")),
    );
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-send-report"));

    const failed = await screen.findByTestId("monitor-send-failed");
    expect(failed.textContent).toContain("the bundle carries no header");
    expect(screen.queryByTestId("monitor-sent")).toBeNull();
  });

  /** Nothing goes to the inbox until somebody presses the action. */
  it("sends nothing while the page is opened and a run is read", () => {
    showing(coldRemoteOpen());
    fireEvent.click(screen.getByTestId("monitor-reread"));
    fireEvent.click(screen.getByTestId("monitor-save-bundle"));

    expect(sendReport).not.toHaveBeenCalled();
  });
});

describe("nothing recorded yet", () => {
  it("says so instead of rendering an empty report", () => {
    read.value = { ok: false, reason: "no run (newest) in this trace document" };
    render(<MonitorDock onClose={() => {}} />);

    expect(screen.getByTestId("monitor-empty").textContent).toContain("no run");
    expect(screen.queryByTestId("monitor-phase-table")).toBeNull();
    expect(screen.getByTestId("monitor-save-run")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("monitor-save-bundle")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("monitor-send-report")).toHaveProperty("disabled", true);
  });
});

describe("observation only", () => {
  it("offers no control that could change what the pipeline does", () => {
    showing(coldRemoteOpen());

    // Every button in the dock reads, saves, sends, drills in, moves the dock,
    // or decides where a reading goes. Sending puts a copy of the recording
    // somewhere else, and *Start a watch stream* changes who can see it; neither
    // changes what the pipeline does. If a future change adds a control that
    // does not fit that list, this is where it shows up.
    const labels = screen.getAllByRole("button").map((node) => node.textContent);
    for (const label of labels) {
      expect(label).toMatch(
        /^(Close|Pop out|Read the newest run|Save run|Save for Perfetto|Save bundle|Send report|Start a watch stream|Show the rows behind .*|Close drill-down|Clear the brush)$/,
      );
    }
  });

  it("adds only one reading control while a run is open, and it ends the run rather than the work", () => {
    // *Stop & analyse* closes the recording's interval. The pipeline goes on
    // doing exactly what it was doing — what ends is the run's label, which is
    // what makes it readable. The watch toggle stands beside it because the
    // stream carries an open run as readily as a closed one.
    live.value = progress();
    render(<MonitorDock onClose={() => {}} />);

    const labels = screen.getAllByRole("button").map((node) => node.textContent);
    expect(labels).toEqual(["Start a watch stream", "Stop & analyse", "Pop out", "Close"]);
  });
});

describe("the timeline between the coverage and the verdict", () => {
  it("draws one chart per entry of the closed set, in order, each with its legend", () => {
    showing(coldRemoteOpen());

    const timeline = screen.getByTestId("monitor-timeline");
    const ids = TIMELINE_CHARTS.map((entry) => entry.id);
    const rows = ids.map((id) => within(timeline).getByTestId(`monitor-chart-${id}`));
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].compareDocumentPosition(rows[i]) & 4).toBeTruthy();
    }
    // Coverage and truncation lead the picture they qualify, and the verdict
    // and the rest of the report follow it.
    const coverage = screen.getByLabelText("Coverage");
    const verdict = screen.getByRole("heading", { name: "Verdict" });
    expect(coverage.compareDocumentPosition(timeline) & 4).toBeTruthy();
    expect(timeline.compareDocumentPosition(verdict) & 4).toBeTruthy();
    const canvas = screen.getByTestId("monitor-timeline-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(Math.round(parseFloat(canvas.style.width) * window.devicePixelRatio));
  });

  it("labels absent data as absent rather than drawing it at zero", () => {
    showing(healthyLocalOpen());

    // A chart this build does not record at all.
    const received = screen.getByTestId("monitor-chart-bytes.received-absent");
    expect(received.textContent).toMatch(/^absent — bytes received are not recorded/);
    // A series absent inside a chart that is otherwise drawn.
    const gpu = screen.getByTestId("monitor-series-frame-gpu-pass");
    expect(gpu.textContent).toContain("absent: the adapter offers no timestamp queries");
    expect(gpu.className).toContain("monitor-timeline-absent");
    expect(screen.getByTestId("monitor-series-frame-main-thread").textContent).toContain("max 3.5");
  });

  it("keeps the closed-run report intact beneath the timeline", () => {
    showing(coldRemoteOpen());

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["Verdict", "Phases", "Critical path", "Limiters", "Run"]);
    expect(screen.getByTestId("monitor-phase-table")).toBeTruthy();
    expect(screen.getByTestId("monitor-banner-coverage")).toBeTruthy();
  });

  it("draws the live charts from the per-tick tiers while a run is open, and reads no run", () => {
    live.value = progress();
    charts.value = liveCharts();
    render(<MonitorDock onClose={() => {}} />);

    expect(readLiveTimeline).toHaveBeenCalled();
    expect(readMonitor).not.toHaveBeenCalled();
    expect(screen.getByTestId("monitor-timeline-provisional").textContent).toBe("provisional");
    expect(screen.getByTestId("monitor-series-in-flight-in-flight").textContent).toContain("max 24");
    // The run's status and its truncation lead the charts, and the counters follow.
    const status = screen.getByTestId("monitor-live-status");
    const timeline = screen.getByTestId("monitor-timeline");
    expect(status.compareDocumentPosition(timeline) & 4).toBeTruthy();
    expect(timeline.compareDocumentPosition(screen.getByTestId("monitor-live-counters")) & 4).toBeTruthy();
    expect(screen.getByTestId("monitor-chart-occupancy.browser-absent").textContent).toContain(
      "when the run closes",
    );
  });

  it("re-reads the live charts on the poll, beside the counters and the provisional reading", () => {
    vi.useFakeTimers();
    try {
      live.value = progress();
      charts.value = liveCharts();
      render(<MonitorDock onClose={() => {}} />);
      readLiveTimeline.mockClear();

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(readLiveTimeline).toHaveBeenCalledTimes(1);
      expect(readProvisional).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("brushing a window on the axis", () => {
  it("scopes the report to the window and states it, with the show command that reads the same numbers", () => {
    // The late-stall run: a decode stall over the whole run, clear over its
    // first second.
    const run = lateStallOpen();
    showing(run);
    expect(screen.getAllByTestId("monitor-callout-verdict")[0].textContent).toContain("browser.decode");

    brush(run, 0, 1_000);

    expect(screen.getByTestId("monitor-banner-window").textContent).toContain("0..1000 ms");
    expect(screen.getAllByTestId("monitor-callout-verdict")[0].textContent).toContain("no stall");
    expect(screen.getByTestId("monitor-brush-command").textContent).toBe(
      "lucida trace show late-stall --window 0..1000",
    );
    expect(parseFloat(screen.getByTestId("monitor-brush").style.width)).toBeGreaterThan(0);
    // The phase table on screen matches the derivation the CLI's window flag
    // evaluates over the same window.
    const flagged = diagnoseDocument(makeDocument([run]), {
      runId: "late-stall",
      window: { startMs: 0, endMs: 1_000 },
    });
    const decode = flagged.phases.find((phase) => phase.id === "browser.decode")!;
    const table = screen.getByTestId("monitor-phase-table");
    const row = within(table).getByText("browser.decode").closest("tr")!;
    const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells[1]).toBe(decode.n.toLocaleString());
    expect(decode.n).toBe(60);
  });

  it("publishes the brushed chunk set, narrowed to the phase a drill-down scopes to", () => {
    const run = lateStallOpen();
    showing(run);
    expect(currentChunkSelection()).toBeNull();

    brush(run, 1_100, 2_000);

    const published = currentChunkSelection();
    expect(published).toMatchObject({ runId: "late-stall", phase: null, chunks: 40 });
    expect(published?.window).toMatchObject({ startMs: 1_100, endMs: 2_000 });
    expect(screen.getByTestId("monitor-brush-selection").textContent).toContain("40 chunks");

    // The verdict inside this window names browser.decode, so drilling into
    // it scopes the set to that phase.
    fireEvent.click(screen.getByTestId("monitor-drill-verdict"));
    expect(currentChunkSelection()).toMatchObject({ phase: "browser.decode", chunks: 40 });
    expect(screen.getByTestId("monitor-brush-selection").textContent).toContain("browser.decode");

    fireEvent.click(screen.getByText("Close drill-down"));
    expect(currentChunkSelection()?.phase).toBeNull();
  });

  it("clears the brush from its control, restoring the whole-run report and clearing the set", () => {
    const run = lateStallOpen();
    showing(run);
    brush(run, 0, 1_000);
    expect(screen.getByTestId("monitor-banner-window")).toBeTruthy();

    fireEvent.click(screen.getByTestId("monitor-brush-clear"));

    expect(screen.queryByTestId("monitor-banner-window")).toBeNull();
    expect(screen.queryByTestId("monitor-brush")).toBeNull();
    expect(screen.getAllByTestId("monitor-callout-verdict")[0].textContent).toContain("browser.decode");
    expect(currentChunkSelection()).toBeNull();
  });

  it("treats a click on the axis as clearing, never as a window", () => {
    const run = lateStallOpen();
    showing(run);
    brush(run, 0, 1_000);

    brush(run, 500, 500);

    expect(screen.queryByTestId("monitor-banner-window")).toBeNull();
    expect(currentChunkSelection()).toBeNull();
  });

  it("keeps the axis whole while brushed, and drops the brush when another run is read", () => {
    const run = lateStallOpen();
    showing(run);
    brush(run, 1_100, 2_000);

    expect(screen.getByTestId("monitor-timeline-statement").textContent).toContain("0..2000 ms");
    fireEvent.click(screen.getByTestId("monitor-reread"));

    expect(screen.queryByTestId("monitor-banner-window")).toBeNull();
    expect(currentChunkSelection()).toBeNull();
  });

  it("clears the published set when the dock unmounts", () => {
    const run = lateStallOpen();
    const view = showing(run);
    brush(run, 1_100, 2_000);
    expect(currentChunkSelection()).not.toBeNull();

    view.unmount();

    expect(currentChunkSelection()).toBeNull();
  });

  it("offers no brush on the live picture, which is provisional and has no closed interval to scope", () => {
    live.value = progress();
    charts.value = liveCharts();
    render(<MonitorDock onClose={() => {}} />);

    const canvas = screen.getByTestId("monitor-timeline-canvas");
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 20, button: 0 });
    fireEvent.pointerMove(document, { clientX: 600, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 600, clientY: 20 });

    expect(screen.queryByTestId("monitor-brush")).toBeNull();
    expect(screen.queryByTestId("monitor-brush-line")).toBeNull();
    expect(currentChunkSelection()).toBeNull();
  });
});

describe("the dock in the viewer", () => {
  it("sits over the canvas at the height it was given, and closes from its own control", () => {
    const onClose = vi.fn();
    showing(coldRemoteOpen());
    cleanup();
    read.value = { ok: true, document: diagnoseRun(coldRemoteOpen()) };
    render(<MonitorDock onClose={onClose} insetLeft={280} />);

    const dock = screen.getByTestId("monitor-dock");
    expect(dock.style.left).toBe("280px");
    expect(parseInt(dock.style.height, 10)).toBeGreaterThanOrEqual(160);

    fireEvent.click(screen.getByTestId("monitor-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resizes from its top edge and remembers the height", () => {
    showing(coldRemoteOpen());
    const dock = screen.getByTestId("monitor-dock");
    const before = parseInt(dock.style.height, 10);

    fireEvent.pointerDown(screen.getByTestId("monitor-dock-resize"), { clientY: 500 });
    fireEvent.pointerMove(document, { clientY: 400 });
    fireEvent.pointerUp(document, { clientY: 400 });

    expect(parseInt(dock.style.height, 10)).toBe(before + 100);
    expect(window.localStorage.getItem("monitor.dock.height")).toBe(String(before + 100));

    // A later mount starts at the remembered height.
    cleanup();
    read.value = { ok: true, document: diagnoseRun(coldRemoteOpen()) };
    render(<MonitorDock onClose={() => {}} />);
    expect(parseInt(screen.getByTestId("monitor-dock").style.height, 10)).toBe(before + 100);
  });

  it("never drags below its minimum height", () => {
    showing(coldRemoteOpen());

    fireEvent.pointerDown(screen.getByTestId("monitor-dock-resize"), { clientY: 100 });
    fireEvent.pointerMove(document, { clientY: 5_000 });
    fireEvent.pointerUp(document, { clientY: 5_000 });

    expect(parseInt(screen.getByTestId("monitor-dock").style.height, 10)).toBe(160);
  });
});

describe("popping out", () => {
  interface FakePopup {
    document: Document;
    devicePixelRatio: number;
    closed: boolean;
    close: Mock<() => void>;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  }

  /**
   * The document borrows the test window as its view: DOM queries and events
   * need one to reach a node inside it.
   */
  function fakePopup(): FakePopup {
    const popupDocument = document.implementation.createHTMLDocument("popout");
    Object.defineProperty(popupDocument, "defaultView", { value: window, configurable: true });
    const listeners = new Map<string, Set<() => void>>();
    const popup: FakePopup = {
      document: popupDocument,
      devicePixelRatio: 2,
      closed: false,
      close: vi.fn(() => {
        popup.closed = true;
        for (const listener of listeners.get("pagehide") ?? []) listener();
      }),
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type, listener) => {
        listeners.get(type)?.delete(listener);
      },
    };
    return popup;
  }

  function openingWindows(): FakePopup[] {
    const opened: FakePopup[] = [];
    vi.spyOn(window, "open").mockImplementation(() => {
      const popup = fakePopup();
      opened.push(popup);
      return popup as unknown as Window;
    });
    return opened;
  }

  it("renders the whole dock in the other window and nothing of it in the viewer's tab", () => {
    const opened = openingWindows();
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-popout"));

    expect(window.open).toHaveBeenCalledWith("", "lucida-monitor", expect.stringContaining("popup"));
    const popupDocument = opened[0].document;
    expect(screen.queryByTestId("monitor-dock")).toBeNull();
    expect(screen.queryByTestId("monitor-timeline")).toBeNull();
    expect(document.body.textContent).not.toContain("Verdict");
    const popped = within(popupDocument.body);
    expect(popped.getByTestId("monitor-dock").className).toContain("monitor-dock-popout");
    expect(popped.getByTestId("monitor-timeline")).toBeTruthy();
    expect(popped.getByRole("heading", { name: "Verdict" })).toBeTruthy();
    expect(popped.getByTestId("monitor-phase-table")).toBeTruthy();
    expect(popupDocument.title).toContain("monitor");
    // The dock's controls still work there, through the opener's seam.
    fireEvent.click(popped.getByTestId("monitor-save-run"));
    expect(downloadTraceFile).toHaveBeenCalledWith("trace", "remote-cold");
  });

  it("docks back into the viewer when its window closes, and when asked to", () => {
    const opened = openingWindows();
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-popout"));
    expect(screen.queryByTestId("monitor-dock")).toBeNull();

    act(() => {
      opened[0].close();
    });
    expect(screen.getByTestId("monitor-dock")).toBeTruthy();
    expect(opened[0].document.body.textContent).toBe("");
    expect(opened[0].close).toHaveBeenCalledTimes(1);

    // The person asks to come back: the dock closes the window itself.
    fireEvent.click(screen.getByTestId("monitor-popout"));
    fireEvent.click(within(opened[1].document.body).getByTestId("monitor-dock-back"));
    expect(opened[1].close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("monitor-dock")).toBeTruthy();
  });

  it("says so when the browser blocked the window, and stays in the tab", () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    showing(coldRemoteOpen());

    fireEvent.click(screen.getByTestId("monitor-popout"));

    expect(screen.getByTestId("monitor-popout-failed").textContent).toContain("blocked");
    expect(screen.getByTestId("monitor-dock")).toBeTruthy();
  });

  it("closes its window when the dock unmounts", () => {
    const opened = openingWindows();
    const view = showing(coldRemoteOpen());
    fireEvent.click(screen.getByTestId("monitor-popout"));

    view.unmount();

    expect(opened[0].close).toHaveBeenCalledTimes(1);
  });
});

describe("a run that is still open (#937)", () => {
  it("shows the four progress counters and the phase bar", () => {
    live.value = progress();
    render(<MonitorDock onClose={() => {}} />);

    const counters = screen.getByTestId("monitor-live-counters");
    expect(counters.textContent).toContain("planned");
    expect(counters.textContent).toContain("1,000");
    expect(counters.textContent).toContain("visible");
    expect(counters.textContent).toContain("in flight");
    expect(counters.textContent).toContain("retired");
    expect(screen.getByTestId("monitor-live-bar-wire")).toBeTruthy();
    // Reading is what closes a run, so a page watching one has not read.
    expect(readMonitor).not.toHaveBeenCalled();
  });

  it("renders no verdict while the run is open", () => {
    live.value = progress();
    render(<MonitorDock onClose={() => {}} />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).not.toContain("Verdict");
    expect(screen.queryByTestId(/^monitor-callout-/)).toBeNull();
    expect(screen.queryByTestId("monitor-phase-table")).toBeNull();
    // Nor the exports, which would close the run without saying so.
    expect(screen.queryByTestId("monitor-save-run")).toBeNull();
    expect(screen.queryByTestId("monitor-reread")).toBeNull();
  });

  it("closes the run explicitly on Stop & analyse and shows that run's verdict, no reload", () => {
    live.value = progress();
    read.value = { ok: true, document: diagnoseRun(coldRemoteOpen()) };
    render(<MonitorDock onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("monitor-stop"));

    expect(stopRun).toHaveBeenCalled();
    // The run that was being watched, by id: the export closes a fresh
    // steady-state interval of its own, so "the newest" is the export's
    // artifact rather than the run somebody sat through.
    expect(readMonitor).toHaveBeenCalledWith("run-open");
    expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();
    expect(screen.queryByTestId("monitor-live-counters")).toBeNull();
  });

  it("hands over to the verdict when the run settles on its own, without a reload", () => {
    vi.useFakeTimers();
    try {
      live.value = progress();
      read.value = { ok: true, document: diagnoseRun(coldRemoteOpen()) };
      render(<MonitorDock onClose={() => {}} />);
      expect(screen.getByTestId("monitor-live-counters")).toBeTruthy();

      // The run settles: the recorder closes it, and progress reads null.
      live.value = null;
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(readMonitor).toHaveBeenCalledWith("run-open");
      expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a run that opens later rather than taking the page from a verdict", () => {
    // A second open behind this page is worth knowing about, but switching to
    // it under somebody reading a verdict they asked for would be exactly the
    // auto-following this view exists without.
    vi.useFakeTimers();
    try {
      read.value = { ok: true, document: diagnoseRun(coldRemoteOpen()) };
      render(<MonitorDock onClose={() => {}} />);
      expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();

      live.value = progress({ runId: "run-later" });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      // Still the verdict, plus an offer.
      expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();
      fireEvent.click(screen.getByTestId("monitor-watch-next"));

      expect(screen.getByTestId("monitor-live-counters")).toBeTruthy();
      expect(screen.getByTestId("monitor-run-id").textContent).toBe("run-later");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a provisional reading, labelled provisional, with its top finding and its window (#1057)", () => {
    live.value = progress();
    reading.value = provisional();
    render(<MonitorDock onClose={() => {}} />);

    expect(screen.getByTestId("monitor-provisional-label").textContent).toBe("provisional");
    const statement = screen.getByTestId("monitor-provisional-statement").textContent ?? "";
    expect(statement.startsWith("provisional")).toBe(true);
    expect(statement).toContain("scheduler.admission held 20,000 requests behind a cap of 24");

    const finding = screen.getByTestId("monitor-provisional-finding");
    expect(finding.textContent).toContain("saturated");
    expect(finding.textContent).toContain("scheduler.admission");
    expect(finding.textContent).toContain("queue.backlog");
    expect(finding.textContent).toContain("provisional");

    const facts = screen.getByTestId("monitor-provisional-facts").textContent ?? "";
    expect(facts).toContain("the run so far (4.2 s)");
    expect(facts).toContain("walked none of the 1,000 rows");
    expect(facts).toContain("chunks_in_flight");

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).not.toContain("Verdict");
    expect(screen.queryByTestId(/^monitor-callout-/)).toBeNull();
    // Reading is what closes a run, so the page has not read.
    expect(readMonitor).not.toHaveBeenCalled();
  });

  it("updates the provisional reading on the poll", () => {
    vi.useFakeTimers();
    try {
      live.value = progress();
      reading.value = provisional();
      render(<MonitorDock onClose={() => {}} />);
      expect(screen.getByTestId("monitor-provisional-finding").textContent).toContain("saturated");

      // The backlog drains and in-flight wanders below its peak: the next
      // poll reads a window with nothing over a threshold, and the finding
      // goes with it.
      reading.value = provisional({}, (i) => ({ inFlight: 1 + (i % 3), queueDepth: 0 }));
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(readProvisional).toHaveBeenCalled();
      expect(screen.getByTestId("monitor-provisional-finding").textContent).toContain(
        "No threshold crossed in the window (provisional).",
      );
      expect(screen.getByTestId("monitor-provisional-label").textContent).toBe("provisional");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when no reading has been taken yet rather than showing an empty one", () => {
    live.value = progress();
    render(<MonitorDock onClose={() => {}} />);

    expect(screen.getByTestId("monitor-provisional-empty")).toBeTruthy();
    expect(screen.getByTestId("monitor-provisional-label").textContent).toBe("provisional");
  });

  it("counts from run start rather than following a window", () => {
    // The counters are cumulative, so the first seconds of an open are still
    // on screen minutes later — the prototype's auto-following window scrolled
    // them away before anyone looked.
    vi.useFakeTimers();
    try {
      live.value = progress({ visible: 4, elapsedMs: 900 });
      render(<MonitorDock onClose={() => {}} />);

      live.value = progress({ visible: 950, elapsedMs: 30_000 });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      const counters = screen.getByTestId("monitor-live-counters").textContent ?? "";
      expect(counters).toContain("950");
      expect(screen.getByTestId("monitor-live-status").textContent).toContain("30.0 s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("choosing which run to read", () => {
  it("offers every run the recording still holds, newest first", () => {
    runs.value = [
      { runId: "run-2", datasetCount: 28, cause: "camera_moved", endReason: "timeout", wallMs: 60_000 },
      { runId: "run-1", datasetCount: 28, cause: "loop_start", endReason: "quiescent", wallMs: 4_120 },
    ];
    showing(coldRemoteOpen());

    const options = [...screen.getByTestId("monitor-run-select").querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["run-2", "run-1"]);
    // The newest interval is often the quiet tail rather than the open, so the
    // label has to carry enough to tell them apart without reading each one.
    expect(options[1].textContent).toContain("loop_start");
    expect(options[1].textContent).toContain("quiescent");
  });

  it("reads the run that was chosen rather than always the newest", () => {
    runs.value = [
      { runId: "run-2", datasetCount: 28, cause: "camera_moved", endReason: "timeout", wallMs: 60_000 },
      { runId: "run-1", datasetCount: 28, cause: "loop_start", endReason: "quiescent", wallMs: 4_120 },
    ];
    showing(coldRemoteOpen());

    fireEvent.change(screen.getByTestId("monitor-run-select"), { target: { value: "run-1" } });

    expect(readMonitor).toHaveBeenLastCalledWith("run-1");
  });
});

describe("it ships in production builds", () => {
  it("gates nothing on the build mode, on the page or on the route into it", async () => {
    // ADR 0051: a diagnostic that only exists in development cannot explain a
    // field report, and shipping the agent surface to production while
    // withholding the human one is the asymmetry surface parity forbids. This
    // is a source check because the failure it guards against is a one-line
    // `import.meta.env.DEV` that no rendered test would catch — the test
    // environment is itself a dev build.
    const { readFile } = await import("node:fs/promises");
    const sources = await Promise.all(
      [
        "monitor/MonitorDock.tsx",
        "monitor/MonitorReport.tsx",
        "monitor/LiveReport.tsx",
        "monitor/TimelineCanvas.tsx",
        "monitor/timelineDraw.ts",
        "monitor/monitorModel.ts",
        "monitor/monitorSource.ts",
      // Paths from the vitest root (`lucida-web`): happy-dom replaces the
      // global `URL`, so a file:// URL never reaches `readFile` intact here.
      ].map((path) => readFile(`${process.cwd()}/src/${path}`, "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/import\.meta\.env\.(DEV|MODE|PROD)/);
    }
  });
});
