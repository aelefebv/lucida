import { useEffect, useRef } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop, MinimapOverlayData } from "../renderLoop.ts";
import { drawStaticMinimapOverlays, drawZPlaneOverlays, drawViewportOverlays, zPlaneLayerDirty } from "./minimapOverlay.ts";
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
}

export function Minimap({ client, activeLoop }: Props) {
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

      // A pure Z-scrub reuses the Z-invariant layer.
      if (data.staticDirty || !staticReadyRef.current) {
        const staticCtx = staticLayer.getContext("2d");
        if (staticCtx) {
          drawStaticMinimapOverlays(staticCtx, data);
          staticReadyRef.current = true;
        }
      }

      // A pan/zoom reuses the Z-plane layer. `drawZPlaneOverlays` does not
      // clear, so clear the offscreen first.
      if (zPlaneLayerDirty(data, prevZRef.current) || !zReadyRef.current) {
        const zCtx = zLayer.getContext("2d");
        if (zCtx) {
          zCtx.clearRect(0, 0, data.canvasW, data.canvasH);
          drawZPlaneOverlays(zCtx, data);
          zReadyRef.current = true;
          prevZRef.current = data.currentZ;
        }
      }

      // Same draw order as a full redraw, so the composite is pixel-identical
      // (source-over is associative).
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
