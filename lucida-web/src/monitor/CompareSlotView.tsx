/**
 * One side of a comparison in the dock (#1066): what it holds, a drop
 * target of its own, a file picker, the run on screen when there is one,
 * and, for a document holding several runs, which of them stands on this
 * side.
 */

import { formatMs } from "./monitorModel.ts";
import {
  describeArtifact,
  rereadLoaded,
  type LoadedArtifact,
  type MonitorRunSummary,
} from "./monitorSource.ts";

/** The two sides of a comparison: the baseline, and the candidate every delta is measured for. */
export type CompareSlot = "left" | "right";

export interface CompareSlotViewProps {
  side: CompareSlot;
  loaded: LoadedArtifact | null;
  /** The run on screen, when this page has read one, offered to the slot. */
  pageRun: LoadedArtifact | null;
  onPick: () => void;
  onDrop: (files: ArrayLike<File> | null | undefined) => void;
  onFill: (loaded: LoadedArtifact) => void;
}

export function CompareSlotView({ side, loaded, pageRun, onPick, onDrop, onFill }: CompareSlotViewProps) {
  return (
    <div
      className="monitor-compare-slot"
      data-testid={`monitor-compare-slot-${side}`}
      onDrop={(event) => {
        // The dock's own drop handler, which this event reaches next, skips a
        // drop that is already prevented, so this one stays with the slot.
        event.preventDefault();
        onDrop(event.dataTransfer?.files);
      }}
    >
      <h3>{side === "left" ? "Left: the baseline" : "Right: the candidate"}</h3>
      {loaded ? (
        <p data-testid={`monitor-compare-slot-${side}-name`}>
          <code>{loaded.name}</code> · {describeArtifact(loaded)} · run {loaded.runId ?? "none"}
        </p>
      ) : (
        <p className="monitor-note">Empty. Drop a saved run, a run file, or a bundle here.</p>
      )}
      {loaded && loaded.runs.length > 1 && (
        <select
          aria-label={`Run on the ${side}`}
          data-testid={`monitor-compare-run-${side}`}
          value={loaded.runId ?? ""}
          onChange={(event) => onFill(rereadLoaded(loaded, event.target.value))}
        >
          {loaded.runs.map((run) => (
            <RunOption key={run.runId} run={run} />
          ))}
        </select>
      )}
      <div className="monitor-compare-slot-actions">
        <button type="button" onClick={onPick} data-testid={`monitor-compare-pick-${side}`}>
          Choose a file
        </button>
        {pageRun && (
          <button type="button" onClick={() => onFill(pageRun)} data-testid={`monitor-compare-use-page-${side}`}>
            Use the run on screen
          </button>
        )}
      </div>
    </div>
  );
}

/** One run as a select offers it: enough to tell an open from the quiet tail after it. */
export function RunOption({ run }: { run: MonitorRunSummary }) {
  return (
    <option value={run.runId}>
      {run.cause} · {run.datasetCount} dataset(s) · {formatMs(run.wallMs)} · {run.endReason}
    </option>
  );
}
