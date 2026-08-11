// @vitest-environment happy-dom

/**
 * The page, over the derivation's fixture runs.
 *
 * The document these render is the same object the agent surface renders, so
 * these cases are about *ordering and reachability* — what leads, what a click
 * carries — and never about a threshold. A test here that asserted a verdict
 * would be asserting the derivation through two layers of DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { diagnoseRun } from "../trace/diagnose/diagnose.ts";
import { coldRemoteOpen, healthyLocalOpen, saturatedReopen } from "../trace/diagnose/fixtures.ts";
import { PHASES, type TraceRun } from "../trace/types.ts";
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

const read = vi.hoisted(() => ({ value: null as MonitorRead | null }));
const runs = vi.hoisted(() => ({ value: [] as MonitorRunSummary[] }));
const live = vi.hoisted(() => ({ value: null as unknown }));
const downloadTraceFile = vi.hoisted(() => vi.fn(() => "lucida-run-1.trace.json"));
const readMonitor = vi.hoisted(() => vi.fn(() => ({ read: read.value, runs: runs.value })));
const readProgress = vi.hoisted(() => vi.fn(() => live.value));
const stopRun = vi.hoisted(() => vi.fn(() => { live.value = null; }));

vi.mock("./monitorSource.ts", () => ({ readMonitor, downloadTraceFile, readProgress, stopRun }));

const { MonitorPage } = await import("./MonitorPage.tsx");

function showing(run: TraceRun) {
  read.value = { ok: true, document: diagnoseRun(run) };
  return render(<MonitorPage onClose={() => {}} />);
}

beforeEach(() => {
  downloadTraceFile.mockClear();
  readMonitor.mockClear();
  readProgress.mockClear();
  stopRun.mockClear();
  runs.value = [];
  live.value = null;
});

afterEach(cleanup);

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
});

describe("nothing recorded yet", () => {
  it("says so instead of rendering an empty report", () => {
    read.value = { ok: false, reason: "no run (newest) in this trace document" };
    render(<MonitorPage onClose={() => {}} />);

    expect(screen.getByTestId("monitor-empty").textContent).toContain("no run");
    expect(screen.queryByTestId("monitor-phase-table")).toBeNull();
    expect(screen.getByTestId("monitor-save-run")).toHaveProperty("disabled", true);
  });
});

describe("observation only", () => {
  it("offers no control that could change what the pipeline does", () => {
    showing(coldRemoteOpen());

    // Every button on the page reads, saves, drills in or leaves. If a future
    // change adds one that does not, this list is where it shows up.
    const labels = screen.getAllByRole("button").map((node) => node.textContent);
    for (const label of labels) {
      expect(label).toMatch(/^(Back|Read the newest run|Save run|Save for Perfetto|Show the rows behind .*|Close drill-down)$/);
    }
  });

  it("adds only one control while a run is open, and it ends the run rather than the work", () => {
    // *Stop & analyse* closes the recording's interval. The pipeline goes on
    // doing exactly what it was doing — what ends is the run's label, which is
    // what makes it readable.
    live.value = progress();
    render(<MonitorPage onClose={() => {}} />);

    const labels = screen.getAllByRole("button").map((node) => node.textContent);
    expect(labels).toEqual(["Back", "Stop & analyse"]);
  });
});

describe("a run that is still open (#937)", () => {
  it("shows the four progress counters and the phase bar", () => {
    live.value = progress();
    render(<MonitorPage onClose={() => {}} />);

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
    render(<MonitorPage onClose={() => {}} />);

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
    render(<MonitorPage onClose={() => {}} />);

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
      render(<MonitorPage onClose={() => {}} />);
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
      render(<MonitorPage onClose={() => {}} />);
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

  it("counts from run start rather than following a window", () => {
    // The counters are cumulative, so the first seconds of an open are still
    // on screen minutes later — the prototype's auto-following window scrolled
    // them away before anyone looked.
    vi.useFakeTimers();
    try {
      live.value = progress({ visible: 4, elapsedMs: 900 });
      render(<MonitorPage onClose={() => {}} />);

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
        "monitor/MonitorPage.tsx",
        "monitor/monitorModel.ts",
        "monitor/monitorSource.ts",
        "WorkspaceRoot.tsx",
      // Paths from the vitest root (`lucida-web`): happy-dom replaces the
      // global `URL`, so a file:// URL never reaches `readFile` intact here.
      ].map((path) => readFile(`${process.cwd()}/src/${path}`, "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/import\.meta\.env\.(DEV|MODE|PROD)/);
    }
  });
});
