/**
 * The closed-run report: the verdict, the phase tracks and table, the
 * critical path, the limiters, and the run's identity, from the view model
 * the monitor has read since it shipped.
 *
 * Rendered beneath the timeline in the dock. Nothing the separate page
 * answered is lost here: the sections, their order, and the drill-down are
 * the page's, moved rather than redesigned.
 */

import type { ReactNode } from "react";
import {
  formatMs,
  type MonitorBanner,
  type MonitorCallout,
  type MonitorDrill,
  type MonitorTrackGroup,
  type MonitorView,
} from "./monitorModel.ts";
import type { PhaseRollup } from "../trace/diagnose/types.ts";

export interface MonitorReportProps {
  view: MonitorView;
  drill: MonitorDrill | null;
  onDrill: (drill: MonitorDrill | null) => void;
  /** The timeline, rendered after the coverage banners and before the verdict. */
  timeline?: ReactNode;
}

export function MonitorReport({ view, drill, onDrill, timeline }: MonitorReportProps) {
  return (
    <>
      {/* Truncation and coverage lead. A reader has to be told what the run did
          not measure before being told what it did, and before being shown a
          chart of it. */}
      <section className="monitor-banners" aria-label="Coverage">
        {view.banners.map((banner, index) => (
          <BannerRow key={`${banner.kind}-${index}`} banner={banner} />
        ))}
      </section>

      {timeline}

      <section className="monitor-section" aria-labelledby="monitor-verdict-heading">
        <h2 id="monitor-verdict-heading">Verdict</h2>
        <div className="monitor-callouts">
          {view.callouts.map((callout) => (
            <CalloutCard key={callout.id} callout={callout} onDrill={onDrill} />
          ))}
        </div>
        {drill && (
          <div className="monitor-drill">
            <h3>Drill-down — {drill.phaseId}</h3>
            <DrillPanel drill={drill} onClose={() => onDrill(null)} />
          </div>
        )}
      </section>

      <section className="monitor-section" aria-labelledby="monitor-phases-heading">
        <h2 id="monitor-phases-heading">Phases</h2>
        {view.trackGroups.map((group) => (
          <TrackBand key={group.side} group={group} />
        ))}
        <PhaseTable phases={view.phases} scopedTo={drill?.phaseId ?? null} />
      </section>

      <section className="monitor-section" aria-labelledby="monitor-path-heading">
        <h2 id="monitor-path-heading">Critical path</h2>
        {view.criticalPath.kind === "chain" ? (
          <>
            <p className="monitor-note">
              Back-walk from {view.criticalPath.target} at{" "}
              {formatMs(view.criticalPath.targetAtMs ?? 0)}.
            </p>
            <table className="monitor-table">
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Class</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Share of chain</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {view.criticalPath.segments.map((segment) => (
                  <tr key={segment.label}>
                    <th scope="row">{segment.label}</th>
                    <td>{segment.class}</td>
                    <td>{formatMs(segment.ms)}</td>
                    <td>{segment.sharePct}%</td>
                    <td>{segment.rows.toLocaleString()}</td>
                    <td>{segment.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="monitor-note">Undefined — {view.criticalPath.undefinedReason}</p>
        )}
      </section>

      {view.limiters.length > 0 && (
        <section className="monitor-section" aria-labelledby="monitor-limiters-heading">
          <h2 id="monitor-limiters-heading">Limiters</h2>
          <table className="monitor-table">
            <thead>
              <tr>
                <th scope="col">Limiter</th>
                <th scope="col">Cap</th>
                <th scope="col">Pinned</th>
                <th scope="col">Pending</th>
                <th scope="col">Drain</th>
                <th scope="col">Backlog</th>
              </tr>
            </thead>
            <tbody>
              {view.limiters.map((limiter) => (
                <tr key={limiter.id}>
                  <th scope="row">{limiter.id}</th>
                  <td>
                    {limiter.cap} <span className="monitor-dim">({limiter.capSource})</span>
                  </td>
                  <td>{limiter.pinnedPct}%</td>
                  <td>{limiter.pending.toLocaleString()}</td>
                  <td>
                    {limiter.drainPerS}/s over {limiter.windowMs} ms
                  </td>
                  <td>
                    {limiter.backlogEtaS == null
                      ? "does not drain at the observed rate"
                      : `~${limiter.backlogEtaS} s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="monitor-section" aria-labelledby="monitor-run-heading">
        <h2 id="monitor-run-heading">Run</h2>
        <dl className="monitor-facts">
          {[...view.identity, ...view.counts].map((fact) => (
            <div key={fact.label} className="monitor-fact">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="monitor-note">
          Ruleset v{view.ruleset.version} — {view.ruleset.note}
        </p>
      </section>
    </>
  );
}

function BannerRow({ banner }: { banner: MonitorBanner }) {
  return (
    <div
      className={`monitor-banner monitor-banner-${banner.kind}${banner.severe ? " monitor-banner-severe" : ""}`}
      data-testid={`monitor-banner-${banner.kind}`}
    >
      <strong>{banner.headline}</strong>
      <span>{banner.detail}</span>
    </div>
  );
}

function CalloutCard({
  callout,
  onDrill,
}: {
  callout: MonitorCallout;
  onDrill: (drill: MonitorDrill) => void;
}) {
  return (
    <article
      className={`monitor-callout monitor-callout-${callout.tone}`}
      data-testid={`monitor-callout-${callout.tone}`}
    >
      <h3>{callout.headline}</h3>
      <p className="monitor-confidence">
        <span className="monitor-chip">{callout.confidence}</span>
        {callout.rule && <span className="monitor-chip monitor-chip-rule">{callout.rule}</span>}
      </p>
      <ul className="monitor-numbers">
        {callout.numbers.map((number) => (
          <li key={number.label}>
            <span className="monitor-dim">{number.label}</span> {number.value}
          </li>
        ))}
      </ul>
      <p className="monitor-detail">{callout.detail}</p>
      {callout.drill && (
        <button
          type="button"
          onClick={() => onDrill(callout.drill!)}
          data-testid={`monitor-drill-${callout.id}`}
        >
          Show the rows behind {callout.drill.phaseId}
        </button>
      )}
    </article>
  );
}

/**
 * One step deeper, carrying the question.
 *
 * The scope is a phase and the evidence is the worst row that phase saw, named.
 * Not a time range: brushing an interval is Perfetto's job, and a coordinate is
 * an answer to a question nobody asked.
 */
function DrillPanel({ drill, onClose }: { drill: MonitorDrill; onClose: () => void }) {
  return (
    <div className="monitor-drill-panel" data-testid="monitor-drill-panel">
      <p className="monitor-question" data-testid="monitor-drill-question">
        {drill.question}
      </p>
      {drill.worst ? (
        <p data-testid="monitor-drill-worst">
          Worst row: <code>{drill.worst.label}</code> at {formatMs(drill.worst.ms)}
        </p>
      ) : (
        <p data-testid="monitor-drill-worst">
          No per-item row behind this phase — it is recorded as per-tick readings.
        </p>
      )}
      <ul className="monitor-numbers">
        {drill.numbers.map((number) => (
          <li key={number.label}>
            <span className="monitor-dim">{number.label}</span> {number.value}
          </li>
        ))}
        <li>
          <span className="monitor-dim">placed</span> {drill.placement}
        </li>
      </ul>
      <p className="monitor-note">
        Raw spans are not in the dock at any depth — a warm re-open is tens of thousands of rows.
        Save the run for Perfetto to ask a per-span question.
      </p>
      <button type="button" onClick={onClose}>
        Close drill-down
      </button>
    </div>
  );
}

function TrackBand({ group }: { group: MonitorTrackGroup }) {
  return (
    <div className="monitor-track-band" data-testid={`monitor-track-band-${group.side}`}>
      <h3>{group.title}</h3>
      <p className="monitor-note">{group.why}</p>
      {group.tracks.map((track) => (
        <div className="monitor-track" key={track.phaseId} data-testid={`monitor-track-${track.phaseId}`}>
          <span className="monitor-track-label">{track.label}</span>
          <span className="monitor-track-gutter">
            {track.placed ? (
              <span
                className={`monitor-track-bar monitor-track-bar-${track.className}`}
                style={{ left: `${track.leftPct}%`, width: `${track.widthPct}%` }}
              />
            ) : (
              <span className="monitor-track-unplaced">no position on this run&rsquo;s clock</span>
            )}
          </span>
          <span className="monitor-track-note">{track.note}</span>
        </div>
      ))}
    </div>
  );
}

function PhaseTable({ phases, scopedTo }: { phases: PhaseRollup[]; scopedTo: string | null }) {
  return (
    <table className="monitor-table" data-testid="monitor-phase-table">
      <caption>
        Totals overlap: thousands of rows are in flight at once, so a total is not a share of the
        wall clock and the factor beside it says how many ran together.
      </caption>
      <thead>
        <tr>
          <th scope="col">Phase</th>
          <th scope="col">Class</th>
          <th scope="col">Rows</th>
          <th scope="col">p50</th>
          <th scope="col">p95</th>
          <th scope="col">max</th>
          <th scope="col">total</th>
          <th scope="col">at once</th>
          <th scope="col">worst row</th>
        </tr>
      </thead>
      <tbody>
        {phases.map((phase) => (
          <tr key={phase.id} className={phase.id === scopedTo ? "monitor-row-scoped" : undefined}>
            <th scope="row">{phase.id}</th>
            <td>{phase.class}</td>
            <td>{phase.n.toLocaleString()}</td>
            <td>{formatMs(phase.p50Ms)}</td>
            <td>{formatMs(phase.p95Ms)}</td>
            <td>{formatMs(phase.maxMs)}</td>
            <td>{formatMs(phase.totalMs)}</td>
            <td>{phase.concurrencyFactor}x</td>
            <td>
              <code>{phase.worst?.label ?? "—"}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
