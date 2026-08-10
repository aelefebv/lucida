/**
 * PROTOTYPE — throwaway. Issue #892. Variant C: "the verdict".
 *
 * Answers "what you see first" with: the conclusion, in words. Callouts are
 * the top-level surface; the timeline is a drill-in scoped to whichever
 * callout you opened. Nothing is drawn until you ask which chunks.
 *
 * This is the variant that takes the map's stance literally — the monitor
 * calls out the bottleneck, it does not just present rows — and it is also the
 * one that has to prove it does not become a dead-end when the callout is
 * wrong.
 *
 * Live policy: recording is explicit. While recording you get a counter and
 * nothing else; the verdict appears when you stop. A verdict that keeps
 * changing while you read it is not a verdict.
 */

import { useMemo, useState } from "react";
import {
  BROWSER_PHASES,
  END_IN_FLIGHT,
  NO_STAMP,
  type Trace,
} from "./traceModel.ts";
import { PHASE_COLORS } from "./dprCanvas.ts";
import {
  computeCallouts,
  formatUs,
  rollupPhases,
  type Callout,
} from "./analysis.ts";
import type { Replay } from "./useReplay.ts";

export const NAME = "The verdict — callouts first, timeline as drill-in";

export function VariantC({ trace, replay }: { trace: Trace; replay: Replay }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAgent, setShowAgent] = useState(false);
  const callouts = useMemo(() => computeCallouts(trace), [trace]);
  const phases = useMemo(() => rollupPhases(trace), [trace]);

  if (replay.playing) {
    const done = countStamped(trace, 6, replay.coarseNowUs);
    const started = countStamped(trace, 0, replay.coarseNowUs);
    return (
      <div className="vc recording">
        <div className="vc-rec">
          <span className="vc-dot" />
          recording · {formatUs(replay.coarseNowUs)}
        </div>
        <div className="vc-counts">
          <div>
            <strong>{started.toLocaleString()}</strong>
            <span>planned</span>
          </div>
          <div>
            <strong>{done.toLocaleString()}</strong>
            <span>visible</span>
          </div>
          <div>
            <strong>{(started - done).toLocaleString()}</strong>
            <span>in flight</span>
          </div>
        </div>
        <p className="vc-recnote">
          No verdict while the run is open. Stop the recording to read it.
        </p>
        <button className="vc-stop" onClick={replay.seekEnd}>
          Stop &amp; analyse
        </button>
      </div>
    );
  }

  return (
    <div className="vc">
      <header className="vc-header">
        <h2>{trace.header.runLabel}</h2>
        <p>
          {formatUs(trace.header.durationUs)} · {trace.chunks.n.toLocaleString()}{" "}
          chunks · DPR {trace.header.devicePixelRatio} ·{" "}
          {trace.header.viewport[0]}×{trace.header.viewport[1]} ·{" "}
          {trace.header.cacheWarmth} · cause {trace.header.cause}
        </p>
      </header>

      <div className="vc-cards">
        {callouts.map((c) => (
          <CalloutCard
            key={c.id}
            c={c}
            trace={trace}
            open={openId === c.id}
            onToggle={() => setOpenId(openId === c.id ? null : c.id)}
          />
        ))}
      </div>

      <section className="vc-gaps">
        <h3>What this run does not tell you</h3>
        <ul>
          {trace.header.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </section>

      <section className="vc-agent">
        <button onClick={() => setShowAgent(!showAgent)}>
          {showAgent ? "▾" : "▸"} what an agent reads from the same bytes
        </button>
        {showAgent && <pre>{agentText(trace, callouts, phases)}</pre>}
      </section>
    </div>
  );
}

function CalloutCard({
  c,
  trace,
  open,
  onToggle,
}: {
  c: Callout;
  trace: Trace;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <article className={`vc-card ${c.severity}${open ? " open" : ""}`}>
      <button className="vc-cardhead" onClick={onToggle}>
        <span className="vc-sev">{c.severity}</span>
        <span className="vc-headline">{c.headline}</span>
        <span className="vc-chev">{open ? "▾" : "▸"}</span>
      </button>
      <p className="vc-detail">{c.detail}</p>
      {open && <ScopedTimeline trace={trace} callout={c} />}
    </article>
  );
}

/**
 * The drill-in. One step from "queue was the bottleneck" to the chunks: the
 * callout's focus becomes the filter, and only the focused phase is drawn.
 */
function ScopedTimeline({ trace, callout }: { trace: Trace; callout: Callout }) {
  const phase = callout.focus?.phase;
  const p = phase ? BROWSER_PHASES.indexOf(phase) : -1;
  const { chunks } = trace;

  const rows = useMemo(() => {
    const out: { row: number; a: number; b: number; open: boolean }[] = [];
    if (p < 0) return out;
    for (let r = 0; r < chunks.n; r++) {
      const a = chunks.stamps[p * chunks.cap + r];
      if (a === NO_STAMP) continue;
      const raw = chunks.stamps[(p + 1) * chunks.cap + r];
      if (raw === NO_STAMP && chunks.endReason[r] !== END_IN_FLIGHT) continue;
      out.push({
        row: r,
        a,
        b: raw === NO_STAMP ? trace.header.durationUs : raw,
        open: raw === NO_STAMP,
      });
    }
    out.sort((x, y) => y.b - y.a - (x.b - x.a));
    return out;
  }, [chunks, p, trace.header.durationUs]);

  if (p < 0) {
    return (
      <div className="vc-scope">
        <p className="vc-note">
          This callout has no per-chunk scope — it is about the run, not a
          chunk. Metadata reads happen before the first chunk exists.
        </p>
        <ol className="vc-metalist">
          {trace.meta.slice(0, 8).map((m) => (
            <li key={m.path}>
              <span className="mono">{m.path}</span>
              <span className="mono">{formatUs(m.stamps[4] - m.stamps[0])}</span>
              <span>{m.hit ? "cache hit" : "miss"}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const dur = trace.header.durationUs;
  return (
    <div className="vc-scope">
      <div className="vc-lane">
        {rows.slice(0, 400).map((r, i, arr) => (
          <div
            key={r.row}
            className="vc-span"
            style={{
              top: `${(i / arr.length) * 138}px`,
              left: `${(r.a / dur) * 100}%`,
              width: `${Math.max(0.15, ((r.b - r.a) / dur) * 100)}%`,
              background: PHASE_COLORS[BROWSER_PHASES[p]],
              // An unfinished span is a lower bound, not a measurement. Hatching
              // it keeps the eye from reading "18 s" off a bar that means ">18 s".
              opacity: r.open ? 0.22 : 0.75,
            }}
            title={`${chunks.keys[chunks.keyId[r.row]]} — ${formatUs(r.b - r.a)}${r.open ? " (still open at run end — a lower bound)" : ""}`}
          />
        ))}
      </div>
      <p className="vc-note">
        {rows.length.toLocaleString()} chunks in <strong>{phase}</strong>,
        longest first{rows.length > 400 ? " (first 400 drawn)" : ""} ·{" "}
        {rows.filter((r) => r.open).length.toLocaleString()} faded bars never
        finished, so their length is a lower bound · longest:{" "}
        <span className="mono">
          {rows.length ? chunks.keys[chunks.keyId[rows[0].row]] : "—"}
        </span>{" "}
        at {rows.length ? formatUs(rows[0].b - rows[0].a) : "—"}
      </p>
    </div>
  );
}

function countStamped(trace: Trace, slot: number, untilUs: number): number {
  const { chunks } = trace;
  let n = 0;
  for (let r = 0; r < chunks.n; r++) {
    const v = chunks.stamps[slot * chunks.cap + r];
    if (v !== NO_STAMP && v <= untilUs) n++;
  }
  return n;
}

/** The #893 surface, rendered from the same derivation. Parity, demonstrated. */
function agentText(
  trace: Trace,
  callouts: Callout[],
  phases: ReturnType<typeof rollupPhases>,
): string {
  const lines: string[] = [];
  lines.push(`run: ${trace.header.runLabel}`);
  lines.push(
    `duration ${formatUs(trace.header.durationUs)} | ${trace.chunks.n} chunks | dpr ${trace.header.devicePixelRatio} | ${trace.header.cacheWarmth}`,
  );
  lines.push("");
  for (const c of callouts) {
    lines.push(`[${c.severity}] ${c.headline}`);
    lines.push(`         ${c.detail}`);
  }
  lines.push("");
  lines.push("phase            share   done   open      p50      p95     worst");
  for (const p of phases) {
    lines.push(
      `${p.phase.padEnd(14)} ${String(Math.round(p.share * 100)).padStart(4)}% ` +
        `${String(p.n).padStart(6)} ${String(p.openN).padStart(6)} ` +
        `${formatUs(p.p50Us).padStart(8)} ${formatUs(p.p95Us).padStart(8)} ` +
        `${formatUs(p.maxUs).padStart(9)}`,
    );
  }
  lines.push("");
  lines.push("gaps:");
  for (const g of trace.header.gaps) lines.push(`  - ${g}`);
  return lines.join("\n");
}
