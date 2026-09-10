/**
 * A dropped file's report (#1066): the closed-run report the dock renders
 * for a live run, from the same view model and at the same depths, with a
 * bundle's settled frame beside it.
 *
 * Nothing here reads this page's recording. The document is the file's,
 * and the frame is the one the bundle carries, dated by the bundle's own
 * header rather than by anything on screen now.
 */

import { buildMonitorView, type MonitorDrill } from "./monitorModel.ts";
import { MonitorReport } from "./MonitorReport.tsx";
import type { LoadedArtifact } from "./monitorSource.ts";
import { TimelineCanvas } from "./TimelineCanvas.tsx";
import type { TraceBundle } from "../trace/bundle.ts";

export interface LoadedReportProps {
  loaded: LoadedArtifact;
  drill: MonitorDrill | null;
  onDrill: (drill: MonitorDrill | null) => void;
}

export function LoadedReport({ loaded, drill, onDrill }: LoadedReportProps) {
  const bundle = loaded.artifact.kind === "bundle" ? loaded.artifact.bundle : null;
  return (
    <div className={`monitor-file${bundle ? " monitor-file-with-frame" : ""}`} data-testid="monitor-file">
      <div className="monitor-file-report">
        {loaded.read.ok ? (
          <MonitorReport
            view={buildMonitorView(loaded.read.document)}
            drill={drill}
            onDrill={onDrill}
            timeline={<TimelineCanvas section={loaded.read.document.timeline} provisional={false} />}
          />
        ) : (
          <p className="monitor-empty" data-testid="monitor-empty">
            {loaded.read.reason}
          </p>
        )}
      </div>
      {bundle && <FrameFigure bundle={bundle} />}
    </div>
  );
}

/**
 * Laid out at the CSS size the frame had on the page that took it, so a
 * retina frame is not shown at twice its size.
 */
function FrameFigure({ bundle }: { bundle: TraceBundle }) {
  const frame = bundle.frame;
  if (!frame) {
    const reason =
      bundle.absent.find((entry) => entry.section === "frame")?.reason ?? "the bundle carries none";
    return (
      <p className="monitor-frame-absent" data-testid="monitor-frame-absent">
        No settled frame in this bundle: {reason}.
      </p>
    );
  }
  const ratio = frame.devicePixelRatio ?? 1;
  const savedAt = new Date(bundle.header.savedAtEpochMs).toISOString();
  return (
    <figure className="monitor-frame" data-testid="monitor-frame">
      <img
        src={`data:image/png;base64,${frame.png}`}
        alt={`The settled frame this bundle carries, ${frame.width} by ${frame.height} device pixels at ratio ${ratio}, captured by the ${frame.capturedBy}`}
        width={Math.round(frame.width / ratio)}
        height={Math.round(frame.height / ratio)}
      />
      <figcaption>
        Settled frame · {frame.width}×{frame.height} device pixels at ratio {ratio} · captured by the{" "}
        {frame.capturedBy} · bundle saved {savedAt}
      </figcaption>
    </figure>
  );
}
