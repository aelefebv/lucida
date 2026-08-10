/**
 * PROTOTYPE — throwaway. Issue #892. Variant A: "the wall".
 *
 * Answers "what you see first" with: the raw thing, densely. One lane per
 * phase, time across, every chunk drawn. This is the honest version of the
 * flame/gantt instinct — and the point of building it is to find out whether
 * tens of thousands of spans read as structure or as noise.
 *
 * Live policy: auto-follows with a scrolling window; brushing freezes it.
 * Drill-down: brush a time range -> the row list under the cursor.
 */

import { useEffect, useRef, useState } from "react";
import {
  BROWSER_PHASES,
  END_IN_FLIGHT,
  laneName,
  tierName,
  META_FIRST,
  META_LAST,
  NO_STAMP,
  SERVER_PHASES,
  SERVER_STAMP_COUNT,
  type Trace,
} from "./traceModel.ts";
import { sizeToDpr } from "./dprCanvas.ts";
import { PHASE_COLORS } from "./phaseColors.ts";
import { formatUs } from "./analysis.ts";
import type { Replay } from "./useReplay.ts";

export const NAME = "The wall — every span, lanes over time";

const LANE_H = 54;
const SERVER_LANE_H = 34;
const GUTTER = 96;

export function VariantA({ trace, replay }: { trace: Trace; replay: Replay }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const brushRef = useRef<[number, number] | null>(null);
  const dragRef = useRef<number | null>(null);
  const [hover, setHover] = useState<string>("");
  const { nowRef, playing, reportRenderMs } = replay;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const t0 = performance.now();
        paint(canvas, trace, nowRef.current, playing, brushRef.current);
        reportRenderMs(performance.now() - t0);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [trace, nowRef, playing, reportRenderMs]);

  const toUs = (clientX: number): number => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const win = viewWindow(trace, nowRef.current, playing, brushRef.current);
    const f = (clientX - rect.left - GUTTER) / Math.max(1, rect.width - GUTTER - 12);
    return win[0] + f * (win[1] - win[0]);
  };

  const rows = brush ? rowsIn(trace, brush[0], brush[1]) : [];

  return (
    <div className="va">
      <canvas
        ref={canvasRef}
        className="va-canvas"
        onPointerDown={(e) => {
          dragRef.current = toUs(e.clientX);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const us = toUs(e.clientX);
          setHover(formatUs(Math.max(0, us)));
          if (dragRef.current != null) {
            const b: [number, number] = [
              Math.min(dragRef.current, us),
              Math.max(dragRef.current, us),
            ];
            brushRef.current = b;
            setBrush(b);
          }
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      />
      <div className="va-foot">
        <span className="va-cursor">t = {hover || "—"}</span>
        {brush ? (
          <>
            <strong>{rows.length.toLocaleString()}</strong> chunks intersect{" "}
            {formatUs(brush[0])}–{formatUs(brush[1])} · follow is frozen
            <button
              onClick={() => {
                brushRef.current = null;
                setBrush(null);
              }}
            >
              clear brush &amp; resume follow
            </button>
          </>
        ) : (
          <span className="va-dim">
            drag on the wall to brush a time range (freezes follow)
          </span>
        )}
      </div>
      {brush && (
        <div className="va-rows">
          <table>
            <thead>
              <tr>
                <th>chunk</th>
                <th>lane</th>
                <th>tier</th>
                {BROWSER_PHASES.map((p) => (
                  <th key={p}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r}>
                  <td className="mono">{trace.chunks.keys[trace.chunks.keyId[r]]}</td>
                  <td>{laneName(trace.chunks, r)}</td>
                  <td>{tierName(trace.chunks, r)}</td>
                  {BROWSER_PHASES.map((p, i) => {
                    const a = trace.chunks.stamps[i * trace.chunks.cap + r];
                    const b = trace.chunks.stamps[(i + 1) * trace.chunks.cap + r];
                    return (
                      <td key={p} className="mono">
                        {a === NO_STAMP
                          ? "—"
                          : b === NO_STAMP
                            ? "open"
                            : formatUs(b - a)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 200 && (
            <p className="va-dim">
              showing the first 200 of {rows.length.toLocaleString()} — the list is
              the drill-down, and at this density it is its own wall
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Auto-follow: a 6 s scrolling window while playing, the whole run otherwise. */
function viewWindow(
  trace: Trace,
  nowUs: number,
  playing: boolean,
  brush: [number, number] | null,
): [number, number] {
  if (brush) return [0, trace.header.durationUs];
  if (!playing) return [0, trace.header.durationUs];
  const span = 6_000_000;
  return [Math.max(0, nowUs - span), Math.max(span, nowUs)];
}

function rowsIn(trace: Trace, a: number, b: number): number[] {
  const out: number[] = [];
  const { chunks } = trace;
  for (let r = 0; r < chunks.n; r++) {
    const start = chunks.stamps[r];
    if (start === NO_STAMP) continue;
    let end = start;
    for (let s = BROWSER_PHASES.length; s >= 0; s--) {
      const v = chunks.stamps[s * chunks.cap + r];
      if (v !== NO_STAMP) {
        end = v;
        break;
      }
    }
    if (end >= a && start <= b) out.push(r);
  }
  return out;
}

function paint(
  canvas: HTMLCanvasElement,
  trace: Trace,
  nowUs: number,
  playing: boolean,
  brush: [number, number] | null,
) {
  const sized = sizeToDpr(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;
  const [t0, t1] = viewWindow(trace, nowUs, playing, brush);
  const plotW = w - GUTTER - 12;
  const x = (us: number) => GUTTER + ((us - t0) / (t1 - t0)) * plotW;

  ctx.fillStyle = "#141414";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";

  const { chunks, server } = trace;
  let y = 8;

  for (let p = 0; p < BROWSER_PHASES.length; p++) {
    const phase = BROWSER_PHASES[p];
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(GUTTER, y, plotW, LANE_H - 6);
    ctx.fillStyle = "#8a8a8a";
    ctx.fillText(phase, 8, y + (LANE_H - 6) / 2);

    // Every row that is in this phase gets a hairline. Sub-pixel spans are
    // drawn at minimum 1px so a fast phase does not silently disappear.
    ctx.fillStyle = PHASE_COLORS[phase];
    ctx.globalAlpha = 0.35;
    let drawn = 0;
    for (let r = 0; r < chunks.n; r++) {
      const a = chunks.stamps[p * chunks.cap + r];
      if (a === NO_STAMP || a > nowUs) continue;
      let b = chunks.stamps[(p + 1) * chunks.cap + r];
      if (b === NO_STAMP) {
        // Only an in-flight row is still occupying this phase. A retired row
        // left the pipeline here on purpose and must not be drawn as a bar
        // stretching to the cursor — that is what turns a lane into a slab.
        if (chunks.endReason[r] !== END_IN_FLIGHT) continue;
        b = nowUs;
      } else if (b > nowUs) {
        b = nowUs;
      }
      if (b < t0 || a > t1) continue;
      const xa = x(a);
      const xb = Math.max(xa + 1, x(b));
      const yy = y + 2 + ((r * 7919) % (LANE_H - 12));
      ctx.fillRect(xa, yy, xb - xa, 1.5);
      drawn++;
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#5c5c5c";
    ctx.fillText(`${drawn}`, 8, y + (LANE_H - 6) / 2 + 14);
    y += LANE_H;
  }

  // Metadata reads get their own lane. Without it the wall shows dead air for
  // the slowest part of a cold open — the chunk lanes cannot draw work that
  // happens before the first chunk exists, and a viewer that renders silence
  // over the bottleneck is worse than one that renders nothing.
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(GUTTER, y, plotW, SERVER_LANE_H - 6);
  ctx.fillStyle = "#8a8a8a";
  ctx.fillText("open (meta)", 8, y + (SERVER_LANE_H - 6) / 2);
  ctx.fillStyle = "#c792ea";
  ctx.globalAlpha = 0.5;
  for (let m = 0; m < trace.meta.length; m++) {
    const row = trace.meta[m];
    if (row.stamps[META_FIRST] > nowUs) continue;
    const b = Math.min(row.stamps[META_LAST], nowUs);
    if (b < t0 || row.stamps[META_FIRST] > t1) continue;
    const xa = x(row.stamps[META_FIRST]);
    ctx.fillRect(
      xa,
      y + 2 + ((m * 7919) % (SERVER_LANE_H - 12)),
      Math.max(1, x(b) - xa),
      1.5,
    );
  }
  ctx.globalAlpha = 1;
  y += SERVER_LANE_H;

  // Server lanes, drawn under a divider — a second table, joined at export.
  ctx.strokeStyle = "#333";
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  y += 6;
  ctx.fillStyle = "#666";
  ctx.fillText("lucida-server", 8, y + 6);
  y += 16;

  for (let p = 0; p < SERVER_STAMP_COUNT - 1; p++) {
    const phase = SERVER_PHASES[p];
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(GUTTER, y, plotW, SERVER_LANE_H - 6);
    ctx.fillStyle = "#8a8a8a";
    ctx.fillText(phase, 8, y + (SERVER_LANE_H - 6) / 2);
    ctx.fillStyle = PHASE_COLORS[phase];
    ctx.globalAlpha = 0.4;
    for (let r = 0; r < server.n; r++) {
      const a = server.stamps[p * server.cap + r];
      if (a === NO_STAMP || a > nowUs) continue;
      let b = server.stamps[(p + 1) * server.cap + r];
      if (b === NO_STAMP || b > nowUs) b = nowUs;
      if (b < t0 || a > t1) continue;
      const xa = x(a);
      const xb = Math.max(xa + 1, x(b));
      ctx.fillRect(xa, y + 2 + ((r * 7919) % (SERVER_LANE_H - 12)), xb - xa, 1.5);
    }
    ctx.globalAlpha = 1;
    y += SERVER_LANE_H;
  }

  // Counter track: queue depth. The one line that explains the whole run.
  const chartH = Math.max(40, h - y - 30);
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(GUTTER, y, plotW, chartH);
  ctx.fillStyle = "#8a8a8a";
  ctx.fillText("queue depth", 8, y + 10);
  const maxDepth = Math.max(1, ...trace.ticks.queueDepth);
  ctx.strokeStyle = "#ff6b4a";
  ctx.beginPath();
  for (let i = 0; i < trace.ticks.n; i++) {
    const t = trace.ticks.t[i];
    if (t > nowUs || t < t0 || t > t1) continue;
    const px = x(t);
    const py = y + chartH - (trace.ticks.queueDepth[i] / maxDepth) * (chartH - 6);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = "#5c5c5c";
  ctx.fillText(`${maxDepth.toLocaleString()} max`, GUTTER + 6, y + 10);
  y += chartH;

  // Point events, as ticks on the time axis.
  for (const pt of trace.points) {
    if (pt.t > nowUs || pt.t < t0 || pt.t > t1) continue;
    ctx.fillStyle = pt.kind === "dataset-open" ? "#7c6cff" : "#ff4d6d";
    ctx.fillRect(x(pt.t) - 1, y + 2, 2, 10);
  }

  // Axis
  ctx.fillStyle = "#777";
  for (let i = 0; i <= 6; i++) {
    const us = t0 + ((t1 - t0) * i) / 6;
    ctx.fillText(`${(us / 1e6).toFixed(1)}s`, x(us) - 12, y + 22);
  }

  if (brush) {
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(x(brush[0]), 0, Math.max(2, x(brush[1]) - x(brush[0])), y);
  }
  if (playing) {
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(x(nowUs), 0);
    ctx.lineTo(x(nowUs), y);
    ctx.stroke();
  }
}
