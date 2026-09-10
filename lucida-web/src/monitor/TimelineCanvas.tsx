/**
 * The timeline on a canvas, with its text twin beside it.
 *
 * The component owns one canvas element and nothing else about the picture:
 * the layout comes from {@link buildTimelineDrawList}, which is pure, and
 * the paint is {@link paintTimeline}, which replays that list. The canvas is
 * sized to its container in CSS pixels and to the device pixel ratio of the
 * window it is in, which is the popout's ratio when the dock is popped out,
 * so a retina display draws crisp bars in either window.
 *
 * The legend under the canvas is the same section as text: one entry per
 * chart, one line per series with its peak and newest value or the reason it
 * is absent. It is the in-page twin of the `timeline` depth an agent reads,
 * and it is where a test enumerates the closed set of charts.
 *
 * On a closed run the axis takes a brush. A drag across the plot becomes a
 * window on the run's clock through the list's own scale, the caller
 * derives the report over it, and the canvas draws the brushed stretch back
 * from the same scale. The canvas keeps drawing the whole run while it is
 * brushed, so the brush can be moved. The window changes what the report
 * beneath says, not what the axis spans. The live picture takes no brush:
 * it is provisional, and a window needs a closed interval.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChunkSelection } from "../trace/diagnose/chunkSelection.ts";
import type { TimelineSection, WindowRequest } from "../trace/diagnose/types.ts";
import type { MonitorWindow } from "./monitorModel.ts";
import { trackPointerDrag } from "./pointerDrag.ts";
import {
  backingStoreSize,
  brushWindow,
  buildTimelineDrawList,
  paintTimeline,
  xAtMs,
  type AxisScale,
} from "./timelineDraw.ts";

/** A brushed window as the caller has read it: the window, the report's statement of it, and the set it published. */
export interface BrushedWindow {
  window: WindowRequest;
  /** The window as the report states it and the command that reads it. */
  view: MonitorWindow;
  /** The chunk set the brush published. */
  selection: ChunkSelection;
}

/** The brush a closed run's axis takes. */
export interface TimelineBrush {
  /** The window brushed and read, or null when none is. */
  brushed: BrushedWindow | null;
  /** A new window, or null to clear the brush. */
  onChange: (window: WindowRequest | null) => void;
}

export interface TimelineCanvasProps {
  section: TimelineSection;
  /** True while the run is open, so the picture is labelled provisional wherever it appears. */
  provisional: boolean;
  /**
   * A span in milliseconds to lay the plot out to instead of the section's
   * own, so two timelines stacked in compare mode share one scale from run
   * start. Absent, the section's own span fills the plot.
   */
  alignSpanMs?: number;
  /** Present on a closed run, where the axis can be brushed. */
  brush?: TimelineBrush;
}

/** What the canvas is laid out at before the container has reported a width. */
const DEFAULT_WIDTH_PX = 960;

const BRUSH_HINT =
  "Drag across the axis to brush a window: the verdict, the callouts, and the phase table scope to it, and the overlays highlight the chunks that were in it.";

export function TimelineCanvas({ section, provisional, alignSpanMs, brush }: TimelineCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  const [ratio, setRatio] = useState(1);
  const [drag, setDrag] = useState<{ fromX: number; toX: number } | null>(null);

  // The element's own window rather than the global one: a popped-out dock
  // lives in a window whose pixel ratio can differ from the opener's.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = container.ownerDocument.defaultView;
    const measure = (): void => {
      const measured = container.clientWidth;
      if (measured > 0) setWidth(measured);
      setRatio(view?.devicePixelRatio ?? 1);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      return () => observer.disconnect();
    }
    view?.addEventListener("resize", measure);
    return () => view?.removeEventListener("resize", measure);
  }, []);

  const list = useMemo(
    () => buildTimelineDrawList(section, { width, devicePixelRatio: ratio, alignSpanMs }),
    [section, width, ratio, alignSpanMs],
  );
  const store = backingStoreSize(list);

  useEffect(() => {
    const canvas = canvasRef.current;
    // A test environment has no rendering context; the layout is still built
    // and the legend still rendered, which is what the tests assert on.
    const ctx = canvas?.getContext("2d") ?? null;
    if (!canvas || !ctx) return;
    paintTimeline(canvas, ctx, list);
  }, [list]);

  const startBrush = brush
    ? (event: React.PointerEvent<HTMLCanvasElement>): void => {
        if (event.button !== 0) return;
        event.preventDefault();
        const canvas = event.currentTarget;
        const xOf = (clientX: number): number => clientX - canvas.getBoundingClientRect().left;
        const fromX = xOf(event.clientX);
        setDrag({ fromX, toX: fromX });
        trackPointerDrag(
          canvas.ownerDocument,
          (move) => setDrag({ fromX, toX: xOf(move.clientX) }),
          (up) => {
            setDrag(null);
            brush.onChange(brushWindow(list.scale, fromX, xOf(up.clientX)));
          },
        );
      }
    : undefined;

  const rect = brushRect(list.scale, drag, brush?.brushed?.window ?? null);
  const brushed = brush?.brushed ?? null;

  return (
    <figure className="monitor-timeline" data-testid="monitor-timeline">
      <div ref={containerRef} className="monitor-timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          className={`monitor-timeline-canvas${brush ? " monitor-timeline-canvas-brushable" : ""}`}
          data-testid="monitor-timeline-canvas"
          role="img"
          aria-label={`${provisional ? "Provisional timeline: " : "Timeline: "}${section.statement}`}
          style={{ width: list.width, height: list.height }}
          width={store.width}
          height={store.height}
          onPointerDown={startBrush}
        />
        {rect && (
          <div
            className="monitor-brush"
            data-testid="monitor-brush"
            aria-hidden="true"
            style={{ left: rect.left, width: rect.width, height: list.height }}
          />
        )}
      </div>
      <figcaption className="monitor-timeline-legend">
        {brush && (
          <p className="monitor-note monitor-brush-line" data-testid="monitor-brush-line">
            {brushed ? (
              <>
                Window <strong>{brushed.view.label} ms</strong> of the {brushed.view.ofWallMs} ms run. The
                report below is of this window. The CLI reads the same window of a saved run with{" "}
                <code data-testid="monitor-brush-command">{brushed.view.command}</code>.{" "}
                <button type="button" onClick={() => brush.onChange(null)} data-testid="monitor-brush-clear">
                  Clear the brush
                </button>
              </>
            ) : (
              BRUSH_HINT
            )}
          </p>
        )}
        {brushed && (
          <p className="monitor-note" data-testid="monitor-brush-selection">
            Highlighted on the viewport: {brushed.selection.statement}. {brushed.selection.cannotShow.join(". ")}.
          </p>
        )}
        <p className="monitor-note" data-testid="monitor-timeline-statement">
          {provisional && (
            <span className="monitor-chip monitor-chip-provisional" data-testid="monitor-timeline-provisional">
              provisional
            </span>
          )}{" "}
          {section.statement}
        </p>
        <dl className="monitor-timeline-charts">
          {list.rows.map((row) => (
            <div
              key={row.chartId}
              className={`monitor-timeline-chart${row.absent === null ? "" : " monitor-timeline-chart-absent"}`}
              data-testid={`monitor-chart-${row.chartId}`}
            >
              <dt>{row.title}</dt>
              {row.absent !== null ? (
                <dd className="monitor-timeline-absent" data-testid={`monitor-chart-${row.chartId}-absent`}>
                  absent — {row.absent}
                </dd>
              ) : (
                row.legend.map((entry) => (
                  <dd
                    key={entry.seriesId}
                    className={entry.recorded ? undefined : "monitor-timeline-absent"}
                    data-testid={`monitor-series-${row.chartId}-${entry.seriesId}`}
                  >
                    <span className="monitor-live-swatch" style={{ background: entry.color }} />
                    {entry.label} <span className="monitor-dim">{entry.reading}</span>
                    {entry.unsampled > 0 && (
                      <span className="monitor-dim"> · {entry.unsampled} bucket(s) unsampled</span>
                    )}
                  </dd>
                ))
              )}
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  );
}

/**
 * Where the brush is drawn: the drag's own extent while one is in progress,
 * otherwise the held window mapped back through the scale. Clamped to the
 * plot, and nothing at all for a drag that has not reached it.
 */
function brushRect(
  scale: AxisScale,
  drag: { fromX: number; toX: number } | null,
  window: WindowRequest | null,
): { left: number; width: number } | null {
  let from: number;
  let to: number;
  if (drag) {
    from = Math.min(drag.fromX, drag.toX);
    to = Math.max(drag.fromX, drag.toX);
  } else if (window) {
    from = xAtMs(scale, window.startMs);
    to = xAtMs(scale, window.endMs);
  } else {
    return null;
  }
  const left = Math.max(scale.plotX, from);
  const right = Math.min(scale.plotX + scale.plotWidth, to);
  if (right <= left) return null;
  return { left, width: Math.max(1, right - left) };
}
