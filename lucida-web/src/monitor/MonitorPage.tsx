/**
 * The monitor: a run, read.
 *
 * A separate page rather than an overlay. Cost is not the argument — the
 * in-memory trace is 265 kB against 2.7 MB of Chrome JSON, and #892's own
 * render measured p95 1.0 ms per frame drawing every span. The argument is
 * isolation: nothing here shares a frame with the viewer, so reading a run
 * cannot perturb the next one.
 *
 * It ships in production builds. A diagnostic that only exists in development
 * cannot explain a field report, and shipping the agent surface to production
 * while withholding the human one is exactly the asymmetry surface parity
 * forbids (ADR 0051, ADR 0052).
 *
 * **Observation only.** Every control on this page reads, saves or drills in.
 * None of them changes what the pipeline does — you cannot perturb the thing
 * you are measuring by reading it.
 */

import { useCallback, useEffect, useState } from "react";
import "./MonitorPage.css";
import { buildLiveView, type LiveView } from "./liveModel.ts";
import {
  buildMonitorView,
  formatMs,
  type MonitorBanner,
  type MonitorCallout,
  type MonitorDrill,
  type MonitorTrackGroup,
  type MonitorView,
} from "./monitorModel.ts";
import {
  downloadTraceFile,
  readMonitor,
  readProgress,
  stopRun,
  type MonitorSnapshot,
} from "./monitorSource.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import type { PhaseRollup } from "../trace/diagnose/types.ts";

export interface MonitorPageProps {
  /** Leave the monitor. The page it returns to is the caller's business. */
  onClose: () => void;
}

/**
 * How often the live view re-reads the run (#937).
 *
 * Not a frame cadence. The counters move in thousands and the bar changes
 * shape in tenths of a second, so twice a second is as fast as a reader can
 * use — and the read walks the run's rows, which is main-thread time taken
 * from the pipeline being watched.
 */
const LIVE_POLL_MS = 500;

export function MonitorPage({ onClose }: MonitorPageProps) {
  // A run that is still open is watched, not read: reading closes the
  // interval, and what somebody came here to see is still happening.
  const [live, setLive] = useState<LiveProgress | null>(readProgress);
  // Reading is what closes the run in progress, so the page does it once on
  // mount and once per control — not twice for one answer, and not at all
  // while a run is open.
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(() =>
    live ? null : readMonitor(),
  );
  const [drill, setDrill] = useState<MonitorDrill | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const read = snapshot?.read;
  const runs = snapshot?.runs ?? [];
  const runId = read?.ok ? read.document.runId : undefined;

  const readRun = useCallback((next?: string) => {
    setDrill(null);
    setSaved(null);
    setSnapshot(readMonitor(next));
  }, []);

  // Watch the run until it ends — by settling, by timing out, or because
  // somebody stopped it. Whichever way it ends, the verdict for *that* run
  // replaces the live view where it stood: no reload, and no reading of the
  // newest interval, which by then is the export's own.
  const watchedRunId = live?.runId ?? null;
  useEffect(() => {
    if (watchedRunId === null) return;
    const timer = setInterval(() => {
      const next = readProgress();
      if (next && next.runId === watchedRunId) {
        setLive(next);
        return;
      }
      setLive(null);
      setSnapshot(readMonitor(watchedRunId));
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [watchedRunId]);

  const stopAndAnalyse = useCallback(() => {
    stopRun();
    setLive(null);
    setSnapshot(readMonitor(watchedRunId ?? undefined));
  }, [watchedRunId]);

  // Named for the run on screen, so the file and the follow-up command that
  // names that run agree.
  const save = useCallback(
    (kind: "trace" | "perfetto") => setSaved(downloadTraceFile(kind, runId)),
    [runId],
  );

  return (
    <main className="monitor-page">
      <header className="monitor-chrome">
        <button type="button" onClick={onClose} data-testid="monitor-close">
          Back
        </button>
        <h1>Pipeline monitor</h1>
        <span className="monitor-run-id" data-testid="monitor-run-id">
          {live?.runId ?? runId ?? "no run"}
        </span>
        <div className="monitor-chrome-actions">
          {/* While a run is open the only control offered is the one that ends
              it. Every other read here exports, and exporting would close the
              run being watched without saying that is what it did. */}
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
            </>
          )}
        </div>
      </header>

      <p className="monitor-observation-only">
        Observation only — nothing on this page changes what the pipeline does.{" "}
        {live
          ? "This run is still open, so it is being watched rather than read: reading would close it. Watching costs a walk over the run's rows twice a second, on the same thread the run is using."
          : "Opening the monitor reads the recording, and reading closes the run in progress: an interval has to end before it can be analysed."}
      </p>

      {saved && (
        <p className="monitor-saved" data-testid="monitor-saved">
          Saved {saved}
        </p>
      )}

      {live ? (
        <LiveReport view={buildLiveView(live)} />
      ) : read?.ok ? (
        <MonitorReport view={buildMonitorView(read.document)} drill={drill} onDrill={setDrill} />
      ) : (
        <p className="monitor-empty" data-testid="monitor-empty">
          {read?.reason} Open a dataset, let it settle, then read the run.
        </p>
      )}
    </main>
  );
}

/**
 * A run in progress, and no verdict (#937).
 *
 * What is here is what a run can honestly say before it ends: how much work
 * it has made, how much of it reached the screen, and where the rest is
 * sitting. What is deliberately absent is the whole report — a headline that
 * changes between two glances is not a headline, and the attribution
 * back-walk needs an end to walk back from.
 *
 * There is no window and no scrolling: every counter is cumulative from run
 * start, which is what stops the interesting part of an open going past
 * before anyone looks at it.
 */
function LiveReport({ view }: { view: LiveView }) {
  return (
    <section className="monitor-section monitor-live" aria-labelledby="monitor-live-heading">
      <h2 id="monitor-live-heading">Run in progress</h2>
      <p className="monitor-note" data-testid="monitor-live-status">
        {view.cause} · running {view.elapsed} · {view.settling}
      </p>

      <dl className="monitor-live-counters" data-testid="monitor-live-counters">
        {view.counters.map((counter) => (
          <div key={counter.label} className="monitor-live-counter">
            <dt>{counter.label}</dt>
            <dd>{counter.value}</dd>
            <p className="monitor-dim">{counter.note}</p>
          </div>
        ))}
      </dl>

      {view.unrecorded && (
        <p className="monitor-note" data-testid="monitor-live-unrecorded">
          {view.unrecorded}
        </p>
      )}

      <h3>Where the rows in flight are</h3>
      {view.bar.length > 0 ? (
        <>
          <div className="monitor-live-bar" data-testid="monitor-live-bar">
            {view.bar.map((segment) => (
              <span
                key={segment.id}
                className={`monitor-live-bar-segment monitor-live-bar-${segment.id}`}
                style={{ width: `${segment.pct}%` }}
                data-testid={`monitor-live-bar-${segment.id}`}
              />
            ))}
          </div>
          <ul className="monitor-live-legend">
            {view.bar.map((segment) => (
              <li key={segment.id}>
                <span className={`monitor-live-swatch monitor-live-bar-${segment.id}`} />
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
        let it settle, or stop it here.
      </p>
    </section>
  );
}

interface ReportProps {
  view: MonitorView;
  drill: MonitorDrill | null;
  onDrill: (drill: MonitorDrill | null) => void;
}

function MonitorReport({ view, drill, onDrill }: ReportProps) {
  return (
    <>
      {/* Truncation and coverage lead. A reader has to be told what the run did
          not measure before being told what it did. */}
      <section className="monitor-banners" aria-label="Coverage">
        {view.banners.map((banner, index) => (
          <BannerRow key={`${banner.kind}-${index}`} banner={banner} />
        ))}
      </section>

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
        Raw spans are not on this page at any depth — a warm re-open is tens of thousands of rows.
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
