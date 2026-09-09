/**
 * A run in progress, and no verdict.
 *
 * What is here is what a run can honestly say before it ends: how much work
 * it has made, how much of it reached the screen, and where the rest is
 * sitting, plus a provisional reading over a trailing window. The whole
 * report is absent on purpose. A headline that changes between two glances
 * is not a headline, and the attribution back-walk needs an end to walk back
 * from.
 *
 * The counters have no window and no scrolling: every one is cumulative
 * from run start, which is what stops the interesting part of an open going
 * past before anyone looks at it. The provisional reading is the one thing
 * here with a window, and it says which.
 */

import type { ReactNode } from "react";
import type { LiveView, ProvisionalView } from "./liveModel.ts";
import { PHASE_COLORS, PLANNED_COLOR } from "./timelinePalette.ts";
import type { Phase } from "../trace/types.ts";

export interface LiveReportProps {
  view: LiveView;
  reading: ProvisionalView | null;
  /**
   * The live charts, rendered after the run's status and its truncation
   * note. Truncation leads the picture it qualifies, as coverage leads the
   * closed-run report.
   */
  timeline?: ReactNode;
}

/** The timeline's palette, so a phase is one color in the bar and on the axis. */
function segmentColor(id: string): string {
  return id in PHASE_COLORS ? PHASE_COLORS[id as Phase] : PLANNED_COLOR;
}

export function LiveReport({ view, reading, timeline }: LiveReportProps) {
  return (
    <section className="monitor-section monitor-live" aria-labelledby="monitor-live-heading">
      <h2 id="monitor-live-heading">Run in progress</h2>
      <p className="monitor-note" data-testid="monitor-live-status">
        {view.cause} · running {view.elapsed} · {view.quiescence}
      </p>

      {view.unrecorded && (
        <p className="monitor-note" data-testid="monitor-live-unrecorded">
          {view.unrecorded}
        </p>
      )}

      {timeline}

      <ProvisionalBlock reading={reading} />

      <dl className="monitor-live-counters" data-testid="monitor-live-counters">
        {view.counters.map((counter) => (
          <div key={counter.label} className="monitor-live-counter">
            <dt>{counter.label}</dt>
            <dd>{counter.value}</dd>
            <p className="monitor-dim">{counter.meaning}</p>
          </div>
        ))}
      </dl>

      <h3>Where the rows in flight are</h3>
      {view.bar.length > 0 ? (
        <>
          <div className="monitor-live-bar" data-testid="monitor-live-bar">
            {view.bar.map((segment) => (
              <span
                key={segment.id}
                className="monitor-live-bar-segment"
                style={{ width: `${segment.pct}%`, background: segmentColor(segment.id) }}
                data-testid={`monitor-live-bar-${segment.id}`}
              />
            ))}
          </div>
          <ul className="monitor-live-legend">
            {view.bar.map((segment) => (
              <li key={segment.id}>
                <span className="monitor-live-swatch" style={{ background: segmentColor(segment.id) }} />
                {segment.id} <span className="monitor-dim">{segment.rows.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="monitor-note" data-testid="monitor-live-bar-empty">
          Nothing in flight this instant.
        </p>
      )}

      <p className="monitor-note">
        The verdict waits for the run to end. Closing the interval is what makes it analysable —
        let it reach quiescence, or stop it here.
      </p>
    </section>
  );
}

/**
 * The provisional reading, labelled provisional wherever it appears. It has
 * no verdict callout on purpose: a moving number must never be read as a
 * conclusion. Every line is a selection from the object the watch stream
 * carries, so the dock and an agent cannot disagree.
 */
function ProvisionalBlock({ reading }: { reading: ProvisionalView | null }) {
  return (
    <div className="monitor-provisional" data-testid="monitor-provisional">
      <h3>
        Provisional reading{" "}
        <span className="monitor-chip monitor-chip-provisional" data-testid="monitor-provisional-label">
          provisional
        </span>
      </h3>
      {reading ? (
        <>
          <p className="monitor-provisional-statement" data-testid="monitor-provisional-statement">
            {reading.statement}
          </p>
          {reading.finding ? (
            <p
              className={`monitor-provisional-finding monitor-provisional-${reading.finding.severity}`}
              data-testid="monitor-provisional-finding"
            >
              <span className="monitor-chip">{reading.finding.severity}</span>{" "}
              <strong>{reading.finding.subject}</strong> {reading.finding.detail}{" "}
              <span className="monitor-chip monitor-chip-rule">{reading.finding.rule}</span>
              <span className="monitor-chip monitor-chip-provisional">provisional</span>
              <br />
              <span className="monitor-dim">basis: {reading.finding.basis}</span>
            </p>
          ) : (
            <p className="monitor-note" data-testid="monitor-provisional-finding">
              No threshold crossed in the window (provisional).
            </p>
          )}
          <ul className="monitor-numbers" data-testid="monitor-provisional-facts">
            <li>
              <span className="monitor-dim">window</span> {reading.window} · {reading.readings}
            </li>
            <li>
              <span className="monitor-dim">page</span> {reading.quiescence}
            </li>
            <li>
              <span className="monitor-dim">rows</span> {reading.rows}
            </li>
          </ul>
          <p className="monitor-note">{reading.caveat}</p>
        </>
      ) : (
        <p className="monitor-note" data-testid="monitor-provisional-empty">
          No provisional reading yet — it appears on the next poll.
        </p>
      )}
    </div>
  );
}
