import { useEffect, useRef } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop, MinimapOverlayData } from "../renderLoop.ts";
import { drawStaticMinimapOverlays, drawZPlaneOverlays, drawViewportOverlays, zPlaneLayerDirty } from "./minimapOverlay.ts";
import "./Minimap.css";

const MINIMAP_SIZE = 200;

// The page's first draw on a 2D canvas creates the main thread's GPU
// context, one synchronous request on the GPU process's main thread. Made
// during the open, it queued behind the render worker's pipeline compile or
// its first chunk uploads and held the page's main thread for about 100 ms
// on one host and 640 to 710 ms on another, read by the trace as a stall of
// whichever phase was open (#1094, #1101). `willReadFrequently` did not
// avoid it on either host. The hint chooses software raster, and the
// context is created either way.
//
// So the overlay draws once when the minimap mounts, before the worker has
// drawn a frame (the sizing effect), and its content draws wait for the
// worker's report that its pipelines exist (the loop registration effect).
// The mount-time draw waits at most for the worker's shader modules, under
// 30 ms on a hardware adapter, now that the compile itself is off that
// thread.

interface Props {
  client: RenderClient;
  activeLoop: RenderLoop | null;
}

export function Minimap({ client, activeLoop }: Props) {
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const initedRef = useRef(false);
  // Offscreen cache of the Z-invariant (camera/geometry) overlay layer. Redrawn
  // only when `staticDirty` (a camera move or geometry rebuild); on a pure
  // Z-scrub it is blitted back verbatim so the O(N) member-border strokes don't
  // rerun each Z step — only the cheap Z-dependent indicators are re-stroked.
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null);
  const staticReadyRef = useRef(false);
  // Offscreen cache of the Z-plane sub-layer (per-member slice planes). These
  // depend on the current Z but not on pan/zoom, so a 2D pan/zoom blits this
  // back verbatim; it is re-stroked only on a Z-scrub or geometry change. Only
  // the cheap viewport rectangles + orientation cube are redrawn every frame.
  const zLayerRef = useRef<HTMLCanvasElement | null>(null);
  const zReadyRef = useRef(false);
  const prevZRef = useRef<number | null>(null);

  // Effect 1: GPU init
  useEffect(() => {
    const gpuCanvas = gpuCanvasRef.current;
    if (!gpuCanvas || initedRef.current) return;
    initedRef.current = true;
    client.minimapInit(gpuCanvas);
    // No cleanup — context lives for the worker's lifetime.
    // Worker's "destroy" handler cleans up minimap state.
  }, [client]);

  // Effect 2: Loop registration
  useEffect(() => {
    if (!activeLoop) return;

    const drawOverlay = (data: MinimapOverlayData) => {
      const overlayCanvas = overlayCanvasRef.current;
      if (!overlayCanvas) return;
      const ctx = overlayCanvas.getContext("2d");
      if (!ctx) return;

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

      // Rebuild the Z-invariant layer only when it changed (or the cache is
      // empty); a pure Z-scrub reuses it. `getContext` on a canvas that has
      // never had a 2D context is cheap and idempotent.
      if (data.staticDirty || !staticReadyRef.current) {
        const staticCtx = staticLayer.getContext("2d");
        if (staticCtx) {
          drawStaticMinimapOverlays(staticCtx, data);
          staticReadyRef.current = true;
        }
      }

      // Rebuild the Z-plane sub-layer only on a Z-scrub or geometry change (or
      // when the cache is empty / was just resized); a pan/zoom reuses it.
      // `drawZPlaneOverlays` does not clear, so clear the offscreen first.
      if (zPlaneLayerDirty(data, prevZRef.current) || !zReadyRef.current) {
        const zCtx = zLayer.getContext("2d");
        if (zCtx) {
          zCtx.clearRect(0, 0, data.canvasW, data.canvasH);
          drawZPlaneOverlays(zCtx, data);
          zReadyRef.current = true;
          prevZRef.current = data.currentZ;
        }
      }

      // Composite: cached static layer, then the cached Z-plane layer, then the
      // fresh viewport rectangles + orientation cube on top — pixel-identical to
      // a full redraw, in the same draw order (source-over is associative).
      ctx.clearRect(0, 0, data.canvasW, data.canvasH);
      if (staticReadyRef.current) ctx.drawImage(staticLayer, 0, 0);
      if (zReadyRef.current) ctx.drawImage(zLayer, 0, 0);
      drawViewportOverlays(ctx, data);
    };

    // Content draws hold until the worker's pipelines exist, so the first one
    // lands outside the open's first frame (see the note above `Props`).
    let heldBack: MinimapOverlayData | null = null;
    const overlayCallback = (data: MinimapOverlayData) => {
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
    };
  }, [activeLoop, client]);

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

  return (
    <div className="minimap-panel" style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}>
      <canvas
        ref={gpuCanvasRef}
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
      />
      <canvas
        ref={overlayCanvasRef}
        className="minimap-overlay"
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
      />
    </div>
  );
}
