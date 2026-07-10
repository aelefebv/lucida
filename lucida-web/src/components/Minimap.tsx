import { useEffect, useRef } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop, MinimapOverlayData } from "../renderLoop.ts";
import { drawStaticMinimapOverlays, drawDynamicMinimapOverlays } from "./minimapOverlay.ts";
import "./Minimap.css";

const MINIMAP_SIZE = 200;

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

    const overlayCallback = (data: MinimapOverlayData) => {
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

      // Composite: cached static layer, then the fresh Z-dependent indicators
      // on top — pixel-identical to a full redraw, in the same draw order.
      ctx.clearRect(0, 0, data.canvasW, data.canvasH);
      if (staticReadyRef.current) ctx.drawImage(staticLayer, 0, 0);
      drawDynamicMinimapOverlays(ctx, data);
    };

    activeLoop.setMinimap(true, MINIMAP_SIZE, overlayCallback);
    return () => {
      activeLoop.setMinimap(false);
    };
  }, [activeLoop]);

  // Effect 3: Overlay canvas DPR sizing
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    if (!overlayCanvas) return;
    const backing = Math.round(MINIMAP_SIZE * devicePixelRatio);
    overlayCanvas.width = backing;
    overlayCanvas.height = backing;
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
