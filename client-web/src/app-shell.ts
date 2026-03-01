import { resolveRoute } from "./viewer-route";
import { ViewerRuntime, type ViewerRuntimeState } from "./viewer-runtime";

export type AppController = {
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
  const runtime = new ViewerRuntime(resolved.route, (state) => {
    renderRuntimeState(mount, state);
  });
  runtime.start();
  renderRuntimeState(mount, runtime.state());

  return {
    dispose: () => {
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
  <header>
    <h1>Lucida S1 Viewer</h1>
    <p data-testid="route-kind">${routeKind}</p>
  </header>
  <section data-testid="attach-status"></section>
  <section data-testid="capability-state"></section>
  <section data-testid="viewer-layout">
    <div>Viewport canvas target</div>
    <div>Minimap target</div>
    <div>Warnings target</div>
  </section>
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
