import { useCallback, useState } from "react";
import type { RenderLoop } from "../renderLoop.ts";

export function useLayout({ loopRef }: { loopRef: React.RefObject<RenderLoop | null> }) {
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [canvasHeight, setCanvasHeight] = useState(600);

  const handleSidebarResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const newWidth = Math.min(600, Math.max(180, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
      loopRef.current?.markDirty();
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
      loopRef.current?.markDirty();
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
