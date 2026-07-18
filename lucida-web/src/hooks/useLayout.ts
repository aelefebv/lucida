import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderLoop } from "../renderLoop.ts";

const MOBILE_SHELL_BREAKPOINT = 800;
const SHELL_INLINE_GUTTER = 48;
const SHELL_BLOCK_CHROME = 260;

export interface LayoutBounds {
  canvasWidth: number;
  canvasHeight: number;
  sidebarVisible: boolean;
}

/** Responsive upper bound shared by pointer/keyboard resizing and ARIA. */
export function responsiveSidebarMax(viewportWidth: number): number {
  const width = Number.isFinite(viewportWidth) ? viewportWidth : 1128;
  return Math.max(180, Math.min(600, width - 360));
}

/** Pure responsive geometry shared by initial layout, resize, and tests. */
export function responsiveLayoutBounds(
  viewportWidth: number,
  viewportHeight: number,
  sidebarWidth: number,
  renderMode = false,
): LayoutBounds {
  const width = Number.isFinite(viewportWidth) ? Math.max(1, viewportWidth) : 800;
  const height = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 600;
  if (renderMode) {
    return { canvasWidth: width, canvasHeight: height, sidebarVisible: false };
  }
  const sidebarVisible = width > MOBILE_SHELL_BREAKPOINT;
  return {
    canvasWidth: Math.max(1, width - (sidebarVisible ? sidebarWidth : 0) - SHELL_INLINE_GUTTER),
    canvasHeight: Math.max(1, height - SHELL_BLOCK_CHROME),
    sidebarVisible,
  };
}

function viewportSize() {
  return typeof window === "undefined"
    ? { width: 1128, height: 860 }
    : { width: window.innerWidth, height: window.innerHeight };
}

export function useLayout({
  loopRef,
  renderMode = false,
}: {
  loopRef: React.RefObject<RenderLoop | null>;
  renderMode?: boolean;
}) {
  const preferredSidebarWidthRef = useRef(renderMode ? 0 : 280);
  const preferredCanvasWidthRef = useRef(800);
  const preferredCanvasHeightRef = useRef(600);
  const [viewport, setViewport] = useState(viewportSize);
  const [sidebarWidth, setSidebarWidth] = useState(renderMode ? 0 : 280);
  const [canvasWidth, setCanvasWidth] = useState(() => {
    const viewport = viewportSize();
    return Math.min(
      800,
      responsiveLayoutBounds(viewport.width, viewport.height, 280, renderMode).canvasWidth,
    );
  });
  const [canvasHeight, setCanvasHeight] = useState(() => {
    const viewport = viewportSize();
    return Math.min(
      600,
      responsiveLayoutBounds(viewport.width, viewport.height, 280, renderMode).canvasHeight,
    );
  });
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    const viewport = viewportSize();
    return responsiveLayoutBounds(viewport.width, viewport.height, 280, renderMode).sidebarVisible;
  });

  // Every shell mode responds to viewport changes. User-selected sizes are kept
  // when there is room and clamped when there is not; capture mode always fills
  // the exact viewport. A single resize path avoids divergent desktop/mobile
  // geometry and guarantees finite positive canvas dimensions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const nextViewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const effectiveSidebarWidth = renderMode
        ? 0
        : Math.min(
          responsiveSidebarMax(nextViewport.width),
          Math.max(180, preferredSidebarWidthRef.current),
        );
      const bounds = responsiveLayoutBounds(
        nextViewport.width,
        nextViewport.height,
        effectiveSidebarWidth,
        renderMode,
      );
      setSidebarWidth(effectiveSidebarWidth);
      setViewport(nextViewport);
      setCanvasWidth(renderMode
        ? bounds.canvasWidth
        : Math.min(preferredCanvasWidthRef.current, bounds.canvasWidth));
      setCanvasHeight(renderMode
        ? bounds.canvasHeight
        : Math.min(preferredCanvasHeightRef.current, bounds.canvasHeight));
      setSidebarVisible(bounds.sidebarVisible);
      loopRef.current?.markInteractiveDirty();
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [loopRef, renderMode, sidebarWidth]);

  const clampSidebar = useCallback((value: number) => {
    const viewport = viewportSize();
    const max = responsiveSidebarMax(viewport.width);
    return Math.min(max, Math.max(180, value));
  }, []);

  const clampCanvas = useCallback((width: number, height: number) => {
    const viewport = viewportSize();
    const bounds = responsiveLayoutBounds(viewport.width, viewport.height, sidebarWidth, renderMode);
    return {
      width: Math.min(bounds.canvasWidth, Math.max(1, width)),
      height: Math.min(bounds.canvasHeight, Math.max(1, height)),
    };
  }, [renderMode, sidebarWidth]);

  const resizeSidebarTo = useCallback((width: number) => {
    const next = clampSidebar(width);
    preferredSidebarWidthRef.current = next;
    setSidebarWidth(next);
    loopRef.current?.markInteractiveDirty();
  }, [clampSidebar, loopRef]);

  const resizeCanvasTo = useCallback((width: number, height: number) => {
    const next = clampCanvas(width, height);
    preferredCanvasWidthRef.current = next.width;
    preferredCanvasHeightRef.current = next.height;
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
    loopRef.current?.markInteractiveDirty();
  }, [clampCanvas, loopRef]);

  const handleSidebarResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => resizeSidebarTo(startWidth + ev.clientX - startX);
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [resizeSidebarTo, sidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (e.key === "Home") resizeSidebarTo(180);
    else if (e.key === "End") resizeSidebarTo(600);
    else resizeSidebarTo(sidebarWidth + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 48 : 16));
  }, [resizeSidebarTo, sidebarWidth]);

  const handleCanvasResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = canvasWidth;
    const startH = canvasHeight;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => resizeCanvasTo(
      startW + ev.clientX - startX,
      startH + ev.clientY - startY,
    );
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [canvasHeight, canvasWidth, resizeCanvasTo]);

  const handleCanvasResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    let width = canvasWidth;
    let height = canvasHeight;
    if (e.key === "ArrowLeft") width -= step;
    else if (e.key === "ArrowRight") width += step;
    else if (e.key === "ArrowUp") height -= step;
    else if (e.key === "ArrowDown") height += step;
    else return;
    e.preventDefault();
    resizeCanvasTo(width, height);
  }, [canvasHeight, canvasWidth, resizeCanvasTo]);

  const canvasBounds = responsiveLayoutBounds(
    viewport.width,
    viewport.height,
    sidebarWidth,
    renderMode,
  );

  return {
    sidebarWidth,
    sidebarMaxWidth: responsiveSidebarMax(viewport.width),
    sidebarVisible,
    canvasWidth,
    canvasHeight,
    canvasMaxWidth: canvasBounds.canvasWidth,
    canvasMaxHeight: canvasBounds.canvasHeight,
    handleSidebarResizeDown,
    handleSidebarResizeKeyDown,
    handleCanvasResizeDown,
    handleCanvasResizeKeyDown,
  };
}
