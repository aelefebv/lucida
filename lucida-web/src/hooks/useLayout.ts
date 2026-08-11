import { useCallback, useEffect, useState } from "react";
import type { RenderLoop } from "../renderLoop.ts";

export function useLayout({
  loopRef,
  captureSurface = false,
}: {
  loopRef: React.RefObject<RenderLoop | null>;
  /** True on the chrome-free capture surface — see `captureSurface.ts`. */
  captureSurface?: boolean;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(captureSurface ? 0 : 280);
  const [canvasWidth, setCanvasWidth] = useState(() =>
    captureSurface && typeof window !== "undefined" ? window.innerWidth : 800,
  );
  const [canvasHeight, setCanvasHeight] = useState(() =>
    captureSurface && typeof window !== "undefined" ? window.innerHeight : 600,
  );

  // The chrome-free capture surface (`?render=1`, used by `dataset montage`,
  // `viewer render` and the trace driver) fills the whole viewport with the canvas so a headless
  // screenshot is pure data — no sidebar, no toolbar. Mirror the window size
  // (the capture drives it via CDP device-metrics) and keep it in sync on resize.
  useEffect(() => {
    if (!captureSurface || typeof window === "undefined") return;
    const sync = () => {
      setCanvasWidth(window.innerWidth);
      setCanvasHeight(window.innerHeight);
      loopRef.current?.markInteractiveDirty();
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [captureSurface, loopRef]);

  const handleSidebarResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const newWidth = Math.min(600, Math.max(180, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
      loopRef.current?.markInteractiveDirty();
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [sidebarWidth, loopRef]);

  const handleCanvasResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = canvasWidth;
    const startH = canvasHeight;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      setCanvasWidth(Math.max(320, startW + ev.clientX - startX));
      setCanvasHeight(Math.max(200, startH + ev.clientY - startY));
      loopRef.current?.markInteractiveDirty();
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [canvasWidth, canvasHeight, loopRef]);

  return { sidebarWidth, canvasWidth, canvasHeight, handleSidebarResizeDown, handleCanvasResizeDown };
}
