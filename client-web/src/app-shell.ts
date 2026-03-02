import {
  applyContrastWindowToSamples,
  autoContrastWindow,
  normalizeContrastWindow,
  type ContrastWindow,
} from "./contrast-window";
import { selectionBoundsFor } from "./client-store";
import { resolveRoute } from "./viewer-route";
import { ViewerRuntime, type ViewerRuntimeState } from "./viewer-runtime";

export type AppController = {
  dispose: () => void;
};

type ContrastControlsState = ContrastWindow & {
  sampleMax: number;
  userAdjusted: boolean;
};

const DEFAULT_CONTRAST_MIN = 0;
const DEFAULT_CONTRAST_MAX = 255;
const DEFAULT_AXIS_SLIDER_MAX = 4095;
const ZOOM_IN_SCALE = 1.2;
const ZOOM_OUT_SCALE = 1 / ZOOM_IN_SCALE;
const KEYBOARD_PAN_STEP_CSS_PX = 24;
const MIN_VIEWPORT_DIMENSION_PX = 1;
const MAX_VIEWPORT_DIMENSION_PX = 8192;
const DEFAULT_VIEWPORT_WIDTH_PX = 1;
const DEFAULT_VIEWPORT_HEIGHT_PX = 1;

export function bootstrapApp(
  document: Document = window.document,
  location: Location = window.location,
): AppController {
  const mount = ensureMount(document);
  const resolved = resolveRoute(location);

  if (!resolved.ok) {
    mount.innerHTML = `<main data-testid="route-error"><h1>Lucida Viewer</h1><p>${escapeHtml(
      resolved.message,
    )}</p></main>`;
    return { dispose: () => {} };
  }

  mount.innerHTML = shellMarkup(resolved.route.kind);
  initializeContrastControls(mount);
  initializeViewportSizeControls(mount);
  const runtime = new ViewerRuntime(resolved.route, (state) => {
    renderRuntimeState(mount, state);
  });
  runtime.start();
  const detachInteractionHandlers = attachInteractionHandlers(document, mount, runtime);
  renderRuntimeState(mount, runtime.state());

  return {
    dispose: () => {
      detachInteractionHandlers();
      runtime.dispose();
    },
  };
}

function ensureMount(document: Document): HTMLElement {
  const existing = document.getElementById("app");
  if (existing instanceof HTMLElement) {
    return existing;
  }
  const created = document.createElement("div");
  created.id = "app";
  document.body.appendChild(created);
  return created;
}

function shellMarkup(routeKind: "viewer" | "jupyter-viewer"): string {
  return `
<main class="viewer-shell" data-route="${routeKind}" data-testid="viewer-shell">
  <style>
    .viewer-shell .viewport-frame {
      position: relative;
      display: inline-block;
      line-height: 0;
    }
    .viewer-shell .viewport-frame canvas {
      display: block;
    }
    .viewer-shell .viewport-resize-handle {
      position: absolute;
      z-index: 2;
      background: rgba(255, 255, 255, 0.01);
    }
    .viewer-shell .viewport-resize-handle[data-direction="n"],
    .viewer-shell .viewport-resize-handle[data-direction="s"] {
      left: 8px;
      right: 8px;
      height: 8px;
      cursor: ns-resize;
    }
    .viewer-shell .viewport-resize-handle[data-direction="n"] {
      top: -4px;
    }
    .viewer-shell .viewport-resize-handle[data-direction="s"] {
      bottom: -4px;
    }
    .viewer-shell .viewport-resize-handle[data-direction="e"],
    .viewer-shell .viewport-resize-handle[data-direction="w"] {
      top: 8px;
      bottom: 8px;
      width: 8px;
      cursor: ew-resize;
    }
    .viewer-shell .viewport-resize-handle[data-direction="e"] {
      right: -4px;
    }
    .viewer-shell .viewport-resize-handle[data-direction="w"] {
      left: -4px;
    }
    .viewer-shell .viewport-resize-handle[data-direction="ne"],
    .viewer-shell .viewport-resize-handle[data-direction="nw"],
    .viewer-shell .viewport-resize-handle[data-direction="se"],
    .viewer-shell .viewport-resize-handle[data-direction="sw"] {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.08);
    }
    .viewer-shell .viewport-resize-handle[data-direction="ne"] {
      top: -5px;
      right: -5px;
      cursor: nesw-resize;
    }
    .viewer-shell .viewport-resize-handle[data-direction="nw"] {
      top: -5px;
      left: -5px;
      cursor: nwse-resize;
    }
    .viewer-shell .viewport-resize-handle[data-direction="se"] {
      bottom: -5px;
      right: -5px;
      cursor: nwse-resize;
    }
    .viewer-shell .viewport-resize-handle[data-direction="sw"] {
      bottom: -5px;
      left: -5px;
      cursor: nesw-resize;
    }
    .viewer-shell .dual-range {
      position: relative;
      width: 320px;
      height: 24px;
    }
    .viewer-shell .dual-range-track {
      position: absolute;
      left: 0;
      right: 0;
      top: 10px;
      height: 4px;
      background: #b0b0b0;
      border-radius: 2px;
    }
    .viewer-shell .dual-range-active {
      position: absolute;
      top: 10px;
      height: 4px;
      background: #202020;
      border-radius: 2px;
      left: 0%;
      right: 0%;
    }
    .viewer-shell .dual-range input[type="range"] {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 24px;
      margin: 0;
      background: transparent;
      pointer-events: none;
      -webkit-appearance: none;
      appearance: none;
    }
    .viewer-shell .dual-range input[type="range"]::-webkit-slider-runnable-track {
      height: 4px;
      background: transparent;
    }
    .viewer-shell .dual-range input[type="range"]::-moz-range-track {
      height: 4px;
      background: transparent;
    }
    .viewer-shell .dual-range input[type="range"]::-webkit-slider-thumb {
      width: 14px;
      height: 14px;
      margin-top: -5px;
      border: 1px solid #ffffff;
      border-radius: 50%;
      background: #101010;
      pointer-events: auto;
      cursor: pointer;
      -webkit-appearance: none;
      appearance: none;
    }
    .viewer-shell .dual-range input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border: 1px solid #ffffff;
      border-radius: 50%;
      background: #101010;
      pointer-events: auto;
      cursor: pointer;
    }
  </style>
  <header>
    <h1>Lucida S1 Viewer</h1>
    <p data-testid="route-kind">${routeKind}</p>
  </header>
  <section data-testid="attach-status"></section>
  <section data-testid="capability-state"></section>
  <section data-testid="viewer-layout">
    <div>Viewport canvas target</div>
    <div class="viewport-frame" data-testid="viewport-frame">
      <canvas data-testid="viewport-canvas" width="1" height="1"></canvas>
      <div class="viewport-resize-handle" data-testid="viewport-resize-n" data-direction="n"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-s" data-direction="s"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-e" data-direction="e"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-w" data-direction="w"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-ne" data-direction="ne"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-nw" data-direction="nw"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-se" data-direction="se"></div>
      <div class="viewport-resize-handle" data-testid="viewport-resize-sw" data-direction="sw"></div>
    </div>
    <div>Minimap target</div>
    <canvas data-testid="minimap-canvas" width="1" height="1"></canvas>
    <div>Warnings target</div>
  </section>
  <section data-testid="open-source-controls">
    <label>
      Source Name
      <input data-testid="input-source-name" type="text" value="source" />
    </label>
    <label>
      Source URI
      <input data-testid="input-source-uri" type="text" placeholder="/absolute/path/data.ome.zarr" />
    </label>
    <button type="button" data-testid="btn-open-source">Open Source</button>
  </section>
  <section data-testid="open-source-status">Source action: idle</section>
  <section data-testid="axis-controls">
    <label>
      Z
      <input data-testid="input-z-index" type="range" min="0" max="0" step="1" value="0" />
    </label>
    <label>
      T
      <input data-testid="input-t-index" type="range" min="0" max="0" step="1" value="0" />
    </label>
    <label>
      Channels
      <input data-testid="input-channel-list" type="text" value="0" />
    </label>
    <button type="button" data-testid="btn-channels-apply">Set Channels</button>
  </section>
  <section data-testid="viewport-size-controls">
    <div>Drag viewport edges/corners to resize</div>
    <output data-testid="viewport-size-values">${DEFAULT_VIEWPORT_WIDTH_PX.toString()} x ${DEFAULT_VIEWPORT_HEIGHT_PX.toString()}</output>
  </section>
  <section data-testid="selection-state"></section>
  <section data-testid="contrast-controls">
    <div>Contrast Limits</div>
    <div class="dual-range" data-testid="contrast-dual-slider">
      <div class="dual-range-track"></div>
      <div class="dual-range-active" data-testid="contrast-range-active"></div>
      <input
        data-testid="slider-contrast-min"
        type="range"
        min="0"
        max="255"
        step="1"
        value="0"
        aria-label="Contrast minimum"
      />
      <input
        data-testid="slider-contrast-max"
        type="range"
        min="0"
        max="255"
        step="1"
        value="255"
        aria-label="Contrast maximum"
      />
    </div>
    <button type="button" data-testid="btn-contrast-auto">Auto Contrast</button>
    <output data-testid="contrast-values">0-255</output>
  </section>
  <section data-testid="contrast-state"></section>
  <section data-testid="frame-state"></section>
  <section data-testid="minimap-state"></section>
  <section data-testid="warning-state"></section>
  ${
    routeKind === "jupyter-viewer"
      ? '<section data-testid="jupyter-target">Jupyter iframe target route ready.</section>'
      : ""
  }
</main>`;
}

function renderRuntimeState(mount: HTMLElement, state: ViewerRuntimeState): void {
  maybeAutoSetContrastFromFrame(mount, state);
  syncSelectionInputsFromState(mount, state);
  const statusNode = mount.querySelector('[data-testid="attach-status"]');
  if (statusNode instanceof HTMLElement) {
    statusNode.textContent = `Attach phase: ${phaseLabel(state.connection.phase)}`;
  }

  const capabilityNode = mount.querySelector('[data-testid="capability-state"]');
  if (capabilityNode instanceof HTMLElement) {
    if (state.connectionSummary === null) {
      capabilityNode.textContent = "Capability state: pending";
    } else {
      capabilityNode.textContent = `Capability state: ${state.connectionSummary}`;
    }
  }

  const layoutNode = mount.querySelector('[data-testid="viewer-layout"]');
  if (layoutNode instanceof HTMLElement) {
    const sessionId = state.clientState?.sessionId ?? "n/a";
    const clientId = state.clientState?.clientId ?? "n/a";
    layoutNode.setAttribute("data-session-id", sessionId);
    layoutNode.setAttribute("data-client-id", clientId);
  }

  const frameNode = mount.querySelector('[data-testid="frame-state"]');
  if (frameNode instanceof HTMLElement) {
    if (state.renderFrame === null) {
      frameNode.textContent = "Frame: pending";
    } else {
      const stats = state.renderFrame.pixelStats;
      const zoom = state.clientState?.zoom ?? 1;
      const panX = state.clientState?.centerX ?? 0;
      const panY = state.clientState?.centerY ?? 0;
      frameNode.textContent = `Frame: gen ${state.renderFrame.generationSeq.toString()} (${state.renderFrame.frameKind}) min ${stats.min.toString()} max ${stats.max.toString()} nz ${(stats.nonZeroRatio * 100).toFixed(2)}%`;
      frameNode.textContent += ` zoom ${zoom.toFixed(2)} pan (${panX.toFixed(1)}, ${panY.toFixed(1)})`;
    }
  }

  const minimapNode = mount.querySelector('[data-testid="minimap-state"]');
  if (minimapNode instanceof HTMLElement) {
    if (state.renderFrame === null) {
      minimapNode.textContent = "Minimap: pending";
    } else {
      minimapNode.textContent = `Minimap: ${state.renderFrame.minimap.zIndicatorLabel}`;
    }
  }
  const contrastNode = mount.querySelector('[data-testid="contrast-state"]');
  if (contrastNode instanceof HTMLElement) {
    const contrast = readContrastControlsState(mount);
    contrastNode.textContent = `Contrast: ${contrast.min.toString()}-${contrast.max.toString()} / ${contrast.sampleMax.toString()}`;
  }

  const warningNode = mount.querySelector('[data-testid="warning-state"]');
  if (warningNode instanceof HTMLElement) {
    const serverWarning =
      state.renderFrame?.warningNotice === null ||
      state.renderFrame?.warningNotice === undefined
        ? null
        : state.renderFrame.warningNotice;
    const emptyFrameWarning =
      state.renderFrame !== null && state.renderFrame.pixelStats.max === 0
        ? "Frame is empty at current selection (all pixels are zero)."
        : null;
    const warnings = [serverWarning, emptyFrameWarning].filter(
      (value): value is string => value !== null,
    );
    warningNode.textContent =
      warnings.length === 0 ? "Warnings: none" : `Warnings: ${warnings.join(" | ")}`;
  }

  const selectionNode = mount.querySelector('[data-testid="selection-state"]');
  if (selectionNode instanceof HTMLElement) {
    if (state.clientState === null) {
      selectionNode.textContent = "Selection: pending";
    } else {
      selectionNode.textContent = `Selection: z ${state.clientState.zIndex.toString()} t ${state.clientState.tIndex.toString()} c [${state.clientState.selectedChannels.join(", ")}]`;
    }
  }

  renderViewportCanvas(mount, state);
}

function attachInteractionHandlers(
  document: Document,
  mount: HTMLElement,
  runtime: ViewerRuntime,
): () => void {
  const withClientState = (
    fn: (
      zIndex: number,
      tIndex: number,
      channels: number[],
      maxZIndex: number | null,
      maxTIndex: number | null,
      maxChannelIndex: number | null,
    ) => void,
  ): void => {
    const state = runtime.state().clientState;
    if (state === null) {
      fn(0, 0, [0], null, null, null);
      return;
    }
    const bounds = selectionBoundsFor(state);
    fn(
      state.zIndex,
      state.tIndex,
      state.selectedChannels,
      bounds?.maxZIndex ?? null,
      bounds?.maxTIndex ?? null,
      bounds?.maxChannelIndex ?? null,
    );
  };

  const panByScreenPixels = (panXCss: number, panYCss: number): void => {
    const canvas = mount.querySelector('[data-testid="viewport-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) {
      runtime.pan(panXCss, panYCss);
      return;
    }
    const zoom = normalizeZoom(runtime.currentZoom());
    const displayScale = canvasDisplayScale(canvas);
    runtime.pan(
      panXCss / (zoom * displayScale.x),
      panYCss / (zoom * displayScale.y),
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowLeft") {
      panByScreenPixels(-KEYBOARD_PAN_STEP_CSS_PX, 0);
      return;
    }
    if (event.key === "ArrowRight") {
      panByScreenPixels(KEYBOARD_PAN_STEP_CSS_PX, 0);
      return;
    }
    if (event.key === "ArrowUp") {
      panByScreenPixels(0, -KEYBOARD_PAN_STEP_CSS_PX);
      return;
    }
    if (event.key === "ArrowDown") {
      panByScreenPixels(0, KEYBOARD_PAN_STEP_CSS_PX);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      runtime.zoom(ZOOM_IN_SCALE, 0, 0);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      runtime.zoom(ZOOM_OUT_SCALE, 0, 0);
      return;
    }
    if (event.key === "]") {
      withClientState((zIndex, _, __, maxZIndex) => {
        runtime.setZ(clampAxisIndex(zIndex + 1, maxZIndex));
      });
      return;
    }
    if (event.key === "[") {
      withClientState((zIndex, _, __, maxZIndex) => {
        runtime.setZ(clampAxisIndex(zIndex - 1, maxZIndex));
      });
      return;
    }
    if (event.key === "." || event.key === "t") {
      withClientState((_, tIndex, __, ___, maxTIndex) => {
        runtime.setT(clampAxisIndex(tIndex + 1, maxTIndex));
      });
      return;
    }
    if (event.key === "," || event.key === "T") {
      withClientState((_, tIndex, __, ___, maxTIndex) => {
        runtime.setT(clampAxisIndex(tIndex - 1, maxTIndex));
      });
      return;
    }
    if (event.key === "c") {
      withClientState((_, __, channels, ___, ____, maxChannelIndex) => {
        const current = channels[0] ?? 0;
        runtime.setChannels([clampAxisIndex(current + 1, maxChannelIndex)]);
      });
    }
    if (event.key === "C") {
      withClientState((_, __, channels, ___, ____, maxChannelIndex) => {
        const current = channels[0] ?? 0;
        runtime.setChannels([clampAxisIndex(current - 1, maxChannelIndex)]);
      });
    }
  };
  document.addEventListener("keydown", onKeyDown);

  const listeners: Array<{
    element: HTMLElement;
    event: "click" | "input";
    handler: EventListener;
  }> = [];
  const viewportDisposers: Array<() => void> = [];
  const registerListener = (
    testId: string,
    event: "click" | "input",
    handler: EventListener,
  ): void => {
    const node = mount.querySelector(`[data-testid="${testId}"]`);
    if (!(node instanceof HTMLElement)) {
      return;
    }
    node.addEventListener(event, handler);
    listeners.push({ element: node, event, handler });
  };
  const registerClick = (testId: string, handler: () => void): void => {
    registerListener(testId, "click", () => {
      handler();
    });
  };
  const registerInput = (testId: string, handler: () => void): void => {
    registerListener(testId, "input", () => {
      handler();
    });
  };
  registerInput("input-z-index", () => {
    const clientState = runtime.state().clientState;
    const bounds = clientState === null ? null : selectionBoundsFor(clientState);
    const zIndex = readIndexInput(
      mount,
      "input-z-index",
      clientState?.zIndex ?? 0,
      bounds?.maxZIndex ?? null,
    );
    const input = mount.querySelector('[data-testid="input-z-index"]');
    if (input instanceof HTMLInputElement) {
      input.value = zIndex.toString();
    }
    runtime.setZ(zIndex);
  });
  registerInput("input-t-index", () => {
    const clientState = runtime.state().clientState;
    const bounds = clientState === null ? null : selectionBoundsFor(clientState);
    const tIndex = readIndexInput(
      mount,
      "input-t-index",
      clientState?.tIndex ?? 0,
      bounds?.maxTIndex ?? null,
    );
    const input = mount.querySelector('[data-testid="input-t-index"]');
    if (input instanceof HTMLInputElement) {
      input.value = tIndex.toString();
    }
    runtime.setT(tIndex);
  });
  registerClick("btn-channels-apply", () => {
    const clientState = runtime.state().clientState;
    const bounds = clientState === null ? null : selectionBoundsFor(clientState);
    const channelInput = mount.querySelector('[data-testid="input-channel-list"]');
    if (!(channelInput instanceof HTMLInputElement)) {
      return;
    }
    const parsedChannels = parseChannelList(
      channelInput.value,
      bounds?.maxChannelIndex ?? null,
    );
    runtime.setChannels(parsedChannels);
  });
  registerClick("btn-open-source", () => {
    const nameInput = mount.querySelector('[data-testid="input-source-name"]');
    const uriInput = mount.querySelector('[data-testid="input-source-uri"]');
    if (!(nameInput instanceof HTMLInputElement) || !(uriInput instanceof HTMLInputElement)) {
      setOpenSourceStatus(mount, "Source action unavailable.");
      return;
    }
    setOpenSourceStatus(mount, "Opening source...");
    void runtime.openSource(nameInput.value, uriInput.value).then((result) => {
      setOpenSourceStatus(mount, result.message);
    });
  });
  registerInput("slider-contrast-min", () => {
    applyUserContrastSelection(mount);
    renderRuntimeState(mount, runtime.state());
  });
  registerInput("slider-contrast-max", () => {
    applyUserContrastSelection(mount);
    renderRuntimeState(mount, runtime.state());
  });
  registerClick("btn-contrast-auto", () => {
    const frame = runtime.state().renderFrame;
    if (frame === null) {
      setContrastControlsState(mount, {
        min: DEFAULT_CONTRAST_MIN,
        max: DEFAULT_CONTRAST_MAX,
        sampleMax: DEFAULT_CONTRAST_MAX,
        userAdjusted: false,
      });
    } else {
      const autoWindow = autoContrastWindow(
        frame.pixelStats.min,
        frame.pixelStats.max,
        frame.sampleMax,
      );
      setContrastControlsState(mount, {
        ...autoWindow,
        sampleMax: frame.sampleMax,
        userAdjusted: false,
      });
    }
    renderRuntimeState(mount, runtime.state());
  });
  let activeResize: {
    direction: ViewportResizeDirection;
    startClientX: number;
    startClientY: number;
    startWidth: number;
    startHeight: number;
  } | null = null;
  const resizeHandleNodes = mount.querySelectorAll<HTMLElement>('[data-direction]');
  const onResizeHandleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const direction = parseViewportResizeDirection(target.getAttribute("data-direction"));
    if (direction === null) {
      return;
    }
    const dimensions = readViewportDimensions(mount);
    activeResize = {
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: dimensions.width,
      startHeight: dimensions.height,
    };
    event.preventDefault();
    event.stopPropagation();
  };
  const onDocumentMouseMoveResize = (event: MouseEvent): void => {
    if (activeResize === null) {
      return;
    }
    const deltaX = event.clientX - activeResize.startClientX;
    const deltaY = event.clientY - activeResize.startClientY;
    const nextDimensions = resizedViewportDimensions(
      activeResize.direction,
      activeResize.startWidth,
      activeResize.startHeight,
      deltaX,
      deltaY,
    );
    setViewportDimensions(mount, nextDimensions, true);
    renderRuntimeState(mount, runtime.state());
    event.preventDefault();
  };
  const stopResize = (): void => {
    activeResize = null;
  };
  for (const handle of resizeHandleNodes) {
    handle.addEventListener("mousedown", onResizeHandleMouseDown);
  }
  document.addEventListener("mousemove", onDocumentMouseMoveResize);
  document.addEventListener("mouseup", stopResize);
  document.addEventListener("mouseleave", stopResize);
  viewportDisposers.push(() => {
    for (const handle of resizeHandleNodes) {
      handle.removeEventListener("mousedown", onResizeHandleMouseDown);
    }
    document.removeEventListener("mousemove", onDocumentMouseMoveResize);
    document.removeEventListener("mouseup", stopResize);
    document.removeEventListener("mouseleave", stopResize);
  });

  const viewportCanvas = mount.querySelector('[data-testid="viewport-canvas"]');
  if (viewportCanvas instanceof HTMLCanvasElement) {
    let isDragging = false;
    let lastClientX = 0;
    let lastClientY = 0;

    const onViewportMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      isDragging = true;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      event.preventDefault();
    };

    const onDocumentMouseMove = (event: MouseEvent): void => {
      if (!isDragging) {
        return;
      }
      const dx = event.clientX - lastClientX;
      const dy = event.clientY - lastClientY;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      if (dx === 0 && dy === 0) {
        return;
      }
      // Keep the image under the cursor while dragging.
      panByScreenPixels(-dx, -dy);
      event.preventDefault();
    };

    const onDocumentMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      isDragging = false;
    };

    const onDocumentMouseLeave = (): void => {
      isDragging = false;
    };

    const onViewportWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) {
        return;
      }
      const rect = viewportCanvas.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const scale = event.deltaY < 0 ? ZOOM_IN_SCALE : ZOOM_OUT_SCALE;
      runtime.zoom(scale, anchorX, anchorY);
      event.preventDefault();
    };

    viewportCanvas.addEventListener("mousedown", onViewportMouseDown);
    document.addEventListener("mousemove", onDocumentMouseMove);
    document.addEventListener("mouseup", onDocumentMouseUp);
    document.addEventListener("mouseleave", onDocumentMouseLeave);
    viewportCanvas.addEventListener("wheel", onViewportWheel, { passive: false });

    viewportDisposers.push(() => {
      viewportCanvas.removeEventListener("mousedown", onViewportMouseDown);
      document.removeEventListener("mousemove", onDocumentMouseMove);
      document.removeEventListener("mouseup", onDocumentMouseUp);
      document.removeEventListener("mouseleave", onDocumentMouseLeave);
      viewportCanvas.removeEventListener("wheel", onViewportWheel);
    });
  }

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    for (const listener of listeners) {
      listener.element.removeEventListener(listener.event, listener.handler);
    }
    for (const dispose of viewportDisposers) {
      dispose();
    }
  };
}

function phaseLabel(phase: ViewerRuntimeState["connection"]["phase"]): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting";
    case "attached":
      return "Attached";
    case "error":
      return "Error";
  }
}

function renderViewportCanvas(mount: HTMLElement, state: ViewerRuntimeState): void {
  const canvas = mount.querySelector('[data-testid="viewport-canvas"]');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }

  const viewportDimensions = readViewportDimensions(mount);
  if (state.renderFrame === null) {
    canvas.width = viewportDimensions.width;
    canvas.height = viewportDimensions.height;
    applyViewportCanvasPresentation(canvas);
    return;
  }

  const frame = state.renderFrame;
  maybeAutoFitViewportToFrame(mount, frame.width, frame.height);
  const effectiveViewportDimensions = readViewportDimensions(mount);
  canvas.width = effectiveViewportDimensions.width;
  canvas.height = effectiveViewportDimensions.height;
  applyViewportCanvasPresentation(canvas);

  const context = tryGet2dContext(canvas);
  if (context === null) {
    return;
  }
  const contrast = readContrastControlsState(mount);
  const contrasted = applyContrastWindowToSamples(
    frame.grayscaleSamples,
    contrast,
    frame.sampleMax,
  );
  const imageData = context.createImageData(
    effectiveViewportDimensions.width,
    effectiveViewportDimensions.height,
  );
  const zoom = normalizeZoom(state.clientState?.zoom ?? 1);
  const panX = state.clientState?.centerX ?? 0;
  const panY = state.clientState?.centerY ?? 0;
  writeViewportPixels(
    contrasted,
    frame.width,
    frame.height,
    panX,
    panY,
    zoom,
    effectiveViewportDimensions.width,
    effectiveViewportDimensions.height,
    imageData.data,
  );
  context.putImageData(imageData, 0, 0);
}

function writeViewportPixels(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  panX: number,
  panY: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  output: Uint8ClampedArray,
): void {
  const centerX = (sourceWidth / 2) + panX;
  const centerY = (sourceHeight / 2) + panY;
  for (let y = 0; y < viewportHeight; y += 1) {
    const sourceY = Math.round(centerY + (y - viewportHeight / 2) / zoom);
    for (let x = 0; x < viewportWidth; x += 1) {
      const outBase = ((y * viewportWidth) + x) * 4;
      const sourceX = Math.round(centerX + (x - viewportWidth / 2) / zoom);
      if (sourceX < 0 || sourceX >= sourceWidth || sourceY < 0 || sourceY >= sourceHeight) {
        output[outBase] = 0;
        output[outBase + 1] = 0;
        output[outBase + 2] = 0;
        output[outBase + 3] = 255;
        continue;
      }
      const sourceBase = ((sourceY * sourceWidth) + sourceX) * 4;
      output[outBase] = source[sourceBase] ?? 0;
      output[outBase + 1] = source[sourceBase + 1] ?? 0;
      output[outBase + 2] = source[sourceBase + 2] ?? 0;
      output[outBase + 3] = source[sourceBase + 3] ?? 255;
    }
  }
}

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(0.1, Math.min(32, value));
}

function tryGet2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    const context = canvas.getContext("2d");
    if (context === null) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setOpenSourceStatus(mount: HTMLElement, message: string): void {
  const statusNode = mount.querySelector('[data-testid="open-source-status"]');
  if (!(statusNode instanceof HTMLElement)) {
    return;
  }
  statusNode.textContent = message;
}

function syncSelectionInputsFromState(
  mount: HTMLElement,
  state: ViewerRuntimeState,
): void {
  const clientState = state.clientState;
  if (clientState === null) {
    return;
  }
  const bounds = selectionBoundsFor(clientState);
  const zInput = mount.querySelector('[data-testid="input-z-index"]');
  if (zInput instanceof HTMLInputElement) {
    const maxZIndex = bounds?.maxZIndex ?? DEFAULT_AXIS_SLIDER_MAX;
    zInput.max = maxZIndex.toString();
    zInput.value = clampAxisIndex(clientState.zIndex, maxZIndex).toString();
  }
  const tInput = mount.querySelector('[data-testid="input-t-index"]');
  if (tInput instanceof HTMLInputElement) {
    const maxTIndex = bounds?.maxTIndex ?? DEFAULT_AXIS_SLIDER_MAX;
    tInput.max = maxTIndex.toString();
    tInput.value = clampAxisIndex(clientState.tIndex, maxTIndex).toString();
  }
  const channelInput = mount.querySelector('[data-testid="input-channel-list"]');
  if (channelInput instanceof HTMLInputElement) {
    channelInput.value = clampChannels(
      clientState.selectedChannels,
      bounds?.maxChannelIndex ?? null,
    ).join(",");
  }
}

function readIndexInput(
  mount: HTMLElement,
  testId: string,
  fallback: number,
  maxIndex: number | null = null,
): number {
  const input = mount.querySelector(`[data-testid="${testId}"]`);
  if (!(input instanceof HTMLInputElement)) {
    return clampAxisIndex(fallback, maxIndex);
  }
  const parsed = Number.parseInt(input.value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return clampAxisIndex(fallback, maxIndex);
  }
  return clampAxisIndex(parsed, maxIndex);
}

function parseChannelList(value: string, maxIndex: number | null = null): number[] {
  const entries = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const channels: number[] = [];
  for (const entry of entries) {
    const parsed = Number.parseInt(entry, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      continue;
    }
    channels.push(clampAxisIndex(parsed, maxIndex));
  }
  if (channels.length === 0) {
    return [clampAxisIndex(0, maxIndex)];
  }
  return [...new Set(channels)];
}

function clampAxisIndex(value: number, maxIndex: number | null): number {
  const nonNegative = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  if (maxIndex === null || !Number.isFinite(maxIndex)) {
    return nonNegative;
  }
  return Math.min(nonNegative, Math.max(0, Math.floor(maxIndex)));
}

function clampChannels(channels: number[], maxIndex: number | null): number[] {
  const clamped = channels
    .map((channel) => clampAxisIndex(channel, maxIndex))
    .filter((channel, index, values) => values.indexOf(channel) === index);
  if (clamped.length > 0) {
    return clamped;
  }
  return [clampAxisIndex(0, maxIndex)];
}

type ViewportResizeDirection =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

function parseViewportResizeDirection(value: string | null): ViewportResizeDirection | null {
  switch (value) {
    case "n":
    case "s":
    case "e":
    case "w":
    case "ne":
    case "nw":
    case "se":
    case "sw":
      return value;
    default:
      return null;
  }
}

function resizedViewportDimensions(
  direction: ViewportResizeDirection,
  startWidth: number,
  startHeight: number,
  deltaX: number,
  deltaY: number,
): { width: number; height: number } {
  let width = startWidth;
  let height = startHeight;
  if (direction.includes("e")) {
    width = startWidth + deltaX;
  } else if (direction.includes("w")) {
    width = startWidth - deltaX;
  }
  if (direction.includes("s")) {
    height = startHeight + deltaY;
  } else if (direction.includes("n")) {
    height = startHeight - deltaY;
  }
  return {
    width: normalizeViewportDimension(width),
    height: normalizeViewportDimension(height),
  };
}

function initializeViewportSizeControls(mount: HTMLElement): void {
  setViewportDimensions(
    mount,
    {
      width: DEFAULT_VIEWPORT_WIDTH_PX,
      height: DEFAULT_VIEWPORT_HEIGHT_PX,
    },
    false,
  );
}

function maybeAutoFitViewportToFrame(
  mount: HTMLElement,
  frameWidth: number,
  frameHeight: number,
): void {
  const userAdjusted = mount.getAttribute("data-viewport-user-adjusted") === "true";
  if (userAdjusted) {
    return;
  }
  setViewportDimensions(
    mount,
    {
      width: frameWidth,
      height: frameHeight,
    },
    false,
  );
}

function applyViewportCanvasPresentation(canvas: HTMLCanvasElement): void {
  // Keep enlarged viewport pixels sharp instead of browser-smoothed.
  canvas.style.imageRendering = "pixelated";
  canvas.style.width = `${canvas.width.toString()}px`;
  canvas.style.height = `${canvas.height.toString()}px`;
}

function canvasDisplayScale(
  canvas: HTMLCanvasElement,
): { x: number; y: number } {
  const intrinsicWidth = Math.max(1, canvas.width);
  const intrinsicHeight = Math.max(1, canvas.height);
  const rect = canvas.getBoundingClientRect();
  const fromRectX =
    rect.width > 0 ? rect.width / intrinsicWidth : Number.NaN;
  const fromRectY =
    rect.height > 0 ? rect.height / intrinsicHeight : Number.NaN;
  const fromStyleX = parseCssPixels(canvas.style.width) / intrinsicWidth;
  const fromStyleY = parseCssPixels(canvas.style.height) / intrinsicHeight;
  return {
    x: normalizeDisplayScale(fromRectX, fromStyleX),
    y: normalizeDisplayScale(fromRectY, fromStyleY),
  };
}

function parseCssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return parsed;
}

function normalizeDisplayScale(...candidates: number[]): number {
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 1;
}

function normalizeViewportDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_VIEWPORT_DIMENSION_PX;
  }
  const rounded = Math.round(value);
  return Math.min(
    MAX_VIEWPORT_DIMENSION_PX,
    Math.max(MIN_VIEWPORT_DIMENSION_PX, rounded),
  );
}

function readViewportDimensions(mount: HTMLElement): { width: number; height: number } {
  const widthStored = mount.getAttribute("data-viewport-width");
  const heightStored = mount.getAttribute("data-viewport-height");
  const widthParsed =
    widthStored === null ? Number.NaN : Number.parseInt(widthStored, 10);
  const heightParsed =
    heightStored === null ? Number.NaN : Number.parseInt(heightStored, 10);
  return {
    width: normalizeViewportDimension(widthParsed),
    height: normalizeViewportDimension(heightParsed),
  };
}

function setViewportDimensions(
  mount: HTMLElement,
  dimensions: { width: number; height: number },
  userAdjusted: boolean,
): void {
  const width = normalizeViewportDimension(dimensions.width);
  const height = normalizeViewportDimension(dimensions.height);
  mount.setAttribute("data-viewport-width", width.toString());
  mount.setAttribute("data-viewport-height", height.toString());
  mount.setAttribute("data-viewport-user-adjusted", userAdjusted ? "true" : "false");
  const output = mount.querySelector('[data-testid="viewport-size-values"]');
  if (output instanceof HTMLOutputElement || output instanceof HTMLElement) {
    output.textContent = `${width.toString()} x ${height.toString()}`;
  }
}

function initializeContrastControls(mount: HTMLElement): void {
  mount.removeAttribute("data-contrast-auto-source-id");
  setContrastControlsState(mount, {
    min: DEFAULT_CONTRAST_MIN,
    max: DEFAULT_CONTRAST_MAX,
    sampleMax: DEFAULT_CONTRAST_MAX,
    userAdjusted: false,
  });
}

function maybeAutoSetContrastFromFrame(
  mount: HTMLElement,
  state: ViewerRuntimeState,
): void {
  if (state.renderFrame === null) {
    return;
  }
  syncContrastSliderLimit(mount, state.renderFrame.sampleMax);
  const previousAutoSourceId = mount.getAttribute("data-contrast-auto-source-id");
  if (previousAutoSourceId === state.renderFrame.sourceId) {
    return;
  }
  const autoWindow = autoContrastWindow(
    state.renderFrame.pixelStats.min,
    state.renderFrame.pixelStats.max,
    state.renderFrame.sampleMax,
  );
  setContrastControlsState(mount, {
    ...autoWindow,
    sampleMax: state.renderFrame.sampleMax,
    userAdjusted: false,
  });
  mount.setAttribute("data-contrast-auto-source-id", state.renderFrame.sourceId);
}

function applyUserContrastSelection(mount: HTMLElement): void {
  const minInput = mount.querySelector(
    '[data-testid="slider-contrast-min"]',
  );
  const maxInput = mount.querySelector(
    '[data-testid="slider-contrast-max"]',
  );
  if (
    !(minInput instanceof HTMLInputElement) ||
    !(maxInput instanceof HTMLInputElement)
  ) {
    return;
  }
  const sampleMax = readSliderSampleMax(mount);
  const normalized = normalizeContrastWindow({
    min: Number.parseInt(minInput.value, 10),
    max: Number.parseInt(maxInput.value, 10),
  }, sampleMax);
  setContrastControlsState(mount, {
    ...normalized,
    sampleMax,
    userAdjusted: true,
  });
}

function readContrastControlsState(mount: HTMLElement): ContrastControlsState {
  const minInput = mount.querySelector(
    '[data-testid="slider-contrast-min"]',
  );
  const maxInput = mount.querySelector(
    '[data-testid="slider-contrast-max"]',
  );
  const userAdjusted = mount.getAttribute("data-contrast-user-adjusted") === "true";
  const sampleMax = readSliderSampleMax(mount);
  const minRaw =
    minInput instanceof HTMLInputElement
      ? Number.parseInt(minInput.value, 10)
      : DEFAULT_CONTRAST_MIN;
  const maxRaw =
    maxInput instanceof HTMLInputElement
      ? Number.parseInt(maxInput.value, 10)
      : DEFAULT_CONTRAST_MAX;
  const normalized = normalizeContrastWindow(
    { min: minRaw, max: maxRaw },
    sampleMax,
  );
  return {
    ...normalized,
    sampleMax,
    userAdjusted,
  };
}

function setContrastControlsState(
  mount: HTMLElement,
  state: ContrastControlsState,
): void {
  const sampleMax = normalizeSampleMax(state.sampleMax);
  const normalized = normalizeContrastWindow(state, sampleMax);
  mount.setAttribute(
    "data-contrast-user-adjusted",
    state.userAdjusted ? "true" : "false",
  );
  mount.setAttribute("data-contrast-sample-max", sampleMax.toString());
  const minInput = mount.querySelector(
    '[data-testid="slider-contrast-min"]',
  );
  const maxInput = mount.querySelector(
    '[data-testid="slider-contrast-max"]',
  );
  if (minInput instanceof HTMLInputElement) {
    minInput.max = sampleMax.toString();
    minInput.value = normalized.min.toString();
  }
  if (maxInput instanceof HTMLInputElement) {
    maxInput.max = sampleMax.toString();
    maxInput.value = normalized.max.toString();
  }
  const valueNode = mount.querySelector('[data-testid="contrast-values"]');
  if (valueNode instanceof HTMLOutputElement || valueNode instanceof HTMLElement) {
    valueNode.textContent = `${normalized.min.toString()}-${normalized.max.toString()} / ${sampleMax.toString()}`;
  }
  updateContrastActiveRangeVisual(
    mount,
    normalized.min,
    normalized.max,
    sampleMax,
  );
}

function updateContrastActiveRangeVisual(
  mount: HTMLElement,
  min: number,
  max: number,
  sampleMax: number,
): void {
  const activeRange = mount.querySelector('[data-testid="contrast-range-active"]');
  if (!(activeRange instanceof HTMLElement)) {
    return;
  }
  const denominator = Math.max(1, sampleMax);
  const left = (min / denominator) * 100;
  const right = ((denominator - max) / denominator) * 100;
  activeRange.style.left = `${left.toFixed(2)}%`;
  activeRange.style.right = `${right.toFixed(2)}%`;
}

function syncContrastSliderLimit(mount: HTMLElement, sampleMax: number): void {
  const normalizedSampleMax = normalizeSampleMax(sampleMax);
  const current = readContrastControlsState(mount);
  if (current.sampleMax === normalizedSampleMax) {
    return;
  }
  setContrastControlsState(mount, {
    min: current.min,
    max: current.max,
    sampleMax: normalizedSampleMax,
    userAdjusted: current.userAdjusted,
  });
}

function readSliderSampleMax(mount: HTMLElement): number {
  const stored = mount.getAttribute("data-contrast-sample-max");
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  return normalizeSampleMax(parsed);
}

function normalizeSampleMax(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONTRAST_MAX;
  }
  const rounded = Math.round(value);
  if (rounded < 1) {
    return 1;
  }
  return rounded;
}
