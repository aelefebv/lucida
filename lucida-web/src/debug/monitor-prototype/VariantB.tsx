/**
 * PROTOTYPE — throwaway. Issue #892. Variant B: "the budget".
 *
 * Answers "what you see first" with: a stacked wall-clock breakdown. Where did
 * the time go, as one bar, before any span is drawn. The timeline is not the
 * top-level view at all — it is what you get when you open a phase.
 *
 * Live policy: no follow, because there is nothing to follow. The bar is an
 * aggregate and it just keeps updating; a run in progress reads the same as a
 * finished one, only less certain.
 * Drill-down: click a phase row -> that phase's spans only, one lane, sorted.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_PHASES,
  END_IN_FLIGHT,
  NO_STAMP,
  type BrowserPhase,
  type Trace,
} from "./traceModel.ts";
import { sizeToDpr } from "./dprCanvas.ts";
import { PHASE_COLORS } from "./phaseColors.ts";
import {
  formatUs,
  rollupMeta,
  rollupPhases,
  rollupServer,
  type PhaseRollup,
} from "./analysis.ts";
import type { Replay } from "./useReplay.ts";

export const NAME = "The budget — stacked wall-clock first, spans on demand";

export function VariantB({ trace, replay }: { trace: Trace; replay: Replay }) {
  const [open, setOpen] = useState<BrowserPhase | null>(null);
  const cursor = replay.playing ? replay.coarseNowUs : trace.header.durationUs;

  const phases = useMemo(() => rollupPhases(trace, cursor), [trace, cursor]);
  const serverPhases = useMemo(() => rollupServer(trace), [trace]);
  const meta = useMemo(() => rollupMeta(trace), [trace]);
  const grand = phases.reduce((a, p) => a + p.totalUs, 0) || 1;

  return (
    <div className="vb">
      <div className="vb-head">
        <div>
          <div className="vb-total">{formatUs(cursor)}</div>
          <div className="vb-sub">
            wall clock{replay.playing ? " so far" : ""} ·{" "}
            {trace.chunks.n.toLocaleString()} chunks ·{" "}
            {formatUs(grand)} summed chunk-time across {BROWSER_PHASES.length}{" "}
            concurrent phases
          </div>
        </div>
        <div className="vb-meta">
          <span>
            metadata reads <strong>{formatUs(meta.totalUs)}</strong>
          </span>
          <span>
            {meta.cached ? "source-cache hit" : "source-cache miss"} · {meta.n}{" "}
            objects
          </span>
        </div>
      </div>

      <div className="vb-bar">
        {phases.map((p) => (
          <button
            key={p.phase}
            className={`vb-seg${open === p.phase ? " on" : ""}`}
            style={{
              width: `${(p.totalUs / grand) * 100}%`,
              background: PHASE_COLORS[p.phase],
            }}
            title={`${p.phase} — ${Math.round(p.share * 100)}%`}
            onClick={() => setOpen(open === p.phase ? null : p.phase)}
          >
            {p.share > 0.06 ? `${p.phase} ${Math.round(p.share * 100)}%` : ""}
          </button>
        ))}
      </div>

      <table className="vb-table">
        <thead>
          <tr>
            <th></th>
            <th>phase</th>
            <th>share</th>
            <th>done</th>
            <th>still open</th>
            <th>p50</th>
            <th>p95</th>
            <th>worst</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {phases.map((p) => (
            <PhaseRow
              key={p.phase}
              p={p}
              trace={trace}
              open={open === p.phase}
              onToggle={() => setOpen(open === p.phase ? null : p.phase)}
              cursor={cursor}
            />
          ))}
        </tbody>
      </table>

      <div className="vb-server">
        <h3>lucida-server, joined on the correlation id</h3>
        <div className="vb-bar small">
          {serverPhases.map((s) => (
            <div
              key={s.phase}
              className="vb-seg"
              style={{
                width: `${s.share * 100}%`,
                background: PHASE_COLORS[s.phase],
              }}
            >
              {s.share > 0.08 ? `${s.phase} ${Math.round(s.share * 100)}%` : ""}
            </div>
          ))}
        </div>
        <div className="vb-serverrow">
          {serverPhases.map((s) => (
            <span key={s.phase}>
              <em style={{ color: PHASE_COLORS[s.phase] }}>{s.phase}</em> p50{" "}
              {formatUs(s.p50Us)} · p95 {formatUs(s.p95Us)}
            </span>
          ))}
        </div>
        <p className="vb-note">
          {trace.chunks.n.toLocaleString()} browser rows point at{" "}
          {trace.server.n.toLocaleString()} wire requests — the join is
          many-to-one because duplicate in-flight fetches are coalesced.
        </p>
      </div>
    </div>
  );
}

function PhaseRow({
  p,
  trace,
  open,
  onToggle,
  cursor,
}: {
  p: PhaseRollup;
  trace: Trace;
  open: boolean;
  onToggle: () => void;
  cursor: number;
}) {
  return (
    <>
      <tr className={open ? "on" : ""} onClick={onToggle}>
        <td>
          <span className="dot" style={{ background: PHASE_COLORS[p.phase] }} />
        </td>
        <td className="vb-phase">{p.phase}</td>
        <td>{Math.round(p.share * 100)}%</td>
        <td>{p.n.toLocaleString()}</td>
        <td className={p.openN ? "warn" : ""}>{p.openN.toLocaleString()}</td>
        <td className="mono">{formatUs(p.p50Us)}</td>
        <td className="mono">{formatUs(p.p95Us)}</td>
        <td className="mono">{formatUs(p.maxUs)}</td>
        <td className="vb-chev">{open ? "▾" : "▸"}</td>
      </tr>
      {open && (
        <tr className="vb-drill">
          <td colSpan={9}>
            <PhaseStrip trace={trace} phase={p.phase} cursor={cursor} />
            <p className="vb-note">
              every span in <strong>{p.phase}</strong>, sorted longest first —
              one lane, so length is the only variable
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/** One phase, every span, sorted by duration. A sorted wall has a shape. */
function PhaseStrip({
  trace,
  phase,
  cursor,
}: {
  trace: Trace;
  phase: BrowserPhase;
  cursor: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const sized = sizeToDpr(canvas);
    if (!sized) return;
    const { ctx, w, h } = sized;
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, w, h);
    const p = BROWSER_PHASES.indexOf(phase);
    const { chunks } = trace;
    const spans: [number, number][] = [];
    for (let r = 0; r < chunks.n; r++) {
      const a = chunks.stamps[p * chunks.cap + r];
      if (a === NO_STAMP || a > cursor) continue;
      const raw = chunks.stamps[(p + 1) * chunks.cap + r];
      if (raw === NO_STAMP && chunks.endReason[r] !== END_IN_FLIGHT) continue;
      const b = raw === NO_STAMP || raw > cursor ? cursor : raw;
      spans.push([a, b - a]);
    }
    if (!spans.length) return;
    spans.sort((x, y) => y[1] - x[1]);
    const maxDur = spans[0][1] || 1;
    const barH = Math.max(1, h / spans.length);
    ctx.fillStyle = PHASE_COLORS[phase];
    for (let i = 0; i < spans.length; i++) {
      ctx.fillRect(0, i * barH, (spans[i][1] / maxDur) * w, Math.max(0.6, barH - 0.4));
    }
    ctx.fillStyle = "#ddd";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${spans.length.toLocaleString()} spans, longest first`, 8, 14);
  }, [trace, phase, cursor]);
  return <canvas ref={ref} className="vb-strip" />;
}
