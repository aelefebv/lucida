import { useEffect, useRef } from "react";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop, MinimapOverlayData } from "../renderLoop.ts";
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

    const overlayCallback = (_data: MinimapOverlayData) => {
      const overlayCanvas = overlayCanvasRef.current;
      if (!overlayCanvas) return;
      const ctx = overlayCanvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      }
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
