import { DemoViewerRuntime } from "./demo-runtime";
import {
  resolveRoute,
  type DemoViewerRoute,
  type ViewerRoute,
} from "./viewer-route";
import { ViewerRuntime, type ViewerRuntimeState } from "./viewer-runtime";

export type AppController = {
  dispose: () => void;
};

type RuntimeController = {
  start: () => void;
  pan: (dx: number, dy: number) => void;
  zoom: (scale: number, anchorX: number, anchorY: number) => void;
  setZ: (zIndex: number) => void;
  setT: (tIndex: number) => void;
  setChannels: (channels: number[]) => void;
  state: () => ViewerRuntimeState;
  dispose: () => void;
};

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
  const runtime = createRuntime(resolved.route, (state) => {
    renderRuntimeState(mount, state);
  });
  runtime.start();
  const detachInteractionHandlers = attachInteractionHandlers(
    document,
    mount,
    runtime,
  );
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

function createRuntime(
  route: ViewerRoute | DemoViewerRoute,
  onUpdate: (state: ViewerRuntimeState) => void,
): RuntimeController {
  if (route.kind === "viewer-demo") {
    return new DemoViewerRuntime(route.demoId, onUpdate);
  }
  return new ViewerRuntime(route, onUpdate);
}

function shellMarkup(routeKind: ViewerRuntimeState["routeKind"]): string {
  return `
<main class="viewer-shell" data-route="${routeKind}" data-testid="viewer-shell">
  <header>
    <h1>Lucida S1 Viewer</h1>
    <p data-testid="route-kind">${routeKind}</p>
  </header>
  <section data-testid="attach-status"></section>
  <section data-testid="capability-state"></section>
  <section data-testid="viewer-layout">
    <canvas
      data-testid="viewport-canvas"
      width="384"
      height="256"
      aria-label="Lucida viewport"
      style="display:block;width:min(100%, 960px);height:auto;image-rendering:pixelated;border:1px solid #222;background:#111;"
    ></canvas>
    <p data-testid="viewport-meta">Viewport: waiting for frame</p>
  </section>
  <section data-testid="interaction-controls">
    <button type="button" data-testid="btn-pan-left">Pan Left</button>
    <button type="button" data-testid="btn-pan-right">Pan Right</button>
    <button type="button" data-testid="btn-zoom-in">Zoom In</button>
    <button type="button" data-testid="btn-zoom-out">Zoom Out</button>
  </section>
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

  const viewportMetaNode = mount.querySelector('[data-testid="viewport-meta"]');
  if (viewportMetaNode instanceof HTMLElement) {
    if (state.renderFrame === null) {
      viewportMetaNode.textContent = "Viewport: waiting for frame";
    } else {
      viewportMetaNode.textContent = `Viewport: ${state.renderFrame.width.toString()}x${state.renderFrame.height.toString()} (${state.renderFrame.frameKind})`;
    }
  }

  const frameNode = mount.querySelector('[data-testid="frame-state"]');
  if (frameNode instanceof HTMLElement) {
    if (state.renderFrame === null) {
      frameNode.textContent = "Frame: pending";
    } else {
      frameNode.textContent = `Frame: gen ${state.renderFrame.generationSeq.toString()} (${state.renderFrame.frameKind})`;
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

  const warningNode = mount.querySelector('[data-testid="warning-state"]');
  if (warningNode instanceof HTMLElement) {
    warningNode.textContent =
      state.renderFrame?.warningNotice === null ||
      state.renderFrame?.warningNotice === undefined
        ? "Warnings: none"
        : `Warnings: ${state.renderFrame.warningNotice}`;
  }

  renderViewportCanvas(mount, state);
}

function attachInteractionHandlers(
  document: Document,
  mount: HTMLElement,
  runtime: RuntimeController,
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

  const listeners: Array<{ element: HTMLElement; handler: () => void }> = [];
  const registerClick = (testId: string, handler: () => void): void => {
    const node = mount.querySelector(`[data-testid="${testId}"]`);
    if (!(node instanceof HTMLElement)) {
      return;
    }
    node.addEventListener("click", handler);
    listeners.push({ element: node, handler });
  };
  registerClick("btn-pan-left", () => runtime.pan(-12, 0));
  registerClick("btn-pan-right", () => runtime.pan(12, 0));
  registerClick("btn-zoom-in", () => runtime.zoom(1.2, 0, 0));
  registerClick("btn-zoom-out", () => runtime.zoom(0.8, 0, 0));

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    for (const listener of listeners) {
      listener.element.removeEventListener("click", listener.handler);
    }
  };
}

function renderViewportCanvas(mount: HTMLElement, state: ViewerRuntimeState): void {
  const canvas = mount.querySelector('[data-testid="viewport-canvas"]');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  if (state.renderFrame === null) {
    canvas.setAttribute("data-frame-kind", "pending");
    return;
  }

  canvas.width = state.renderFrame.width;
  canvas.height = state.renderFrame.height;
  canvas.setAttribute("data-frame-kind", state.renderFrame.frameKind);
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  const image = context.createImageData(
    state.renderFrame.width,
    state.renderFrame.height,
  );
  image.data.set(state.renderFrame.rgba);
  context.putImageData(image, 0, 0);
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
