import { useEffect, useState } from "react";
import type { RenderLoop } from "../renderLoop.ts";

/** Debug-only FPS sourced from completed GPU frames, never browser RAF ticks. */
export function FpsCounter({ loop }: { loop: RenderLoop | null }) {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!loop) return;
    return loop.subscribePresentedFrame(() => {
      setFps(loop.getDebugSnapshot().fps ?? 0);
    });
  }, [loop]);

  return (
    <div
      aria-label={`Presented frame rate: ${fps} frames per second`}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 10,
        background: "var(--overlay-panel)",
        color: "white",
        fontFamily: "monospace",
        fontSize: 12,
        padding: "2px 6px",
        borderRadius: 4,
        pointerEvents: "none",
      }}
    >
      {fps} FPS
    </div>
  );
}
