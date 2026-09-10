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
import { readFileSync } from "node:fs";
import { diagnoseRun } from "../trace/diagnose/diagnose.ts";
import {
  coldRemoteOpen,
  healthyLocalOpen,
  makeDocument,
  makeHeader,
  makeReading,
  makeReadingSeries,
  makeRun,
  makeTick,
  saturatedReopen,
} from "../trace/diagnose/fixtures.ts";
import { installTraceSeam } from "../trace/seam.ts";
import type { TraceDocument } from "../trace/types.ts";
import { deriveProvisional, type ProvisionalReading } from "../trace/diagnose/provisional.ts";
import {
  deriveLiveTimeline,
  TIMELINE_CHARTS,
  type LiveTimeline,
} from "../trace/diagnose/timeline.ts";
import { PHASES, type TraceReading, type TraceRun } from "../trace/types.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import type { MonitorRead, MonitorRunSummary } from "./monitorSource.ts";

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
const trace = vi.hoisted(() => ({ value: null as unknown }));
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

// The reads of this page's recording are stood in for. Reading a dropped
// file and comparing two runs touch no recorder, so they run as they are.
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
  return render(<MonitorDock onClose={() => {}} />);
}

function goldenBundleFile(name = "lucida-local-healthy.bundle.json"): File {
  const text = readFileSync(`${process.cwd()}/../trace-fixtures/bundle-v1.json`, "utf8");
  return new File([text], name, { type: "application/json" });
}

function savedRunFile(document: TraceDocument, name: string): File {
  return new File([JSON.stringify(document)], name, { type: "application/json" });
}

function drop(target: HTMLElement, files: File[]): void {
  fireEvent.drop(target, { dataTransfer: { files } });
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
    // changes what the pipeline does. Opening a file and comparing two runs
    // read documents that are not this page's. If a future change adds a
    // control that does not fit that list, this is where it shows up.
    const labels = screen.getAllByRole("button").map((node) => node.textContent);
    for (const label of labels) {
      expect(label).toMatch(
        /^(Close|Pop out|Read the newest run|Save run|Save for Perfetto|Save bundle|Send report|Start a watch stream|Show the rows behind .*|Close drill-down|Open a run or bundle|Compare two runs|Leave compare mode|Choose a file|Use the run on screen|Back to this page’s runs)$/,
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

describe("a dropped file (#1066)", () => {
  it("reads a dropped bundle at every depth a live run is read, with its settled frame beside the report", async () => {
    showing(coldRemoteOpen());
    readMonitor.mockClear();

    drop(screen.getByTestId("monitor-dock"), [goldenBundleFile()]);

    const file = await screen.findByTestId("monitor-file");
    expect(screen.getByTestId("monitor-run-id").textContent).toBe("local-healthy");
    const headings = within(file).getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings.slice(0, 3)).toEqual(["Verdict", "Phases", "Critical path"]);
    expect(headings[headings.length - 1]).toBe("Run");
    expect(within(file).getByTestId("monitor-banner-coverage")).toBeTruthy();
    expect(within(file).getByTestId("monitor-timeline")).toBeTruthy();
    expect(within(file).getByTestId("monitor-phase-table").textContent).toContain("browser.wire");
    expect(within(file).getAllByTestId("monitor-callout-verdict")).toHaveLength(1);
    // The frame at its CSS size, not its device size.
    const frame = within(file).getByTestId("monitor-frame");
    const image = frame.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(image.getAttribute("width")).toBe("1440");
    expect(image.getAttribute("height")).toBe("900");
    expect(frame.textContent).toContain("2880×1800 device pixels at ratio 2");
    expect(frame.textContent).toContain("captured by the page");
    expect(file.className).toContain("monitor-file-with-frame");
    expect(readMonitor).not.toHaveBeenCalled();
    expect(screen.queryByTestId("monitor-save-run")).toBeNull();
    expect(screen.queryByTestId("monitor-send-report")).toBeNull();
    expect(screen.getByText(/Reading lucida-local-healthy\.bundle\.json, a bundle/)).toBeTruthy();

    // Back to the page's own run, which the dock still holds: no re-read.
    fireEvent.click(screen.getByTestId("monitor-close-file"));
    expect(screen.queryByTestId("monitor-file")).toBeNull();
    expect(screen.getByTestId("monitor-run-id").textContent).toBe("remote-cold");
    expect(screen.getByTestId("monitor-save-run")).toBeTruthy();
    expect(readMonitor).not.toHaveBeenCalled();
  });

  it("reads a saved run about its newest run and offers the others", async () => {
    showing(coldRemoteOpen());
    const document = makeDocument([healthyLocalOpen(), coldRemoteOpen()]);

    drop(screen.getByTestId("monitor-dock"), [savedRunFile(document, "lucida-remote-cold.trace.json")]);

    await screen.findByTestId("monitor-file");
    expect(screen.getByTestId("monitor-run-id").textContent).toBe("remote-cold");
    expect(screen.queryByTestId("monitor-frame")).toBeNull();
    const options = [...screen.getByTestId("monitor-run-select").querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["remote-cold", "local-healthy"]);

    fireEvent.change(screen.getByTestId("monitor-run-select"), { target: { value: "local-healthy" } });

    expect(screen.getByTestId("monitor-run-id").textContent).toBe("local-healthy");
    expect(readMonitor).toHaveBeenCalledTimes(1);
  });

  it("says why a file could not be read, by name, and keeps the report", async () => {
    showing(coldRemoteOpen());

    drop(screen.getByTestId("monitor-dock"), [new File(["{}"], "notes.json", { type: "application/json" })]);

    const failed = await screen.findByTestId("monitor-file-failed");
    expect(failed.textContent).toContain("notes.json is not a lucida trace bundle, run file, or saved run");
    expect(screen.queryByTestId("monitor-file")).toBeNull();
    expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();
  });

  it("shows a dropped file while a run is open without closing the run, and goes back to watching it", async () => {
    live.value = progress();
    render(<MonitorDock onClose={() => {}} />);

    drop(screen.getByTestId("monitor-dock"), [goldenBundleFile()]);

    await screen.findByTestId("monitor-file");
    expect(screen.queryByTestId("monitor-live-counters")).toBeNull();
    expect(stopRun).not.toHaveBeenCalled();
    expect(readMonitor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("monitor-close-file"));

    expect(screen.getByTestId("monitor-live-counters")).toBeTruthy();
    expect(readMonitor).not.toHaveBeenCalled();
  });

  it("opens a file from the picker as well as from a drop", async () => {
    showing(coldRemoteOpen());
    const input = screen.getByTestId("monitor-file-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByTestId("monitor-open-file"));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [goldenBundleFile()] } });

    await screen.findByTestId("monitor-file");
    expect(screen.getByTestId("monitor-run-id").textContent).toBe("local-healthy");
  });
});

describe("compare mode (#1066)", () => {
  /** A run at ratio 1 on a 1440 by 900 window, which the golden bundle's retina header is incomparable with. */
  function lowRatioDocument(): TraceDocument {
    return makeDocument([
      makeRun({
        header: {
          runId: "low-ratio",
          durationUs: 400_000,
          devicePixelRatio: 1,
          viewport: { cssWidth: 1440, cssHeight: 900, deviceWidth: 1440, deviceHeight: 900 },
        },
      }),
    ]);
  }

  it("takes two files dropped at once as a comparison, and shows the diff lucida trace diff prints", async () => {
    const seam = installTraceSeam();
    // A retina window, so each canvas backs its store at twice its CSS size.
    const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    showing(healthyLocalOpen());

    drop(screen.getByTestId("monitor-dock"), [
      goldenBundleFile("baseline.bundle.json"),
      savedRunFile(makeDocument([coldRemoteOpen()]), "candidate.trace.json"),
    ]);

    const compare = await screen.findByTestId("monitor-compare");
    if (ratio) Object.defineProperty(window, "devicePixelRatio", ratio);
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    expect(screen.getByTestId("monitor-run-id").textContent).toBe("local-healthy vs remote-cold");
    expect(screen.getByTestId("monitor-compare-slot-left-name").textContent).toContain("baseline.bundle.json");
    expect(screen.getByTestId("monitor-compare-slot-right-name").textContent).toContain("candidate.trace.json");
    const timelines = within(screen.getByTestId("monitor-compare-timelines")).getAllByTestId(
      "monitor-timeline-canvas",
    ) as HTMLCanvasElement[];
    expect(timelines).toHaveLength(2);
    expect(timelines[0].style.width).toBe(timelines[1].style.width);
    for (const canvas of timelines) {
      expect(canvas.width).toBe(Math.round(parseFloat(canvas.style.width) * 2));
    }
    expect(within(compare).getByTestId("monitor-compare-header").textContent).toContain("devicePixelRatio");
    expect(within(compare).getByTestId("monitor-compare-phases").textContent).toContain("browser.wire");
    expect(within(compare).getByTestId("monitor-compare-findings").textContent).toContain("right");
    expect(within(compare).getByTestId("monitor-compare-wall").textContent).toContain("330 → 4120 ms");
    expect(screen.queryByTestId("monitor-compare-warning")).toBeNull();
    // The text is the seam's own rendering, which is what the CLI prints.
    const { readArtifactFile, compareSideFor } = await vi.importActual<typeof import("./monitorSource.ts")>("./monitorSource.ts");
    const left = readArtifactFile(await goldenBundleFile("baseline.bundle.json").text(), "baseline.bundle.json");
    const right = readArtifactFile(JSON.stringify(makeDocument([coldRemoteOpen()])), "candidate.trace.json");
    expect(within(compare).getByTestId("monitor-compare-text").textContent).toBe(
      seam.compareTracesText(compareSideFor(left), compareSideFor(right)),
    );
    expect(within(compare).getByTestId("monitor-compare-text").textContent).toContain(
      "lucida trace diff local-healthy remote-cold",
    );
  });

  it("leads with the warning when the headers make the runs incomparable", async () => {
    showing(healthyLocalOpen());

    drop(screen.getByTestId("monitor-dock"), [
      goldenBundleFile("retina.bundle.json"),
      savedRunFile(lowRatioDocument(), "low.trace.json"),
    ]);

    const warning = await screen.findByTestId("monitor-compare-warning");
    expect(warning.textContent).toContain("Not comparable");
    expect(warning.textContent).toContain("device pixel ratio 2 vs 1");
    // The warning precedes the timelines: bit 4 is DOCUMENT_POSITION_FOLLOWING.
    expect(warning.compareDocumentPosition(screen.getByTestId("monitor-compare-timelines")) & 4).toBeTruthy();
    const header = screen.getByTestId("monitor-compare-header");
    const ratioRow = [...header.querySelectorAll("tr")].find((row) => row.textContent?.includes("devicePixelRatio"))!;
    expect(ratioRow.className).toBe("monitor-row-incomparable");
    expect(ratioRow.textContent).toContain("incomparable");
    const text = screen.getByTestId("monitor-compare-text").textContent ?? "";
    expect(text).toContain("NOT COMPARABLE");
  });

  it("enters from the header with the shown file on the left, and takes the run on screen on the right", async () => {
    const document = makeDocument([coldRemoteOpen()]);
    trace.value = document;
    showing(coldRemoteOpen());
    drop(screen.getByTestId("monitor-dock"), [goldenBundleFile("baseline.bundle.json")]);
    await screen.findByTestId("monitor-file");

    fireEvent.click(screen.getByTestId("monitor-compare-runs"));

    expect(screen.getByTestId("monitor-compare-slot-left-name").textContent).toContain("baseline.bundle.json");
    expect(screen.getByTestId("monitor-compare-waiting")).toBeTruthy();
    expect(screen.queryByTestId("monitor-compare")).toBeNull();

    fireEvent.click(screen.getByTestId("monitor-compare-use-page-right"));

    expect(screen.getByTestId("monitor-compare-slot-right-name").textContent).toContain("this page");
    expect(screen.getByTestId("monitor-compare-right").textContent).toContain("this page (remote-cold)");
    expect(screen.getByTestId("monitor-compare")).toBeTruthy();
    // Nothing was exported to offer the page's run: the dock already held it.
    expect(readMonitor).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("monitor-leave-compare"));
    expect(screen.getByTestId("monitor-file")).toBeTruthy();
    expect(screen.queryByTestId("monitor-compare-mode")).toBeNull();
  });

  it("fills the slot a file is dropped on, and the first empty slot otherwise", async () => {
    showing(healthyLocalOpen());
    fireEvent.click(screen.getByTestId("monitor-compare-runs"));

    drop(screen.getByTestId("monitor-compare-slot-right"), [savedRunFile(makeDocument([coldRemoteOpen()]), "right.trace.json")]);
    await screen.findByTestId("monitor-compare-slot-right-name");
    expect(screen.queryByTestId("monitor-compare-slot-left-name")).toBeNull();

    drop(screen.getByTestId("monitor-dock"), [goldenBundleFile("left.bundle.json")]);
    await screen.findByTestId("monitor-compare-slot-left-name");

    expect(screen.getByTestId("monitor-compare-slot-left-name").textContent).toContain("left.bundle.json");
    expect(screen.getByTestId("monitor-compare-slot-right-name").textContent).toContain("right.trace.json");
    expect(screen.getByTestId("monitor-compare")).toBeTruthy();
  });

  it("compares the run chosen on a side when a document holds several", async () => {
    showing(healthyLocalOpen());
    const both = makeDocument([healthyLocalOpen(), coldRemoteOpen()]);

    drop(screen.getByTestId("monitor-dock"), [
      savedRunFile(both, "left.trace.json"),
      savedRunFile(both, "right.trace.json"),
    ]);
    await screen.findByTestId("monitor-compare");
    expect(screen.getByTestId("monitor-compare-wall").textContent).toContain("4120 → 4120 ms");

    fireEvent.change(screen.getByTestId("monitor-compare-run-left"), { target: { value: "local-healthy" } });

    expect(screen.getByTestId("monitor-run-id").textContent).toBe("local-healthy vs remote-cold");
    expect(screen.getByTestId("monitor-compare-wall").textContent).toContain("330 → 4120 ms");
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
        "monitor/LoadedReport.tsx",
        "monitor/CompareView.tsx",
        "monitor/CompareSlotView.tsx",
        "monitor/TimelineCanvas.tsx",
        "monitor/timelineDraw.ts",
        "monitor/monitorModel.ts",
        "monitor/monitorSource.ts",
        "trace/artifact.ts",
      // Paths from the vitest root (`lucida-web`): happy-dom replaces the
      // global `URL`, so a file:// URL never reaches `readFile` intact here.
      ].map((path) => readFile(`${process.cwd()}/src/${path}`, "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/import\.meta\.env\.(DEV|MODE|PROD)/);
    }
  });
});
