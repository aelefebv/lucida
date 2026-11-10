import { useEffect, useRef } from "react";
import type { Engine } from "../engine.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop, MinimapOverlayData } from "../renderLoop.ts";
import { CanvasCard } from "./CanvasCard.tsx";
import { minimapCardPreference, useCanvasCardState } from "./canvasCards.ts";
import { MinimapNavigator, type MinimapCursor } from "./minimapNavigation.ts";
import { drawStaticMinimapOverlays, drawZPlaneOverlays, drawViewportOverlays, readMinimapColors, zPlaneLayerDirty } from "./minimapOverlay.ts";
import "./Minimap.css";

const MINIMAP_SIZE = 200;

// The page's first 2D-canvas draw creates the main thread's GPU context with a
// synchronous request to the GPU process. Made during an open, it queues behind
// the render worker's pipeline compile and first uploads, stalling the main
// thread by 100 to 700 ms. `willReadFrequently` doesn't avoid it.
//
// So the overlay draws once at mount, before the worker draws a frame (the
// sizing effect), and content draws wait for the worker's report that its
// pipelines exist (the loop registration effect).

interface Props {
  client: RenderClient;
  activeLoop: RenderLoop | null;
  /** The scene minimap input moves, and the main canvas that frames it. */
  engine: Pick<Engine, "scene" | "canvas">;
  emitPresence: () => void;
  breakFollow: () => void;
}

export function Minimap({ client, activeLoop, engine, emitPresence, breakFollow }: Props) {
  // Folded or hidden, the loop stops rendering it. The canvases stay mounted,
  // since the GPU context is bound to this canvas for the worker's life.
  const [cardState] = useCanvasCardState(minimapCardPreference);
  const drawing = cardState === "open";
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const initedRef = useRef(false);
  // Offscreen cache of the Z-invariant layer, redrawn only when `staticDirty`,
  // so the O(N) member-border strokes don't rerun on each Z step.
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null);
  const staticReadyRef = useRef(false);
  // Offscreen cache of the slice planes, which depend on Z but not pan/zoom.
  // Only the viewport rectangles and orientation cube redraw every frame.
  const zLayerRef = useRef<HTMLCanvasElement | null>(null);
  const zReadyRef = useRef(false);
  const prevZRef = useRef<number | null>(null);
  // The frame last drawn, which input maps through, so the minimap does no
  // work of its own for a pointer move.
  const frameRef = useRef<MinimapOverlayData | null>(null);
  const depsRef = useRef({ activeLoop, engine, emitPresence, breakFollow });
  useEffect(() => {
    depsRef.current = { activeLoop, engine, emitPresence, breakFollow };
  });

  // Effect 1: GPU init
  useEffect(() => {
    const gpuCanvas = gpuCanvasRef.current;
    if (!gpuCanvas || initedRef.current) return;
    initedRef.current = true;
    client.minimapInit(gpuCanvas);
    // No cleanup: the context lives as long as the worker, whose "destroy"
    // handler cleans up minimap state.
  }, [client]);

  // Effect 2: Loop registration
  useEffect(() => {
    if (!activeLoop || !drawing) return;

    const drawOverlay = (data: MinimapOverlayData) => {
      const overlayCanvas = overlayCanvasRef.current;
      if (!overlayCanvas) return;
      const ctx = overlayCanvas.getContext("2d");
      if (!ctx) return;
      const colors = readMinimapColors();
      // A device-pixel-ratio change (a window moved to another screen) brings a
      // new backing size; drawn into the old one, the overlay would be cropped.
      if (overlayCanvas.width !== data.canvasW || overlayCanvas.height !== data.canvasH) {
        overlayCanvas.width = data.canvasW;
        overlayCanvas.height = data.canvasH;
      }

      // Maintain the offscreen static-layer cache at the current backing size.
      let staticLayer = staticLayerRef.current;
      if (!staticLayer) {
        staticLayer = document.createElement("canvas");
        staticLayerRef.current = staticLayer;
        staticReadyRef.current = false;
      }
      if (staticLayer.width !== data.canvasW || staticLayer.height !== data.canvasH) {
        staticLayer.width = data.canvasW;
        staticLayer.height = data.canvasH;
        // A resize discards the backing store, so the cache must be rebuilt.
        staticReadyRef.current = false;
      }

      // Maintain the offscreen Z-plane cache at the current backing size.
      let zLayer = zLayerRef.current;
      if (!zLayer) {
        zLayer = document.createElement("canvas");
        zLayerRef.current = zLayer;
        zReadyRef.current = false;
      }
      if (zLayer.width !== data.canvasW || zLayer.height !== data.canvasH) {
        zLayer.width = data.canvasW;
        zLayer.height = data.canvasH;
        // A resize discards the backing store, so the cache must be rebuilt.
        zReadyRef.current = false;
      }

      // A pure Z-scrub reuses the Z-invariant layer.
      if (data.staticDirty || !staticReadyRef.current) {
        const staticCtx = staticLayer.getContext("2d");
        if (staticCtx) {
          drawStaticMinimapOverlays(staticCtx, data, colors);
          staticReadyRef.current = true;
        }
      }

      // A pan/zoom reuses the Z-plane layer. `drawZPlaneOverlays` does not
      // clear, so clear the offscreen first.
      if (zPlaneLayerDirty(data, prevZRef.current) || !zReadyRef.current) {
        const zCtx = zLayer.getContext("2d");
        if (zCtx) {
          zCtx.clearRect(0, 0, data.canvasW, data.canvasH);
          drawZPlaneOverlays(zCtx, data, colors);
          zReadyRef.current = true;
          prevZRef.current = data.currentZ;
        }
      }

      // Same draw order as a full redraw, so the composite is pixel-identical
      // (source-over is associative).
      ctx.clearRect(0, 0, data.canvasW, data.canvasH);
      if (staticReadyRef.current) ctx.drawImage(staticLayer, 0, 0);
      if (zReadyRef.current) ctx.drawImage(zLayer, 0, 0);
      drawViewportOverlays(ctx, data, colors);
    };

    // Content draws hold until the worker's pipelines exist, so the first one
    // lands outside the open's first frame (see the note above `Props`).
    let heldBack: MinimapOverlayData | null = null;
    const overlayCallback = (data: MinimapOverlayData) => {
      frameRef.current = data;
      if (!client.pipelinesCompiled) {
        heldBack = data;
        return;
      }
      drawOverlay(data);
    };
    const withdraw = client.oncePipelinesCompiled(() => {
      if (heldBack) drawOverlay(heldBack);
      heldBack = null;
    });

    activeLoop.setMinimap(true, MINIMAP_SIZE, overlayCallback);
    return () => {
      withdraw();
      activeLoop.setMinimap(false);
      frameRef.current = null;
    };
  }, [activeLoop, client, drawing]);

  // Effect 3: Overlay canvas DPR sizing. The clear is the overlay's first
  // draw, which creates the main thread's GPU context before the worker
  // draws a frame (see the note above `Props`).
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    if (!overlayCanvas) return;
    const backing = Math.round(MINIMAP_SIZE * devicePixelRatio);
    overlayCanvas.width = backing;
    overlayCanvas.height = backing;
    overlayCanvas.getContext("2d")?.clearRect(0, 0, backing, backing);
  }, []);

  // Effect 4: input. One pointer at a time, so a second finger neither
  // steers nor ends the first's gesture.
  useEffect(() => {
    const surface = overlayCanvasRef.current;
    if (!surface) return;
    const navigator = new MinimapNavigator(
      {
        scene: () => depsRef.current.engine.scene(),
        canvas: () => depsRef.current.engine.canvas(),
        loop: () => depsRef.current.activeLoop,
        frame: () => frameRef.current,
        emitPresence: () => depsRef.current.emitPresence(),
        breakFollow: () => depsRef.current.breakFollow(),
      },
      MINIMAP_SIZE,
    );
    let pointerId: number | null = null;
    let cursor: MinimapCursor | null = null;
    const local = (e: MouseEvent): [number, number] => {
      const rect = surface.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const showCursor = (x: number, y: number) => {
      const next = navigator.cursorAt(x, y);
      if (next === cursor) return;
      cursor = next;
      surface.style.cursor = next;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (pointerId !== null || e.button !== 0) return;
      const [x, y] = local(e);
      if (!navigator.pressAt(x, y, e.pointerType, e.timeStamp)) return;
      pointerId = e.pointerId;
      surface.setPointerCapture?.(e.pointerId);
      showCursor(x, y);
    };
    const onPointerMove = (e: PointerEvent) => {
      const [x, y] = local(e);
      if (pointerId === e.pointerId) navigator.moveTo(x, y, e.timeStamp);
      else if (pointerId !== null) return;
      showCursor(x, y);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      const [x, y] = local(e);
      navigator.releaseAt(x, y, e.timeStamp);
      showCursor(x, y);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      navigator.cancel();
    };
    const onWheel = (e: WheelEvent) => {
      const [x, y] = local(e);
      if (navigator.wheelAt(x, y, e.deltaY, e.timeStamp)) e.preventDefault();
    };
    // Handled here, the arrows never reach the window's shortcuts, which pan
    // the slice view by a share of the canvas instead.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (navigator.key(e.key, e.timeStamp)) e.preventDefault();
    };
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("keydown", onKeyDown);
    return () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("keydown", onKeyDown);
      navigator.cancel();
    };
  }, []);

  return (
    <CanvasCard title="Minimap" label="Minimap" preference={minimapCardPreference}>
      <div className="minimap-panel" style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}>
        <canvas
          ref={gpuCanvasRef}
          style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
        />
        {/* The input surface, which the trace driver finds by its class. */}
        <canvas
          ref={overlayCanvasRef}
          className="minimap-overlay"
          role="application"
          aria-label="Minimap: click or drag to move the view, arrow keys pan"
          tabIndex={0}
          style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
        />
      </div>
    </CanvasCard>
  );
}
