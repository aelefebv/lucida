import {
  applyContrastWindowToSamples,
  autoContrastWindow,
  normalizeContrastWindow,
  type ContrastWindow,
} from "./contrast-window";
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
    <canvas data-testid="viewport-canvas" width="1" height="1"></canvas>
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
  <section data-testid="interaction-controls">
    <button type="button" data-testid="btn-pan-left">Pan Left</button>
    <button type="button" data-testid="btn-pan-right">Pan Right</button>
    <button type="button" data-testid="btn-zoom-in">Zoom In</button>
    <button type="button" data-testid="btn-zoom-out">Zoom Out</button>
  </section>
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
      frameNode.textContent = `Frame: gen ${state.renderFrame.generationSeq.toString()} (${state.renderFrame.frameKind}) min ${stats.min.toString()} max ${stats.max.toString()} nz ${(stats.nonZeroRatio * 100).toFixed(2)}%`;
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

  renderViewportCanvas(mount, state);
}

function attachInteractionHandlers(
  document: Document,
  mount: HTMLElement,
  runtime: ViewerRuntime,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowLeft") {
      runtime.pan(-12, 0);
      return;
    }
    if (event.key === "ArrowRight") {
      runtime.pan(12, 0);
      return;
    }
    if (event.key === "+") {
      runtime.zoom(1.2, 0, 0);
      return;
    }
    if (event.key === "-") {
      runtime.zoom(0.8, 0, 0);
      return;
    }
    if (event.key === "]") {
      runtime.setZ(1);
      return;
    }
    if (event.key === "t") {
      runtime.setT(1);
      return;
    }
    if (event.key === "c") {
      runtime.setChannels([0, 1]);
    }
  };
  document.addEventListener("keydown", onKeyDown);

  const listeners: Array<{
    element: HTMLElement;
    event: "click" | "input";
    handler: EventListener;
  }> = [];
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
  registerClick("btn-pan-left", () => runtime.pan(-12, 0));
  registerClick("btn-pan-right", () => runtime.pan(12, 0));
  registerClick("btn-zoom-in", () => runtime.zoom(1.2, 0, 0));
  registerClick("btn-zoom-out", () => runtime.zoom(0.8, 0, 0));
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

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    for (const listener of listeners) {
      listener.element.removeEventListener(listener.event, listener.handler);
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

  if (state.renderFrame === null) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }

  const frame = state.renderFrame;
  canvas.width = frame.width;
  canvas.height = frame.height;

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
  const imageData = context.createImageData(frame.width, frame.height);
  imageData.data.set(contrasted);
  context.putImageData(imageData, 0, 0);
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

function initializeContrastControls(mount: HTMLElement): void {
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
  const current = readContrastControlsState(mount);
  if (current.userAdjusted) {
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
