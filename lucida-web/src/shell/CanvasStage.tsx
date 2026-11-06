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

  return (
    // `viewer-canvas-wrap` is how the CLI's trace driver finds the canvas,
    // and the canvas stays the page's first, which the capture probe reads.
    <div ref={stageRef} className="lc-canvas-stage viewer-canvas-wrap" data-bare={bare || undefined}>
      <canvas
        key={canvasKey}
        ref={canvasRef}
        tabIndex={0}
        className="lc-canvas-stage-canvas"
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
        <div className="lc-canvas-stage-row" data-row="bottom">
          <Slot name="bottom-left">{slots["bottom-left"]}</Slot>
          <Slot name="bottom-center">{slots["bottom-center"]}</Slot>
          <Slot name="bottom-right">{slots["bottom-right"]}</Slot>
        </div>
      </div>
    </div>
  );
}

function Slot({ name, children }: { name: CanvasSlot; children: ReactNode }) {
  return (
    <div className="lc-canvas-slot" data-slot={name}>
      {children}
    </div>
  );
}
