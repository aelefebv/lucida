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
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { diagnoseRun } from "../trace/diagnose/diagnose.ts";
import { coldRemoteOpen, healthyLocalOpen, saturatedReopen } from "../trace/diagnose/fixtures.ts";
import type { TraceRun } from "../trace/types.ts";
import type { MonitorRead, MonitorRunSummary } from "./monitorSource.ts";

const read = vi.hoisted(() => ({ value: null as MonitorRead | null }));
const runs = vi.hoisted(() => ({ value: [] as MonitorRunSummary[] }));
const downloadTraceFile = vi.hoisted(() => vi.fn(() => "lucida-run-1.trace.json"));
const readMonitor = vi.hoisted(() => vi.fn(() => ({ read: read.value, runs: runs.value })));

vi.mock("./monitorSource.ts", () => ({ readMonitor, downloadTraceFile }));

const { MonitorPage } = await import("./MonitorPage.tsx");

function showing(run: TraceRun) {
  read.value = { ok: true, document: diagnoseRun(run) };
  return render(<MonitorPage onClose={() => {}} />);
}

beforeEach(() => {
  downloadTraceFile.mockClear();
  readMonitor.mockClear();
  runs.value = [];
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
