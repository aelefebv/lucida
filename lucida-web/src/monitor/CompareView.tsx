/**
 * Two runs compared, in the dock (#1066): the seam's comparison document
 * as two timelines on one scale and three tables, with the text `lucida
 * trace diff` prints beneath them.
 *
 * Every number here is a field of the comparison or of the two diagnostics
 * the sides were read into. The view selects and formats and subtracts
 * nothing of its own, so the tables cannot disagree with the text beneath
 * them, and the text is the CLI's output for the same two files.
 *
 * The warning leads when the runs are not comparable, before any delta a
 * reader might otherwise take at face value, as it does in the text. The
 * two timelines are laid out to the longer run's span, so a millisecond
 * after run start is one column on both, and the shorter run ends where it
 * ended.
 */

import { useMemo } from "react";
import type {
  ComparedRun,
  FindingDelta,
  HeaderDifference,
  HeaderValue,
  PhaseDelta,
  PhaseNumbers,
} from "../trace/diagnose/compare.ts";
import type { LoadedArtifact, LoadedComparison } from "./monitorSource.ts";
import { TimelineCanvas } from "./TimelineCanvas.tsx";

export interface CompareViewProps {
  left: LoadedArtifact;
  right: LoadedArtifact;
  compared: LoadedComparison;
}

export function CompareView({ left, right, compared }: CompareViewProps) {
  const { comparison, text } = compared;
  const leftSection = left.read.ok ? left.read.document.timeline : null;
  const rightSection = right.read.ok ? right.read.document.timeline : null;
  const alignSpanMs = useMemo(
    () => Math.max(leftSection?.axis.spanMs ?? 0, rightSection?.axis.spanMs ?? 0),
    [leftSection, rightSection],
  );
  const wall = comparison.wall;

  return (
    <section className="monitor-compare" aria-label="Comparison" data-testid="monitor-compare">
      <dl className="monitor-compare-identities" data-testid="monitor-compare-identities">
        <Identity side="left" run={comparison.left} />
        <Identity side="right" run={comparison.right} />
      </dl>

      {!comparison.comparable && (
        <div
          className="monitor-banner monitor-banner-severe monitor-banner-incomparable"
          role="alert"
          data-testid="monitor-compare-warning"
        >
          <strong>Not comparable</strong>
          <span>
            {comparison.warnings.join(" · ")}. The deltas below compare different conditions.
          </span>
        </div>
      )}

      <div className="monitor-compare-timelines" data-testid="monitor-compare-timelines">
        <SideTimeline side="left" loaded={left} alignSpanMs={alignSpanMs} />
        <SideTimeline side="right" loaded={right} alignSpanMs={alignSpanMs} />
      </div>

      <p className="monitor-note" data-testid="monitor-compare-wall">
        Wall {wall.leftMs} → {wall.rightMs} ms ({signed(wall.deltaMs)} ms
        {wall.deltaPct === null ? "" : `, ${signed(wall.deltaPct)}%`})
        {comparison.verdictChanged
          ? ` · verdict ${comparison.left.verdict.kind} → ${comparison.right.verdict.kind}`
          : " · same verdict kind"}
        . Every delta is right minus left.
      </p>

      <section className="monitor-section" aria-labelledby="monitor-compare-header-heading">
        <h2 id="monitor-compare-header-heading">Header</h2>
        <table className="monitor-table" data-testid="monitor-compare-header">
          <caption>
            A field that differs and breaks comparability is marked incomparable. The planning
            configuration, the cache knobs, and the driver&rsquo;s conditions are the experiment, so
            they are listed and never warned about.
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Left</th>
              <th scope="col">Right</th>
              <th scope="col">Reads as</th>
            </tr>
          </thead>
          <tbody>
            {comparison.header.map((field) => (
              <tr key={field.field} className={headerRowClass(field)}>
                <th scope="row">{field.field}</th>
                <td>{showSide(field, field.left)}</td>
                <td>{showSide(field, field.right)}</td>
                <td>{readsAs(field)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="monitor-section" aria-labelledby="monitor-compare-phases-heading">
        <h2 id="monitor-compare-phases-heading">Phases</h2>
        <table className="monitor-table" data-testid="monitor-compare-phases">
          <caption>Left → right (right minus left), in milliseconds except for the row count.</caption>
          <thead>
            <tr>
              <th scope="col">Phase</th>
              <th scope="col">Class</th>
              <th scope="col">Sides</th>
              <th scope="col">Rows</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
              <th scope="col">max</th>
              <th scope="col">total</th>
            </tr>
          </thead>
          <tbody>
            {comparison.phases.map((phase) => (
              <PhaseRow key={phase.id} phase={phase} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="monitor-section" aria-labelledby="monitor-compare-findings-heading">
        <h2 id="monitor-compare-findings-heading">Findings</h2>
        {comparison.findings.length === 0 ? (
          <p className="monitor-note" data-testid="monitor-compare-findings-none">
            No finding on either side.
          </p>
        ) : (
          <table className="monitor-table" data-testid="monitor-compare-findings">
            <caption>
              A finding is matched across the runs by its rule and its subject, never by its rank.
            </caption>
            <thead>
              <tr>
                <th scope="col">Where</th>
                <th scope="col">Severity</th>
                <th scope="col">Subject</th>
                <th scope="col">Change</th>
                <th scope="col">Rule</th>
              </tr>
            </thead>
            <tbody>
              {comparison.findings.map((finding) => (
                <FindingRow key={`${finding.rule} ${finding.subject}`} finding={finding} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <details className="monitor-compare-text-details">
        <summary>As text, which is what `lucida trace diff` prints for these two files</summary>
        <pre className="monitor-compare-text" data-testid="monitor-compare-text">
          {text}
        </pre>
      </details>
    </section>
  );
}

function Identity({ side, run }: { side: "left" | "right"; run: ComparedRun }) {
  const label = run.label === run.runId ? run.runId : `${run.label} (${run.runId})`;
  return (
    <div className="monitor-compare-identity" data-testid={`monitor-compare-${side}`}>
      <dt>{side}</dt>
      <dd>
        <code>{label}</code> · {run.datasetIds.join(", ")} · cause {run.cause} · {run.wallMs} ms wall ·
        ended {run.endReason} · <strong>{run.verdict.text}</strong>
      </dd>
    </div>
  );
}

function SideTimeline({
  side,
  loaded,
  alignSpanMs,
}: {
  side: "left" | "right";
  loaded: LoadedArtifact;
  alignSpanMs: number;
}) {
  return (
    <div className="monitor-compare-side" data-testid={`monitor-compare-timeline-${side}`}>
      <h3>
        {side}: {loaded.name} · {loaded.runId ?? "no run"}
      </h3>
      {loaded.read.ok ? (
        <TimelineCanvas section={loaded.read.document.timeline} provisional={false} alignSpanMs={alignSpanMs} />
      ) : (
        <p className="monitor-empty">{loaded.read.reason}</p>
      )}
    </div>
  );
}

function headerRowClass(field: HeaderDifference): string | undefined {
  if (field.same) return undefined;
  return field.breaksComparability ? "monitor-row-incomparable" : "monitor-row-differs";
}

function readsAs(field: HeaderDifference): string {
  if (field.same) return "same";
  return field.breaksComparability ? "incomparable" : "differs";
}

function show(value: HeaderValue): string {
  return value === null ? "unknown" : String(value);
}

/** A cache knob a side did not set ran at the cache's default; any other null is a side that could not say. */
function showSide(field: HeaderDifference, value: HeaderValue): string {
  if (value === null && field.group === "cache") return "default";
  return show(value);
}

function PhaseRow({ phase }: { phase: PhaseDelta }) {
  const sides = phase.left && phase.right ? "both" : phase.left ? "left only" : "right only";
  const column = (key: keyof PhaseNumbers): string => {
    if (phase.left && phase.right && phase.delta) {
      return pair(phase.left[key], phase.right[key], phase.delta[key]);
    }
    const only = (phase.left ?? phase.right)!;
    return String(only[key]);
  };
  return (
    <tr className={sides === "both" ? undefined : "monitor-row-differs"}>
      <th scope="row">{phase.id}</th>
      <td>{phase.class}</td>
      <td>{sides}</td>
      <td>{column("n")}</td>
      <td>{column("p50Ms")}</td>
      <td>{column("p95Ms")}</td>
      <td>{column("maxMs")}</td>
      <td>{column("totalMs")}</td>
    </tr>
  );
}

function FindingRow({ finding }: { finding: FindingDelta }) {
  const where = finding.status === "both" ? "both" : finding.status === "left-only" ? "left" : "right";
  const severity = (finding.right ?? finding.left)!.severity;
  return (
    <tr className={finding.status === "both" ? undefined : "monitor-row-differs"}>
      <td>{where}</td>
      <td>{severity}</td>
      <td>{finding.subject}</td>
      <td>{observedChange(finding)}</td>
      <td>
        <code>{finding.rule}</code>
      </td>
    </tr>
  );
}

/** The text's headline picks the most telling measure; the table has the room for every one both sides observed. */
function observedChange(finding: FindingDelta): string {
  if (finding.left && finding.right && finding.delta) {
    const parts = Object.entries(finding.delta).map(([key, delta]) => {
      const l = finding.left!.observed[key as keyof typeof finding.left.observed];
      const r = finding.right!.observed[key as keyof typeof finding.right.observed];
      return `${key} ${pair(Number(l), Number(r), delta)}`;
    });
    return parts.length === 0 ? "no shared measure" : parts.join(" · ");
  }
  const only = (finding.left ?? finding.right)!;
  return Object.entries(only.observed)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
}

function pair(left: number, right: number, delta: number): string {
  return `${left} → ${right} (${signed(delta)})`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
