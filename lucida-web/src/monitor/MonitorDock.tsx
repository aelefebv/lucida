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
 * **Observation only.** Every control here reads, saves, sends, drills in, or
 * moves the dock. None of them changes what the pipeline does. *Send report*
 * is the one that leaves the page, and it copies the run to the workspace
 * inbox rather than touching the run: it happens when somebody presses it,
 * never on a run's close and never on a schedule (ADR 0049 as amended).
 *
 * **The brush.** A window brushed on the axis scopes the report beneath it
 * through the derivation's own window, the same call the CLI's window flag
 * makes, and publishes the chunk set that was in the window so the overlays
 * highlight it. The dock publishes and the overlay subscribes. Neither reads
 * the other (ADR 0052 as amended). Clearing the brush restores the whole-run
 * report and clears the set, and so does reading another run, showing a
 * file, or closing the dock.
 *
 * The dock is also a drop target (#1066). A saved run, the trace driver's
 * run file, or a bundle dropped anywhere on it is read with the checks the
 * CLI's reader makes and shown in place of this page's report, at every
 * depth a live run is read, with a bundle's settled frame beside it.
 * Compare mode takes two of them, or one and the run on screen, and shows
 * the diff `lucida trace diff` prints, from the same function.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./MonitorDock.css";
import { CompareSlotView, RunOption, type CompareSlot } from "./CompareSlotView.tsx";
import { CompareView } from "./CompareView.tsx";
import { LiveReport } from "./LiveReport.tsx";
import { buildLiveView, buildProvisionalView } from "./liveModel.ts";
import { LoadedReport } from "./LoadedReport.tsx";
import { buildMonitorView, type MonitorDrill } from "./monitorModel.ts";
import { MonitorReport } from "./MonitorReport.tsx";
import {
  compareLoaded,
  describeArtifact,
  downloadBundle,
  downloadTraceFile,
  loadArtifact,
  pageArtifact,
  readLiveTimeline,
  readMonitor,
  readProgress,
  readProvisional,
  readWindow,
  rereadLoaded,
  sendReport,
  stopRun,
  type LoadedArtifact,
  type MonitorSnapshot,
  type WindowedRead,
} from "./monitorSource.ts";
import type { InboxReceipt } from "../bridge.ts";
import { trackPointerDrag } from "./pointerDrag.ts";
import { TimelineCanvas } from "./TimelineCanvas.tsx";
import { WatchToggle } from "./WatchToggle.tsx";
import { publishChunkSelection } from "../trace/linkedSelection.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import type { ProvisionalReading } from "../trace/diagnose/provisional.ts";
import type { LiveTimeline } from "../trace/diagnose/timeline.ts";
import type { WindowRequest } from "../trace/diagnose/types.ts";

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

interface CompareSlots {
  left: LoadedArtifact | null;
  right: LoadedArtifact | null;
}

/** Derived once, so the header, the explanation, and the body agree on what is shown. */
type DockMode = "compare" | "file" | "live" | "read";

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
  const [brush, setBrush] = useState<WindowRequest | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The bundle is the one save that takes time. The seam asks the server for
  // its health and the render worker for the frame before it exports. A
  // failure shows where the file name would have been.
  const [bundling, setBundling] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  // **Send report** is the one control here that puts anything outside the
  // page, so it says what it did: the entry it landed in, and when the inbox
  // stops keeping it.
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<InboxReceipt | null>(null);
  const [sendFailed, setSendFailed] = useState<string | null>(null);
  const [file, setFile] = useState<LoadedArtifact | null>(null);
  const [fileFailed, setFileFailed] = useState<string | null>(null);
  // Sits over whatever else the dock holds, which is kept so leaving compare
  // mode returns to it.
  const [compare, setCompare] = useState<CompareSlots | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /** Which compare slot the next chosen file is for, or null for the report. */
  const pickTarget = useRef<CompareSlot | null>(null);
  const read = snapshot?.read;
  const runs = snapshot?.runs ?? [];
  const runId = read?.ok ? read.document.runId : undefined;
  const mode: DockMode = compare ? "compare" : file ? "file" : live ? "live" : "read";
  const trace = snapshot?.trace ?? null;

  // The published set narrows to the phase a drill-down has scoped to, so
  // the highlighted chunks are the ones in the phase the reader is looking at.
  const phase = drill?.phaseId ?? null;
  const windowed = useMemo<WindowedRead | null>(() => {
    if (!brush || !trace || !runId) return null;
    try {
      return readWindow(trace, runId, brush, phase);
    } catch {
      // A window the run cannot resolve, which the brush never asks for,
      // leaves the whole-run report up.
      return null;
    }
  }, [brush, trace, runId, phase]);

  useEffect(() => {
    publishChunkSelection(windowed?.selection ?? null);
  }, [windowed]);
  useEffect(() => () => publishChunkSelection(null), []);

  // Read one run and show it. The only path from watching to reading, so the
  // two states cannot both be on screen.
  const readRun = useCallback((next?: string) => {
    setDrill(null);
    setBrush(null);
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
    setBrush(null);
    setSaved(null);
    setFile(null);
    setCompare(null);
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

  // The one control that leaves the page. Nothing sends on its own: no
  // schedule, and no send when a run closes.
  const send = useCallback(() => {
    setSent(null);
    setSendFailed(null);
    setSending(true);
    sendReport(runId)
      .then(setSent)
      .catch((error: unknown) =>
        setSendFailed(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setSending(false));
  }, [runId]);

  const fillSlot = useCallback((slot: CompareSlot, loaded: LoadedArtifact) => {
    setCompare((current) => ({ left: current?.left ?? null, right: current?.right ?? null, [slot]: loaded }));
  }, []);

  // Clearing the watch does not close the run: nothing here exported it, and
  // the offer to watch it comes back beneath whatever is shown.
  const stopWatching = useCallback(() => {
    setLive(null);
    setReading(null);
    setLiveTimeline(null);
  }, []);

  const showFile = useCallback(
    (loaded: LoadedArtifact) => {
      setDrill(null);
      setBrush(null);
      setSaved(null);
      stopWatching();
      setFile(loaded);
    },
    [stopWatching],
  );

  const openFiles = useCallback(
    (files: ArrayLike<File> | null | undefined, slot?: CompareSlot) => {
      const list = files ? Array.from(files) : [];
      if (list.length === 0) return;
      setFileFailed(null);
      const failed = (error: unknown): void =>
        setFileFailed(error instanceof Error ? error.message : String(error));
      if (list.length >= 2 && !slot) {
        Promise.all([loadArtifact(list[0]), loadArtifact(list[1])])
          .then(([left, right]) => {
            stopWatching();
            setCompare({ left, right });
          })
          .catch(failed);
        return;
      }
      const destination: CompareSlot | "file" = slot ?? (compare ? (compare.left ? "right" : "left") : "file");
      loadArtifact(list[0])
        .then((loaded) => {
          if (destination === "file") showFile(loaded);
          else fillSlot(destination, loaded);
        })
        .catch(failed);
    },
    [compare, fillSlot, showFile, stopWatching],
  );

  const pick = useCallback((slot: CompareSlot | null) => {
    pickTarget.current = slot;
    fileInput.current?.click();
  }, []);

  const onPicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      openFiles(event.target.files, pickTarget.current ?? undefined);
      // Cleared so choosing the same file again fires change again.
      event.target.value = "";
    },
    [openFiles],
  );

  const chooseFileRun = useCallback(
    (next: string) => {
      if (!file) return;
      setDrill(null);
      setFile(rereadLoaded(file, next));
    },
    [file],
  );

  // A read run is still held. A watched one is watched again if it is still
  // open, and read once it has ended, as opening the dock would.
  const closeFile = useCallback(() => {
    setDrill(null);
    setFile(null);
    if (snapshot) return;
    const progress = readProgress();
    if (progress) {
      setLive(progress);
      setReading(readProvisional());
      setLiveTimeline(readLiveTimeline());
    } else {
      readRun();
    }
  }, [snapshot, readRun]);

  const pageRun = useMemo(() => (snapshot ? pageArtifact(snapshot) : null), [snapshot]);
  const enterCompare = useCallback(() => setCompare({ left: file, right: null }), [file]);
  const leaveCompare = useCallback(() => setCompare(null), []);
  const comparison = useMemo(
    () => (compare?.left && compare.right ? compareLoaded(compare.left, compare.right) : null),
    [compare],
  );

  // Spread on both roots, in the tab and popped out. A compare slot that
  // took the drop has already prevented the default.
  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (!dropping) setDropping(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (event: React.DragEvent) => {
      setDropping(false);
      if (event.isDefaultPrevented()) return;
      event.preventDefault();
      openFiles(event.dataTransfer?.files);
    },
  };

  const { height, startResize } = useDockHeight();
  const { popout, popOut, dockBack, popoutFailed } = usePopout();

  const shownRuns = file ? file.runs : runs;
  const shownRunId = file ? (file.runId ?? undefined) : runId;
  const runLabel =
    mode === "compare"
      ? `${compare?.left?.runId ?? "—"} vs ${compare?.right?.runId ?? "—"}`
      : mode === "file"
        ? (file?.runId ?? "no run")
        : (live?.runId ?? runId ?? "no run");
  const explanation: Record<DockMode, string> = {
    compare:
      "Two runs compared through the function lucida trace diff evaluates on a page, so this diff and the CLI's are one. Every delta is right minus left, so a baseline on the left reads as what the candidate on the right changed. Neither side reads this page's recording unless you chose the run on screen.",
    file: `Reading ${file?.name ?? "a file"}, ${file ? describeArtifact(file) : "a file"}. Nothing here reads this page's recording, and a run in progress goes on unread.`,
    live: "This run is still open, so it is being watched rather than read: reading would close it, which is why saving and choosing another run are not offered until it ends. Watching reads the recorder's own counters and the last seconds of per-tick readings twice a second, and walks none of the run's rows.",
    read: "Opening the dock reads the recording, and reading closes the run in progress: an interval has to end before it can be analysed.",
  };
  const view = useMemo(
    () => (read?.ok ? buildMonitorView(windowed?.document ?? read.document) : null),
    [read, windowed],
  );

  // The timeline renders inside whichever report is on screen, after the
  // coverage and truncation that qualify it: a chart is read after its
  // denominator. A closed run's axis takes the brush and draws the whole
  // run's timeline rather than the window's, so the brush can be moved.
  const timeline = live ? (
    liveTimeline ? <TimelineCanvas section={liveTimeline.timeline} provisional /> : null
  ) : read?.ok ? (
    <TimelineCanvas
      section={read.document.timeline}
      provisional={false}
      brush={{
        brushed:
          brush && windowed && view?.window
            ? { window: brush, view: view.window, selection: windowed.selection }
            : null,
        onChange: setBrush,
      }}
    />
  ) : null;

  const body = (
    <>
      <header className="monitor-chrome">
        <h1>Pipeline monitor</h1>
        <span className="monitor-run-id" data-testid="monitor-run-id">
          {runLabel}
        </span>
        <div className="monitor-chrome-actions">
          {/* Offered whether or not a run is open: the stream carries the
              steady-state interval's aggregates too, and a session that never
              settles is the one somebody wants watched. */}
          <WatchToggle />
          {/* While a run is open the only reading control offered is the one
              that ends it. Every other read here exports, and exporting would
              close the run being watched without saying that is what it did. */}
          {mode === "live" && (
            <button type="button" onClick={stopAndAnalyse} data-testid="monitor-stop">
              Stop &amp; analyse
            </button>
          )}
          {(mode === "read" || mode === "file") && shownRuns.length > 0 && (
            <select
              aria-label="Run"
              data-testid="monitor-run-select"
              value={shownRunId ?? ""}
              onChange={(event) => (file ? chooseFileRun(event.target.value) : readRun(event.target.value))}
            >
              {shownRuns.map((run) => (
                <RunOption key={run.runId} run={run} />
              ))}
            </select>
          )}
          {/* The exports are of this page's recording, so while a file is on
              screen they would save something other than what is shown. */}
          {mode === "read" && (
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
              <button
                type="button"
                onClick={send}
                disabled={!read?.ok || sending}
                title="Post this run's bundle to the workspace inbox, where the CLI reads it"
                data-testid="monitor-send-report"
              >
                {sending ? "Sending report…" : "Send report"}
              </button>
            </>
          )}
          {(mode === "read" || mode === "file") && (
            <button
              type="button"
              onClick={() => pick(null)}
              title="Or drop a saved run, a run file, or a bundle anywhere on the dock"
              data-testid="monitor-open-file"
            >
              Open a run or bundle
            </button>
          )}
          {mode === "file" && (
            <button type="button" onClick={closeFile} data-testid="monitor-close-file">
              Back to this page&rsquo;s runs
            </button>
          )}
          {mode !== "live" &&
            (mode === "compare" ? (
              <button type="button" onClick={leaveCompare} data-testid="monitor-leave-compare">
                Leave compare mode
              </button>
            ) : (
              <button type="button" onClick={enterCompare} data-testid="monitor-compare-runs">
                Compare two runs
              </button>
            ))}
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
        Observation only — nothing in the dock changes what the pipeline does. {explanation[mode]}
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        multiple
        className="monitor-file-input"
        aria-label="Open a run or bundle"
        data-testid="monitor-file-input"
        onChange={onPicked}
      />

      {fileFailed && (
        <p className="monitor-save-failed" data-testid="monitor-file-failed">
          Could not read the file: {fileFailed}
        </p>
      )}

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
      {sent && (
        <p className="monitor-saved" data-testid="monitor-sent">
          Sent to the workspace inbox as {sent.entryId}. It is kept until {sent.expiresAt}. Read it
          with <code>lucida trace inbox fetch {sent.entryId}</code>.
        </p>
      )}
      {sendFailed && (
        <p className="monitor-save-failed" data-testid="monitor-send-failed">
          Could not send the report: {sendFailed}
        </p>
      )}

      {mode === "compare" && compare ? (
        <div className="monitor-compare-mode" data-testid="monitor-compare-mode">
          <div className="monitor-compare-slots">
            {(["left", "right"] as const).map((slot) => (
              <CompareSlotView
                key={slot}
                side={slot}
                loaded={compare[slot]}
                pageRun={pageRun}
                onPick={() => pick(slot)}
                onDrop={(files) => openFiles(files, slot)}
                onFill={(loaded) => fillSlot(slot, loaded)}
              />
            ))}
          </div>
          {comparison && compare.left && compare.right ? (
            <CompareView left={compare.left} right={compare.right} compared={comparison} />
          ) : (
            <p className="monitor-note" data-testid="monitor-compare-waiting">
              Drop a saved run, a run file, or a bundle on each side, or choose one. The left side is the
              baseline, and every delta is right minus left.
            </p>
          )}
        </div>
      ) : mode === "file" && file ? (
        <LoadedReport loaded={file} drill={drill} onDrill={setDrill} />
      ) : mode === "live" && live ? (
        <LiveReport
          view={buildLiveView(live)}
          reading={reading ? buildProvisionalView(reading) : null}
          timeline={timeline}
        />
      ) : view ? (
        <MonitorReport view={view} drill={drill} onDrill={setDrill} timeline={timeline} />
      ) : (
        <p className="monitor-empty" data-testid="monitor-empty">
          {read && !read.ok ? read.reason : null} Open a dataset, let it reach quiescence, then read
          the run.
        </p>
      )}
    </>
  );

  const dockClass = `monitor-dock${dropping ? " monitor-dock-dropping" : ""}`;

  if (popout) {
    return createPortal(
      <section
        className={`${dockClass} monitor-dock-popout`}
        aria-label="Pipeline monitor"
        data-testid="monitor-dock"
        {...dropProps}
      >
        {body}
      </section>,
      popout.document.body,
    );
  }

  return (
    <aside
      className={dockClass}
      style={{ height, left: insetLeft }}
      aria-label="Pipeline monitor"
      data-testid="monitor-dock"
      {...dropProps}
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
      trackPointerDrag(
        doc,
        (move) => setHeight(clampHeight(startHeight + (startY - move.clientY), view?.innerHeight || 800)),
        () => {},
      );
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
