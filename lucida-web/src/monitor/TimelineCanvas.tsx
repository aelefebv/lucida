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
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TimelineSection } from "../trace/diagnose/types.ts";
import { backingStoreSize, buildTimelineDrawList, paintTimeline } from "./timelineDraw.ts";

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
}

/** What the canvas is laid out at before the container has reported a width. */
const DEFAULT_WIDTH_PX = 960;

export function TimelineCanvas({ section, provisional, alignSpanMs }: TimelineCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  const [ratio, setRatio] = useState(1);

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

  return (
    <figure className="monitor-timeline" data-testid="monitor-timeline">
      <div ref={containerRef} className="monitor-timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="monitor-timeline-canvas"
          data-testid="monitor-timeline-canvas"
          role="img"
          aria-label={`${provisional ? "Provisional timeline: " : "Timeline: "}${section.statement}`}
          style={{ width: list.width, height: list.height }}
          width={store.width}
          height={store.height}
        />
      </div>
      <figcaption className="monitor-timeline-legend">
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
