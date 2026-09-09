/**
 * The dock: the monitor's home inside the viewer.
 *
 * A resizable panel pinned to the bottom of the viewer, with a popout to a
 * second window. It replaced the separate monitor route so that nobody
 * leaves the picture to read about the picture: the timeline sits over the
 * canvas it describes, and on two screens the popout puts both at full size.
 *
 * It overlays the canvas rather than shrinking it. Resizing the canvas
 * re-plans the view and opens a run, so a dock that pushed the canvas up
 * would perturb the run somebody opened it to watch; laid over the pixels,
 * opening it changes nothing the recorder sees.
 *
 * The popout is a portal, not a second page. The React tree stays in the
 * opener, so everything the dock reads goes through the opener's trace seam
 * and the opener's recorder, and the tab draws nothing of the dock while it
 * is popped out. Closing the window docks it back.
 *
 * It ships in production builds. A diagnostic that only exists in
 * development cannot explain a field report, and shipping the agent surface
 * to production while withholding the human one is exactly the asymmetry
 * surface parity forbids (ADR 0051, ADR 0052).
 *
 * **Observation only.** Every control here reads, saves, drills in, or moves
 * the dock. None of them changes what the pipeline does.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./MonitorDock.css";
import { LiveReport } from "./LiveReport.tsx";
import { buildLiveView, buildProvisionalView } from "./liveModel.ts";
import { buildMonitorView, formatMs, type MonitorDrill } from "./monitorModel.ts";
import { MonitorReport } from "./MonitorReport.tsx";
import {
  downloadBundle,
  downloadTraceFile,
  readLiveTimeline,
  readMonitor,
  readProgress,
  readProvisional,
  stopRun,
  type MonitorSnapshot,
} from "./monitorSource.ts";
import { TimelineCanvas } from "./TimelineCanvas.tsx";
import type { LiveProgress } from "../trace/liveProgress.ts";
import type { ProvisionalReading } from "../trace/diagnose/provisional.ts";
import type { LiveTimeline } from "../trace/diagnose/timeline.ts";

export interface MonitorDockProps {
  /** Close the dock. The toolbar that opened it is the caller's business. */
  onClose: () => void;
  /** Where the dock's left edge sits, in CSS pixels: past the sidebar, over the canvas. */
  insetLeft?: number;
}

/**
 * How often the live view re-reads the run.
 *
 * Not a frame cadence. The counters move in thousands and the charts change
 * shape in tenths of a second, so twice a second is as fast as a reader can
 * use. Every read is a copy of the recorder's counters and the window's
 * per-tick tiers, and walks no row, so the cadence is set by the reader
 * rather than by the cost.
 */
const LIVE_POLL_MS = 500;

const HEIGHT_KEY = "monitor.dock.height";
const MIN_HEIGHT_PX = 160;
/** Room left for the toolbar above a dock dragged to its tallest. */
const TOP_MARGIN_PX = 96;
const DEFAULT_HEIGHT_SHARE = 0.45;

export function MonitorDock({ onClose, insetLeft = 0 }: MonitorDockProps) {
  // A run that is still open is watched, not read: reading closes the
  // interval, and what somebody opened the dock to see is still happening.
  const [live, setLive] = useState<LiveProgress | null>(readProgress);
  // The provisional reading and the live charts over the same run, taken on
  // the same poll, so the statement, the counters and the picture describe
  // one instant.
  const [reading, setReading] = useState<ProvisionalReading | null>(() =>
    live ? readProvisional() : null,
  );
  const [liveTimeline, setLiveTimeline] = useState<LiveTimeline | null>(() =>
    live ? readLiveTimeline() : null,
  );
  // Reading is what closes the run in progress, so the dock does it once on
  // mount and once per control, not twice for one answer, and not at all
  // while a run is open.
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(() =>
    live ? null : readMonitor(),
  );
  const [drill, setDrill] = useState<MonitorDrill | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The bundle is the one save that takes time. The seam asks the server for
  // its health and the render worker for the frame before it exports. A
  // failure shows where the file name would have been.
  const [bundling, setBundling] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const read = snapshot?.read;
  const runs = snapshot?.runs ?? [];
  const runId = read?.ok ? read.document.runId : undefined;

  // Read one run and show it. The only path from watching to reading, so the
  // two states cannot both be on screen.
  const readRun = useCallback((next?: string) => {
    setDrill(null);
    setSaved(null);
    setLive(null);
    setReading(null);
    setLiveTimeline(null);
    setSnapshot(readMonitor(next));
  }, []);

  // Watch the run until it ends, by going quiescent, by timing out, or
  // because somebody stopped it. Whichever way it ends, the verdict for that
  // run replaces the live view where it stood: no reload, and no reading of
  // the newest interval, which by then is the export's own.
  const watchedRunId = live?.runId ?? null;
  useEffect(() => {
    if (watchedRunId === null) return;
    const timer = setInterval(() => {
      const next = readProgress();
      if (next && next.runId === watchedRunId) {
        setLive(next);
        setReading(readProvisional());
        setLiveTimeline(readLiveTimeline());
      } else {
        readRun(watchedRunId);
      }
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [watchedRunId, readRun]);

  // A run that opens while a verdict is on screen: a second dataset opened
  // in the viewer, or a camera move. It is offered rather than taken.
  // Switching the dock out from under somebody reading a verdict they asked
  // for would be the auto-following this view exists without.
  const [nextRunId, setNextRunId] = useState<string | null>(null);
  useEffect(() => {
    if (watchedRunId !== null) return;
    const timer = setInterval(() => setNextRunId(readProgress()?.runId ?? null), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [watchedRunId]);

  const watchNextRun = useCallback(() => {
    setDrill(null);
    setSaved(null);
    setLive(readProgress());
    setReading(readProvisional());
    setLiveTimeline(readLiveTimeline());
  }, []);

  const stopAndAnalyse = useCallback(() => {
    stopRun();
    readRun(watchedRunId ?? undefined);
  }, [readRun, watchedRunId]);

  // Named for the run on screen, so the file and the follow-up command that
  // names that run agree.
  const save = useCallback(
    (kind: "trace" | "perfetto") => {
      setSaveFailed(null);
      setSaved(downloadTraceFile(kind, runId));
    },
    [runId],
  );

  const saveBundle = useCallback(() => {
    setSaved(null);
    setSaveFailed(null);
    setBundling(true);
    downloadBundle(runId)
      .then(setSaved)
      .catch((error: unknown) =>
        setSaveFailed(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBundling(false));
  }, [runId]);

  const { height, startResize } = useDockHeight();
  const { popout, popOut, dockBack, popoutFailed } = usePopout();

  // The timeline renders inside whichever report is on screen, after the
  // coverage and truncation that qualify it: a chart is read after its
  // denominator.
  const timeline = live ? (
    liveTimeline ? <TimelineCanvas section={liveTimeline.timeline} provisional /> : null
  ) : read?.ok ? (
    <TimelineCanvas section={read.document.timeline} provisional={false} />
  ) : null;

  const body = (
    <>
      <header className="monitor-chrome">
        <h1>Pipeline monitor</h1>
        <span className="monitor-run-id" data-testid="monitor-run-id">
          {live?.runId ?? runId ?? "no run"}
        </span>
        <div className="monitor-chrome-actions">
          {/* While a run is open the only reading control offered is the one
              that ends it. Every other read here exports, and exporting would
              close the run being watched without saying that is what it did. */}
          {live && (
            <button type="button" onClick={stopAndAnalyse} data-testid="monitor-stop">
              Stop &amp; analyse
            </button>
          )}
          {!live && runs.length > 0 && (
            <select
              aria-label="Run"
              data-testid="monitor-run-select"
              value={runId ?? ""}
              onChange={(event) => readRun(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.cause} · {run.datasetCount} dataset(s) · {formatMs(run.wallMs)} · {run.endReason}
                </option>
              ))}
            </select>
          )}
          {!live && (
            <>
              <button type="button" onClick={() => readRun()} data-testid="monitor-reread">
                Read the newest run
              </button>
              <button
                type="button"
                onClick={() => save("trace")}
                disabled={!read?.ok}
                data-testid="monitor-save-run"
              >
                Save run
              </button>
              <button
                type="button"
                onClick={() => save("perfetto")}
                disabled={!read?.ok}
                data-testid="monitor-save-perfetto"
              >
                Save for Perfetto
              </button>
              <button
                type="button"
                onClick={saveBundle}
                disabled={!read?.ok || bundling}
                data-testid="monitor-save-bundle"
              >
                {bundling ? "Saving bundle…" : "Save bundle"}
              </button>
            </>
          )}
          {popout ? (
            <button type="button" onClick={dockBack} data-testid="monitor-dock-back">
              Return to the viewer
            </button>
          ) : (
            <button type="button" onClick={popOut} data-testid="monitor-popout">
              Pop out
            </button>
          )}
          <button type="button" onClick={onClose} data-testid="monitor-close">
            Close
          </button>
        </div>
      </header>

      <p className="monitor-observation-only">
        Observation only — nothing in the dock changes what the pipeline does.{" "}
        {live
          ? "This run is still open, so it is being watched rather than read: reading would close it, which is why saving and choosing another run are not offered until it ends. Watching reads the recorder's own counters and the last seconds of per-tick readings twice a second, and walks none of the run's rows."
          : "Opening the dock reads the recording, and reading closes the run in progress: an interval has to end before it can be analysed."}
      </p>

      {popoutFailed && (
        <p className="monitor-save-failed" data-testid="monitor-popout-failed">
          {popoutFailed}
        </p>
      )}

      {!live && nextRunId && (
        <p className="monitor-note" data-testid="monitor-next-run">
          A run is open in the viewer.{" "}
          <button type="button" onClick={watchNextRun} data-testid="monitor-watch-next">
            Watch the run in progress
          </button>
        </p>
      )}

      {saved && (
        <p className="monitor-saved" data-testid="monitor-saved">
          Saved {saved}
        </p>
      )}
      {saveFailed && (
        <p className="monitor-save-failed" data-testid="monitor-save-failed">
          Could not save the bundle: {saveFailed}
        </p>
      )}

      {live ? (
        <LiveReport
          view={buildLiveView(live)}
          reading={reading ? buildProvisionalView(reading) : null}
          timeline={timeline}
        />
      ) : read?.ok ? (
        <MonitorReport
          view={buildMonitorView(read.document)}
          drill={drill}
          onDrill={setDrill}
          timeline={timeline}
        />
      ) : (
        <p className="monitor-empty" data-testid="monitor-empty">
          {read?.reason} Open a dataset, let it reach quiescence, then read the run.
        </p>
      )}
    </>
  );

  if (popout) {
    return createPortal(
      <section className="monitor-dock monitor-dock-popout" aria-label="Pipeline monitor" data-testid="monitor-dock">
        {body}
      </section>,
      popout.document.body,
    );
  }

  return (
    <aside
      className="monitor-dock"
      style={{ height, left: insetLeft }}
      aria-label="Pipeline monitor"
      data-testid="monitor-dock"
    >
      <div
        className="monitor-dock-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the monitor"
        data-testid="monitor-dock-resize"
        onPointerDown={startResize}
      />
      <div className="monitor-dock-body">{body}</div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The dock's height
// ---------------------------------------------------------------------------

function initialHeight(): number {
  const view = typeof window === "undefined" ? null : window;
  const viewportHeight = view?.innerHeight || 800;
  let stored: number | null = null;
  try {
    const raw = view?.localStorage?.getItem(HEIGHT_KEY);
    stored = raw === null || raw === undefined ? null : Number(raw);
  } catch {
    stored = null;
  }
  const wanted = stored !== null && Number.isFinite(stored) ? stored : viewportHeight * DEFAULT_HEIGHT_SHARE;
  return clampHeight(wanted, viewportHeight);
}

function clampHeight(height: number, viewportHeight: number): number {
  return Math.round(Math.min(Math.max(MIN_HEIGHT_PX, viewportHeight - TOP_MARGIN_PX), Math.max(MIN_HEIGHT_PX, height)));
}

function useDockHeight() {
  const [height, setHeight] = useState(initialHeight);

  useEffect(() => {
    try {
      window.localStorage?.setItem(HEIGHT_KEY, String(height));
    } catch {
      // Storage can be unavailable or full; the height then lasts the session.
    }
  }, [height]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const doc = event.currentTarget.ownerDocument;
      const view = doc.defaultView;
      const startY = event.clientY;
      const startHeight = height;
      const onMove = (move: PointerEvent): void => {
        setHeight(clampHeight(startHeight + (startY - move.clientY), view?.innerHeight || 800));
      };
      const onUp = (): void => {
        doc.removeEventListener("pointermove", onMove);
        doc.removeEventListener("pointerup", onUp);
      };
      doc.addEventListener("pointermove", onMove);
      doc.addEventListener("pointerup", onUp);
    },
    [height],
  );

  return { height, startResize };
}

// ---------------------------------------------------------------------------
// The popout
// ---------------------------------------------------------------------------

const POPOUT_NAME = "lucida-monitor";
const POPOUT_FEATURES = "popup=yes,width=1180,height=760";

function usePopout() {
  const [popout, setPopout] = useState<Window | null>(null);
  const [popoutFailed, setPopoutFailed] = useState<string | null>(null);

  const popOut = useCallback(() => {
    setPopoutFailed(null);
    const opened = window.open("", POPOUT_NAME, POPOUT_FEATURES);
    if (!opened) {
      setPopoutFailed("The browser blocked the monitor's window. Allow popups for this site to pop the dock out.");
      return;
    }
    adoptStyles(window.document, opened.document);
    setPopout(opened);
  }, []);

  const dockBack = useCallback(() => setPopout(null), []);

  // A window that outlived the tree rendering into it would be blank, so
  // giving it up, by docking back or by unmounting, closes it.
  useEffect(() => {
    if (!popout) return;
    const back = (): void => setPopout(null);
    popout.addEventListener("pagehide", back);
    return () => {
      popout.removeEventListener("pagehide", back);
      if (!popout.closed) popout.close();
    };
  }, [popout]);

  return { popout, popOut, dockBack, popoutFailed };
}

function adoptStyles(from: Document, into: Document): void {
  const head = into.head;
  while (head.firstChild) head.removeChild(head.firstChild);
  for (const node of from.querySelectorAll('style, link[rel="stylesheet"]')) {
    head.appendChild(node.cloneNode(true));
  }
  into.title = "lucida — pipeline monitor";
  into.body.className = "monitor-popout-body";
}
