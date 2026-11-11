import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import "./CanvasStage.css";

/**
 * Where floating controls sit over the canvas. Each slot lays its children
 * out in flow and the slots share the stage, so two controls never overlap.
 */
export type CanvasSlot =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** The canvas's size in CSS pixels. */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface CanvasStageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /**
   * The canvas element's key. `transferControlToOffscreen` is one-shot per
   * element, so a new render client needs a fresh canvas.
   */
  canvasKey: number;
  /** Nearest-neighbour upscaling, so a zoomed-in 2D pixel stays a square. */
  pixelated: boolean;
  /**
   * Fires when the canvas changes size in CSS or device pixels, including a
   * device-pixel-ratio change. The render paths size the backing store from
   * the canvas's CSS size on each frame, so a resize only needs a new frame.
   */
  onResize?: (size: CanvasSize) => void;
  /** Full-bleed layers that track the canvas: viewers, annotations, cursors. */
  children?: ReactNode;
  /** Floating controls, by slot. */
  slots?: Partial<Record<CanvasSlot, ReactNode>>;
  /** Shown over the middle of the canvas, e.g. when there is nothing to draw. */
  emptyState?: ReactNode;
  /**
   * The chrome-free capture surface: only the canvas shows. The layers and
   * slots stay mounted, so the frame is the one a person would see.
   */
  bare?: boolean;
  /** The canvas's accessible name: what it shows. */
  label: string;
}

/**
 * The canvas, filling the space the panels leave, with the layers that track
 * it and the floating controls over it.
 */
export function CanvasStage({
  canvasRef,
  canvasKey,
  pixelated,
  onResize,
  children,
  slots = {},
  emptyState,
  bare,
  label,
}: CanvasStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    let last = "";
    const report = () => {
      const { width, height } = stage.getBoundingClientRect();
      const key = `${width}x${height}@${window.devicePixelRatio}`;
      if (key === last) return;
      last = key;
      onResizeRef.current?.({ width, height });
    };
    const observer = new ResizeObserver(report);
    try {
      // Device pixels also change with the ratio, at the same CSS size.
      observer.observe(stage, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(stage);
    }
    // Where the device-pixel box is unsupported, a ratio change (a window
    // dragged to another screen, a browser zoom) arrives only as a media query.
    let media: MediaQueryList | null = null;
    const watchRatio = () => {
      media?.removeEventListener("change", onRatioChange);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onRatioChange);
    };
    const onRatioChange = () => {
      report();
      watchRatio();
    };
    if (typeof window.matchMedia === "function") watchRatio();
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", onRatioChange);
    };
  }, []);

  const bottomRowRef = useRef<HTMLDivElement>(null);
  useToastInsets(stageRef, bottomRowRef, !bare);

  return (
    // `viewer-canvas-wrap` is how the CLI's trace driver finds the canvas,
    // and the canvas stays the page's first, which the capture probe reads.
    <div ref={stageRef} className="lc-canvas-stage viewer-canvas-wrap" data-bare={bare || undefined}>
      <canvas
        key={canvasKey}
        ref={canvasRef}
        className="lc-canvas-stage-canvas"
        role="img"
        aria-label={label}
        style={{ imageRendering: pixelated ? "pixelated" : "auto" }}
      />
      <div className="lc-canvas-stage-layers">{children}</div>
      {emptyState && <div className="lc-canvas-stage-empty">{emptyState}</div>}
      <div className="lc-canvas-stage-slots">
        <div className="lc-canvas-stage-row" data-row="top">
          <Slot name="top-left">{slots["top-left"]}</Slot>
          <Slot name="top-center">{slots["top-center"]}</Slot>
          <Slot name="top-right">{slots["top-right"]}</Slot>
        </div>
        <div ref={bottomRowRef} className="lc-canvas-stage-row" data-row="bottom">
          <Slot name="bottom-left">{slots["bottom-left"]}</Slot>
          <Slot name="bottom-center">{slots["bottom-center"]}</Slot>
          <Slot name="bottom-right">{slots["bottom-right"]}</Slot>
        </div>
      </div>
    </div>
  );
}

/**
 * Places the app's toasts at the stage's bottom-right corner, above the
 * bottom row of floating controls, by writing the insets the toast region
 * reads. The row is as tall as its tallest slot, so a toast clears the
 * minimap card and the dimension bar alike, and drops to the stage's edge
 * when the row is empty. Off the viewer, the region keeps its own corner.
 */
function useToastInsets(
  stageRef: RefObject<HTMLDivElement | null>,
  rowRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const stage = stageRef.current;
    const row = rowRef.current;
    if (!enabled || !stage || !row || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement.style;
    const place = () => {
      const rowRect = row.getBoundingClientRect();
      // The row's own gap, so a toast sits as far above it as the slots sit apart.
      const gap = rowRect.height > 0 ? parseFloat(getComputedStyle(row).columnGap) || 0 : 0;
      root.setProperty("--toast-inset-bottom", `${Math.max(0, window.innerHeight - rowRect.top + gap)}px`);
      root.setProperty("--toast-inset-right", `${Math.max(0, window.innerWidth - rowRect.right)}px`);
    };
    // The stage moves as well as resizes when a side panel opens or closes.
    const observer = new ResizeObserver(place);
    observer.observe(stage);
    observer.observe(row);
    window.addEventListener("resize", place);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      root.removeProperty("--toast-inset-bottom");
      root.removeProperty("--toast-inset-right");
    };
  }, [stageRef, rowRef, enabled]);
}

function Slot({ name, children }: { name: CanvasSlot; children: ReactNode }) {
  return (
    <div className="lc-canvas-slot" data-slot={name}>
      {children}
    </div>
  );
}
