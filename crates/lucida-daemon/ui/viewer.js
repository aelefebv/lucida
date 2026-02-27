const PLANE_ROLES = {
  xy: ["x", "y", "z"],
  xz: ["x", "z", "y"],
  yz: ["y", "z", "x"],
};

const helpers = globalThis.LucidaViewerHelpers;
if (!helpers) {
  throw new Error("viewer helpers are unavailable; /ui/viewer_helpers.js must load first.");
}

const state = {
  connected: false,
  stream: null,
  viewId: null,
  sessionId: null,
  viewState: null,
  localViewState: null,
  pendingPatchByPath: new Map(),
  commit: {
    timer: null,
    inFlight: false,
    debounceMs: 140,
  },
  renderController: null,
  drag: {
    active: false,
    pointerId: null,
    lastClientX: 0,
    lastClientY: 0,
  },
  panPending: {
    dxPx: 0,
    dyPx: 0,
    timer: null,
  },
  render: {
    lastDraftAtMs: 0,
    minDraftIntervalMs: 55,
    draftTimer: null,
    pendingDraftTrigger: null,
    settleTimer: null,
    settleDebounceMs: 130,
    draftScale: 0.62,
    maxDraftEdgePx: 768,
    minDraftEdgePx: 320,
  },
};

const el = {
  viewId: document.querySelector("#view-id"),
  sessionId: document.querySelector("#session-id"),
  refreshTargets: document.querySelector("#refresh-targets"),
  renderWidth: document.querySelector("#render-width"),
  renderHeight: document.querySelector("#render-height"),
  planeSelect: document.querySelector("#plane-select"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  renderNow: document.querySelector("#render-now"),
  streamStatus: document.querySelector("#stream-status"),
  lastEndpoint: document.querySelector("#last-endpoint"),
  stateHash: document.querySelector("#state-hash"),
  stateVersion: document.querySelector("#state-version"),
  backendUsed: document.querySelector("#backend-used"),
  renderStatus: document.querySelector("#render-status"),
  renderTotalMs: document.querySelector("#render-total-ms"),
  selectorControls: document.querySelector("#selector-controls"),
  viewportNote: document.querySelector("#viewport-note"),
  viewport: document.querySelector("#viewport"),
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasPendingLocalChanges() {
  return state.pendingPatchByPath.size > 0;
}

function getActiveViewState() {
  if (state.localViewState) {
    return state.localViewState;
  }
  return state.viewState;
}

function isFormField(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    target.isContentEditable
  );
}

function setStreamStatus(text, isError = false) {
  el.streamStatus.textContent = text;
  el.streamStatus.className = isError ? "status-value danger" : "status-value";
}

function setRenderStatus(text, isError = false) {
  el.renderStatus.textContent = text;
  el.renderStatus.className = isError ? "status-value danger" : "status-value";
}

function setViewportNote(text, isError = false) {
  el.viewportNote.textContent = text;
  el.viewportNote.className = isError ? "note danger" : "note";
}

function clampRenderSize(value, fallback) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(64, Math.min(2048, Math.round(parsed)));
}

function buildQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") {
      return;
    }
    query.set(key, String(value));
  });
  return query.toString();
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed (${response.status})`);
  }
  return response.json();
}

function selectedSessionId() {
  const value = String(el.sessionId.value || "").trim();
  return value || null;
}

function selectedViewId() {
  const value = String(el.viewId.value || "").trim();
  return value || null;
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function cancelInFlightRender() {
  if (state.renderController) {
    state.renderController.abort();
    state.renderController = null;
  }
}

function clearPanQueue() {
  if (state.panPending.timer) {
    clearTimeout(state.panPending.timer);
    state.panPending.timer = null;
  }
  state.panPending.dxPx = 0;
  state.panPending.dyPx = 0;
}

function clearRenderTimers() {
  if (state.render.draftTimer) {
    clearTimeout(state.render.draftTimer);
    state.render.draftTimer = null;
  }
  state.render.pendingDraftTrigger = null;
  if (state.render.settleTimer) {
    clearTimeout(state.render.settleTimer);
    state.render.settleTimer = null;
  }
}

function clearCommitTimer() {
  if (state.commit.timer) {
    clearTimeout(state.commit.timer);
    state.commit.timer = null;
  }
}

function stopDragging() {
  state.drag.active = false;
  state.drag.pointerId = null;
  el.viewport.classList.remove("dragging");
}

function resetPanelsOnDisconnect() {
  el.lastEndpoint.textContent = "-";
  el.stateHash.textContent = "-";
  el.stateVersion.textContent = "-";
  el.backendUsed.textContent = "-";
  el.renderTotalMs.textContent = "-";
  setRenderStatus("idle");
  el.selectorControls.innerHTML = "<p>Connect to load axis controls.</p>";
}

function disconnect() {
  state.connected = false;
  closeStream();
  cancelInFlightRender();
  clearRenderTimers();
  clearPanQueue();
  clearCommitTimer();
  stopDragging();

  state.viewId = null;
  state.sessionId = null;
  state.viewState = null;
  state.localViewState = null;
  state.pendingPatchByPath.clear();
  state.commit.inFlight = false;

  setStreamStatus("disconnected");
  setViewportNote("Connect and render to display frames.");
  resetPanelsOnDisconnect();
}

function updateStatePanel(payload, endpoint) {
  if (endpoint) {
    el.lastEndpoint.textContent = endpoint;
  }
  const stateHash = payload.state_hash ?? payload.view_state?.state_hash;
  if (stateHash !== null && stateHash !== undefined) {
    el.stateHash.textContent = String(stateHash);
  }

  const stateVersion = payload.state_version ?? payload.view_state?.state_version;
  if (stateVersion !== null && stateVersion !== undefined) {
    el.stateVersion.textContent = String(stateVersion);
  }
}

function updateTimingPanel(payload) {
  const totalMs = payload?.meta?.timing_ms?.total;
  if (Number.isFinite(totalMs)) {
    el.renderTotalMs.textContent = `${Number(totalMs).toFixed(1)} ms`;
  } else {
    el.renderTotalMs.textContent = "-";
  }
}

function decodeBase64ToBytes(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function showImage(src) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "viewer frame";
  img.draggable = false;
  el.viewport.innerHTML = "";
  el.viewport.appendChild(img);
}

function showRgbaCanvas(bytes, width, height) {
  const rgba = new Uint8ClampedArray(bytes.buffer.slice(0));
  const imageData = new ImageData(rgba, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }
  context.putImageData(imageData, 0, 0);
  el.viewport.innerHTML = "";
  el.viewport.appendChild(canvas);
}

function setSessionOptions(sessions, selectedId) {
  el.sessionId.innerHTML = "";
  const anyOption = document.createElement("option");
  anyOption.value = "";
  anyOption.textContent = "Any session";
  el.sessionId.appendChild(anyOption);

  sessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.session_id;
    option.textContent = `${session.session_id} (${session.view_count} views)`;
    el.sessionId.appendChild(option);
  });

  if (selectedId && sessions.some((session) => session.session_id === selectedId)) {
    el.sessionId.value = selectedId;
  } else {
    el.sessionId.value = "";
  }
}

function setViewOptions(views, selectedId) {
  el.viewId.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = views.length === 0 ? "No active views" : "Select a view";
  el.viewId.appendChild(placeholder);

  views.forEach((view) => {
    const option = document.createElement("option");
    option.value = view.view_id;
    option.textContent = `${view.view_id} (${view.mode}, ${view.session_id})`;
    el.viewId.appendChild(option);
  });

  if (selectedId && views.some((view) => view.view_id === selectedId)) {
    el.viewId.value = selectedId;
    return;
  }
  if (views.length > 0) {
    el.viewId.value = views[0].view_id;
  } else {
    el.viewId.value = "";
  }
}

async function refreshViews(preferredViewId = null) {
  const sessionId = selectedSessionId();
  const previousViewId = preferredViewId || selectedViewId();
  const query = buildQuery({ session_id: sessionId });
  const payload = await fetchJSON(query ? `/view/list?${query}` : "/view/list");
  const views = Array.isArray(payload.views) ? payload.views : [];
  setViewOptions(views, previousViewId);
}

async function refreshTargets(options = {}) {
  const previousSessionId = options.preferredSessionId || selectedSessionId();
  const previousViewId = options.preferredViewId || selectedViewId();
  const sessionPayload = await fetchJSON("/session/list");
  const sessions = Array.isArray(sessionPayload.sessions) ? sessionPayload.sessions : [];
  setSessionOptions(sessions, previousSessionId);
  await refreshViews(previousViewId);
}

async function fetchViewState(scope) {
  const query = buildQuery({ session_id: scope.sessionId });
  const url = query
    ? `/view/${encodeURIComponent(scope.viewId)}?${query}`
    : `/view/${encodeURIComponent(scope.viewId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load view (${response.status})`);
  }
  const payload = await response.json();
  if (!payload.view_state) {
    throw new Error("missing view_state payload");
  }
  return payload.view_state;
}

function renderSelectorControls() {
  const activeView = getActiveViewState();
  const selectors = Array.isArray(activeView?.selectors) ? activeView.selectors : [];
  el.selectorControls.innerHTML = "";

  if (selectors.length === 0) {
    el.selectorControls.innerHTML = "<p>No selectors available for the connected view.</p>";
    return;
  }

  const sorted = [...selectors].sort((left, right) =>
    String(left.axis).localeCompare(String(right.axis)),
  );

  sorted.forEach((selector) => {
    const row = document.createElement("article");
    row.className = "selector-row";

    const title = document.createElement("strong");
    title.textContent = String(selector.axis || "(axis)");
    row.appendChild(title);

    if (selector.kind !== "index") {
      const meta = document.createElement("div");
      meta.className = "selector-meta";
      meta.textContent = `kind=${String(selector.kind || "unknown")} (read-only in viewer)`;
      row.appendChild(meta);
      el.selectorControls.appendChild(row);
      return;
    }

    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    input.value = String(Number(selector.index || 0));
    input.addEventListener("change", () => {
      const next = Number.parseInt(input.value, 10);
      if (!Number.isFinite(next)) {
        input.value = String(Number(selector.index || 0));
        return;
      }
      applySelectorIndex(String(selector.axis), Math.round(next));
    });
    row.appendChild(input);

    const meta = document.createElement("div");
    meta.className = "selector-meta";
    meta.textContent = "index selector";
    row.appendChild(meta);

    el.selectorControls.appendChild(row);
  });
}

function syncControlsFromActiveView() {
  const activeView = getActiveViewState();
  const plane = activeView?.view_2d?.plane;
  if (plane && Object.prototype.hasOwnProperty.call(PLANE_ROLES, plane)) {
    el.planeSelect.value = plane;
  }
  renderSelectorControls();
}

function setCommittedViewState(viewState, endpoint = "/view/{view_id}", syncLocal = true) {
  state.viewState = viewState;
  state.viewId = viewState.view_id || state.viewId;
  state.sessionId = viewState.session_id || state.sessionId;
  updateStatePanel(viewState, endpoint);

  if (syncLocal || !state.localViewState) {
    state.localViewState = deepClone(viewState);
  }

  syncControlsFromActiveView();
}

function decodeJsonPointerToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function setByJsonPointer(root, pointer, value) {
  if (pointer === "") {
    throw new Error("root replacement is unsupported in viewer patch application");
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid json pointer: ${pointer}`);
  }

  const segments = pointer
    .split("/")
    .slice(1)
    .map(decodeJsonPointerToken);

  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    const next = current[key];
    if (next === null || next === undefined) {
      const nextKey = segments[i + 1];
      const container = /^\d+$/.test(nextKey) ? [] : {};
      current[key] = container;
      current = container;
    } else {
      current = next;
    }
  }

  const leaf = segments[segments.length - 1];
  current[leaf] = deepClone(value);
}

function applyLocalPatch(patch, reason) {
  const activeView = getActiveViewState();
  if (!activeView) {
    throw new Error("viewer has no active view state");
  }

  for (const op of patch) {
    if (!op || op.op !== "replace" || typeof op.path !== "string") {
      throw new Error("viewer only supports replace operations in local patch application");
    }
    setByJsonPointer(state.localViewState, op.path, op.value);
    state.pendingPatchByPath.set(op.path, {
      op: "replace",
      path: op.path,
      value: deepClone(op.value),
    });
  }

  syncControlsFromActiveView();
  setViewportNote(`Applied ${reason}.`);
}

function scheduleCommit(reason, delayMs = state.commit.debounceMs) {
  if (!state.connected) {
    return;
  }
  clearCommitTimer();
  state.commit.timer = setTimeout(() => {
    state.commit.timer = null;
    flushLocalCommit(reason);
  }, Math.max(0, delayMs));
}

async function flushLocalCommit(reason, attempt = 0) {
  if (!state.connected || state.commit.inFlight || !hasPendingLocalChanges()) {
    return;
  }
  if (!state.viewState) {
    return;
  }

  state.commit.inFlight = true;
  setRenderStatus("syncing state");

  const commitEntries = Array.from(state.pendingPatchByPath.entries()).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  const patch = commitEntries.map((entry) => deepClone(entry[1]));
  const commitSignatures = new Map(commitEntries.map(([path, op]) => [path, JSON.stringify(op)]));

  const request = {
    schema_version: 1,
    view_id: state.viewId,
    expected_state_version: Number(state.viewState.state_version || 0),
    patch,
  };
  if (state.sessionId) {
    request.session_id = state.sessionId;
  }

  try {
    const response = await fetch("/view/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (response.status === 409 && attempt < 1) {
      const refreshed = await fetchViewState({
        viewId: state.viewId,
        sessionId: state.sessionId,
      });
      setCommittedViewState(refreshed, "/view/{view_id}", false);
      state.commit.inFlight = false;
      return flushLocalCommit(`${reason}_retry`, attempt + 1);
    }

    if (!response.ok) {
      setRenderStatus(`sync error (${response.status})`, true);
      setViewportNote(`State sync failed (${response.status}).`, true);
      state.commit.inFlight = false;
      return;
    }

    const payload = await response.json();
    if (!payload.view_state) {
      setRenderStatus("sync error", true);
      setViewportNote("State sync response missing view_state.", true);
      state.commit.inFlight = false;
      return;
    }

    for (const [path, signature] of commitSignatures.entries()) {
      const current = state.pendingPatchByPath.get(path);
      if (current && JSON.stringify(current) === signature) {
        state.pendingPatchByPath.delete(path);
      }
    }

    const shouldSyncLocal = !hasPendingLocalChanges();
    setCommittedViewState(payload.view_state, "/view/update", shouldSyncLocal);
    if (shouldSyncLocal) {
      setRenderStatus("synced");
    } else {
      setRenderStatus("syncing state");
      scheduleCommit("followup_sync", 40);
    }
  } catch (error) {
    setRenderStatus("sync error", true);
    setViewportNote(String(error), true);
  } finally {
    state.commit.inFlight = false;
  }
}

async function bootstrapViewState(scope) {
  const viewState = await fetchViewState(scope);
  setCommittedViewState(viewState, "/view/{view_id}", true);
}

function connectStream(scope) {
  closeStream();
  const query = buildQuery({
    view_id: scope.viewId,
    session_id: scope.sessionId,
  });
  const stream = new EventSource(`/view/events/stream?${query}`);
  state.stream = stream;

  stream.addEventListener("open", () => {
    if (!state.connected) {
      return;
    }
    setStreamStatus("connected");
  });

  stream.addEventListener("error", () => {
    if (!state.connected) {
      return;
    }
    setStreamStatus("reconnecting", true);
  });

  stream.addEventListener("view_event", async (rawEvent) => {
    if (!state.connected) {
      return;
    }
    try {
      const event = JSON.parse(rawEvent.data);
      updateStatePanel(event, event.endpoint || "/view/events/stream");

      if (event.event_type !== "view_state_committed") {
        return;
      }
      if (hasPendingLocalChanges() || state.drag.active || state.commit.inFlight) {
        return;
      }

      const eventVersion = Number(event.state_version ?? -1);
      const localVersion = Number(state.viewState?.state_version ?? -1);
      if (eventVersion > localVersion) {
        await bootstrapViewState({ viewId: state.viewId, sessionId: state.sessionId });
        scheduleSettleRender("stream_update");
      }
    } catch (_) {
      setStreamStatus("stream parse error", true);
    }
  });
}

async function connect() {
  const scope = {
    viewId: selectedViewId(),
    sessionId: selectedSessionId(),
  };
  if (!scope.viewId) {
    setStreamStatus("select a view_id first", true);
    return;
  }

  disconnect();

  state.connected = true;
  state.viewId = scope.viewId;
  state.sessionId = scope.sessionId;
  state.pendingPatchByPath.clear();

  setStreamStatus("connecting");
  try {
    await bootstrapViewState(scope);
  } catch (error) {
    setStreamStatus(String(error), true);
    disconnect();
    return;
  }

  connectStream(scope);
  setViewportNote("Connected. Drag or wheel in viewport to navigate.");
  await renderFrame({ reason: "connect", format: "png", stage: "final" });
}

function requestDraftRender(trigger) {
  if (!state.connected) {
    return;
  }

  const now = Date.now();
  const elapsed = now - state.render.lastDraftAtMs;
  if (elapsed < state.render.minDraftIntervalMs) {
    state.render.pendingDraftTrigger = trigger;
    if (state.render.draftTimer) {
      return;
    }
    const waitMs = state.render.minDraftIntervalMs - elapsed;
    state.render.draftTimer = setTimeout(() => {
      state.render.draftTimer = null;
      const deferredTrigger = state.render.pendingDraftTrigger || "draft";
      state.render.pendingDraftTrigger = null;
      requestDraftRender(deferredTrigger);
    }, waitMs);
    return;
  }

  state.render.lastDraftAtMs = now;
  renderFrame({ reason: trigger, format: "raw_rgba", stage: "draft" });
}

function scheduleSettleRender(trigger) {
  if (!state.connected) {
    return;
  }
  if (state.render.settleTimer) {
    clearTimeout(state.render.settleTimer);
  }
  state.render.settleTimer = setTimeout(() => {
    state.render.settleTimer = null;
    renderFrame({ reason: trigger, format: "png", stage: "final" });
  }, state.render.settleDebounceMs);
}

function resolveRenderDimensions(stage) {
  const fullWidth = clampRenderSize(el.renderWidth.value, 1024);
  const fullHeight = clampRenderSize(el.renderHeight.value, 1024);

  if (stage !== "draft") {
    return { width: fullWidth, height: fullHeight };
  }

  const longest = Math.max(fullWidth, fullHeight);
  const scaledLongest = Math.round(longest * state.render.draftScale);
  const targetLongest = Math.max(
    state.render.minDraftEdgePx,
    Math.min(state.render.maxDraftEdgePx, scaledLongest),
  );
  if (targetLongest >= longest) {
    return { width: fullWidth, height: fullHeight };
  }

  const scale = targetLongest / longest;
  const width = clampRenderSize(Math.round(fullWidth * scale), fullWidth);
  const height = clampRenderSize(Math.round(fullHeight * scale), fullHeight);
  return { width, height };
}

function viewStateForRender(stage) {
  const active = getActiveViewState();
  if (!active) {
    return null;
  }
  const copy = deepClone(active);

  const quality = stage === "draft" ? "draft" : "final";
  copy.performance = {
    ...(copy.performance || {}),
    quality,
    progressive: true,
    lod_mode: "auto",
    fixed_level: null,
    prefer_gpu: true,
    target_frame_ms: stage === "draft" ? 55 : 180,
    max_cpu_cache_bytes:
      copy.performance && copy.performance.max_cpu_cache_bytes !== undefined
        ? copy.performance.max_cpu_cache_bytes
        : null,
    max_gpu_cache_bytes:
      copy.performance && copy.performance.max_gpu_cache_bytes !== undefined
        ? copy.performance.max_gpu_cache_bytes
        : null,
  };

  return copy;
}

async function renderFrame({ reason, format, stage }) {
  if (!state.connected) {
    return;
  }

  const renderViewState = viewStateForRender(stage);
  if (!renderViewState) {
    setStreamStatus("no active view state", true);
    return;
  }

  cancelInFlightRender();
  const controller = new AbortController();
  state.renderController = controller;

  const dimensions = resolveRenderDimensions(stage);
  el.renderWidth.value = String(clampRenderSize(el.renderWidth.value, 1024));
  el.renderHeight.value = String(clampRenderSize(el.renderHeight.value, 1024));

  setRenderStatus(`rendering ${stage}`);
  setViewportNote(`Rendering ${stage} (${reason})...`);

  try {
    const request = {
      schema_version: 1,
      view_state: renderViewState,
      output: {
        format,
        delivery: "inline_base64",
        width_px: dimensions.width,
        height_px: dimensions.height,
      },
    };
    if (state.sessionId) {
      request.session_id = state.sessionId;
    }

    const response = await fetch("/render/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      setRenderStatus(`error (${response.status})`, true);
      setViewportNote(`Render failed (${response.status}).`, true);
      return;
    }

    const payload = await response.json();
    const image = Array.isArray(payload.images) ? payload.images[0] : null;
    if (!image || !image.bytes_base64) {
      setRenderStatus("error (artifact)", true);
      setViewportNote("Render response has no inline image.", true);
      return;
    }

    if (format === "raw_rgba") {
      if (image.mime !== "application/x-raw-rgba") {
        setRenderStatus("error (mime)", true);
        setViewportNote(`Unexpected raw mime: ${String(image.mime || "(missing)")}.`, true);
        return;
      }

      const artifactWidth = clampRenderSize(image.width_px, dimensions.width);
      const artifactHeight = clampRenderSize(image.height_px, dimensions.height);
      const bytes = decodeBase64ToBytes(image.bytes_base64);
      const expectedLength = artifactWidth * artifactHeight * 4;
      if (bytes.length !== expectedLength) {
        setRenderStatus("error (size)", true);
        setViewportNote(
          `Raw frame size mismatch. expected=${expectedLength} actual=${bytes.length}.`,
          true,
        );
        return;
      }
      showRgbaCanvas(bytes, artifactWidth, artifactHeight);
    } else {
      const src = `data:${image.mime || "image/png"};base64,${image.bytes_base64}`;
      showImage(src);
    }

    el.backendUsed.textContent = payload.meta?.backend_used || "-";
    updateTimingPanel(payload);
    updateStatePanel(payload, "/render/image");
    setRenderStatus(`${stage} complete`);
    setViewportNote(`Frame updated (${stage}).`);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    setRenderStatus("error", true);
    setViewportNote(String(error), true);
  }
}

function queuePanDelta(dxPx, dyPx) {
  state.panPending.dxPx += dxPx;
  state.panPending.dyPx += dyPx;
  if (state.panPending.timer) {
    return;
  }

  state.panPending.timer = setTimeout(() => {
    state.panPending.timer = null;
    const dx = state.panPending.dxPx;
    const dy = state.panPending.dyPx;
    state.panPending.dxPx = 0;
    state.panPending.dyPx = 0;

    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      return;
    }

    const activeView = getActiveViewState();
    const view2d = activeView?.view_2d;
    if (!view2d) {
      return;
    }

    const zoom = Number(view2d.camera?.zoom || 1.0);
    const pixelRatio = Number(activeView.viewport?.pixel_ratio || 1.0);
    const rotationDeg = Number(view2d.camera?.rotation_deg || 0.0);
    const centerWorld = Array.isArray(view2d.camera?.center_world)
      ? [...view2d.camera.center_world]
      : [0.0, 0.0];

    const [deltaU, deltaV] = helpers.screenDeltaToWorld(
      dx,
      dy,
      zoom,
      pixelRatio,
      rotationDeg,
    );

    const nextCenter = [Number(centerWorld[0]) - deltaU, Number(centerWorld[1]) - deltaV];

    try {
      applyLocalPatch(
        [
          {
            op: "replace",
            path: "/view_2d/camera/center_world",
            value: nextCenter,
          },
        ],
        "pan",
      );
      requestDraftRender("pan");
      scheduleSettleRender("pan");
      scheduleCommit("pan");
    } catch (error) {
      setViewportNote(String(error), true);
    }
  }, 12);
}

function sliceInfo() {
  const view2d = getActiveViewState()?.view_2d;
  if (!view2d) {
    return null;
  }

  const slice = view2d.slice || null;
  const axis = slice && typeof slice.axis === "string" ? slice.axis : null;
  if (!axis) {
    return null;
  }

  const directIndex = slice && Number.isInteger(slice.index) ? Number(slice.index) : null;
  const fallbackIndex = helpers.selectorIndex(getActiveViewState()?.selectors, axis);
  const index = directIndex ?? fallbackIndex ?? 0;
  return { axis, index };
}

function applySelectorIndex(axis, nextIndex) {
  const activeView = getActiveViewState();
  if (!activeView) {
    return;
  }

  const patch = [
    {
      op: "replace",
      path: "/selectors",
      value: helpers.selectorsWithReplacement(activeView.selectors, axis, nextIndex),
    },
  ];

  const sliceAxis = activeView?.view_2d?.slice?.axis;
  if (sliceAxis === axis && activeView?.view_2d?.slice) {
    patch.push({ op: "replace", path: "/view_2d/slice/index", value: nextIndex });
  }

  try {
    applyLocalPatch(patch, `axis ${axis}`);
    requestDraftRender(`axis_${axis}`);
    scheduleSettleRender(`axis_${axis}`);
    scheduleCommit(`axis_${axis}`);
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

function stepSlice(delta) {
  const info = sliceInfo();
  if (!info) {
    setViewportNote("Current view has no slice axis to step.", true);
    return;
  }

  const activeView = getActiveViewState();
  const nextIndex = Math.round(info.index + delta);
  const patch = [
    {
      op: "replace",
      path: "/selectors",
      value: helpers.selectorsWithReplacement(activeView?.selectors, info.axis, nextIndex),
    },
  ];
  if (activeView?.view_2d?.slice) {
    patch.push({
      op: "replace",
      path: "/view_2d/slice/index",
      value: nextIndex,
    });
  }

  try {
    applyLocalPatch(patch, "slice step");
    requestDraftRender("slice_step");
    scheduleSettleRender("slice_step");
    scheduleCommit("slice_step");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

function switchPlane(nextPlane) {
  const activeView = getActiveViewState();
  if (!state.connected || !activeView) {
    return;
  }

  try {
    const patch = helpers.computePlanePatch(activeView, nextPlane, PLANE_ROLES);
    applyLocalPatch(patch, `plane ${nextPlane}`);
    requestDraftRender("plane_change");
    scheduleSettleRender("plane_change");
    scheduleCommit("plane_change");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

function zoomAtPointer(event) {
  const activeView = getActiveViewState();
  if (!state.connected || !activeView?.view_2d) {
    return;
  }

  const camera = activeView.view_2d.camera;
  const viewport = activeView.viewport;
  const zoom = Number(camera?.zoom || 1.0);
  const pixelRatio = Number(viewport?.pixel_ratio || 1.0);
  const rotationDeg = Number(camera?.rotation_deg || 0.0);
  const centerWorld = Array.isArray(camera?.center_world) ? [...camera.center_world] : [0.0, 0.0];

  const wheelDelta = Number(event.deltaY || 0);
  const factor = Math.exp(wheelDelta * 0.0015);
  const nextZoom = helpers.clampZoom(zoom * factor);

  const rect = el.viewport.getBoundingClientRect();
  const offsetX = event.clientX - rect.left - rect.width / 2;
  const offsetY = event.clientY - rect.top - rect.height / 2;

  const [currentOffsetU, currentOffsetV] = helpers.screenDeltaToWorld(
    offsetX,
    offsetY,
    zoom,
    pixelRatio,
    rotationDeg,
  );
  const [nextOffsetU, nextOffsetV] = helpers.screenDeltaToWorld(
    offsetX,
    offsetY,
    nextZoom,
    pixelRatio,
    rotationDeg,
  );

  const nextCenter = [
    Number(centerWorld[0]) + (currentOffsetU - nextOffsetU),
    Number(centerWorld[1]) + (currentOffsetV - nextOffsetV),
  ];

  try {
    applyLocalPatch(
      [
        { op: "replace", path: "/view_2d/camera/zoom", value: nextZoom },
        { op: "replace", path: "/view_2d/camera/center_world", value: nextCenter },
      ],
      "zoom",
    );
    requestDraftRender("zoom");
    scheduleSettleRender("zoom");
    scheduleCommit("zoom");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

el.refreshTargets.addEventListener("click", async () => {
  try {
    await refreshTargets();
    setStreamStatus("targets refreshed");
  } catch (error) {
    setStreamStatus(String(error), true);
  }
});

el.sessionId.addEventListener("change", async () => {
  try {
    await refreshViews();
  } catch (error) {
    setStreamStatus(String(error), true);
  }
});

el.connect.addEventListener("click", () => {
  connect();
});

el.disconnect.addEventListener("click", () => {
  disconnect();
});

el.renderNow.addEventListener("click", () => {
  clearRenderTimers();
  renderFrame({ reason: "manual", format: "png", stage: "final" });
  flushLocalCommit("manual_sync");
});

el.planeSelect.addEventListener("change", () => {
  switchPlane(el.planeSelect.value);
});

el.viewport.addEventListener("pointerdown", (event) => {
  if (!state.connected || !getActiveViewState() || event.button !== 0) {
    return;
  }
  event.preventDefault();
  state.drag.active = true;
  state.drag.pointerId = event.pointerId;
  state.drag.lastClientX = event.clientX;
  state.drag.lastClientY = event.clientY;
  el.viewport.classList.add("dragging");
  if (typeof el.viewport.setPointerCapture === "function") {
    el.viewport.setPointerCapture(event.pointerId);
  }
});

el.viewport.addEventListener("pointermove", (event) => {
  if (!state.drag.active || state.drag.pointerId !== event.pointerId) {
    return;
  }
  const dx = event.clientX - state.drag.lastClientX;
  const dy = event.clientY - state.drag.lastClientY;
  state.drag.lastClientX = event.clientX;
  state.drag.lastClientY = event.clientY;
  queuePanDelta(dx, dy);
});

el.viewport.addEventListener("pointerup", (event) => {
  if (!state.drag.active || state.drag.pointerId !== event.pointerId) {
    return;
  }
  stopDragging();
  scheduleSettleRender("pan_end");
  scheduleCommit("pan_end", 0);
});

el.viewport.addEventListener("pointercancel", (event) => {
  if (!state.drag.active || state.drag.pointerId !== event.pointerId) {
    return;
  }
  stopDragging();
  scheduleSettleRender("pan_cancel");
  scheduleCommit("pan_cancel", 0);
});

el.viewport.addEventListener("dragstart", (event) => {
  event.preventDefault();
});

el.viewport.addEventListener(
  "wheel",
  (event) => {
    if (!state.connected || !getActiveViewState()) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      const delta = event.deltaY > 0 ? 1 : -1;
      stepSlice(delta);
      return;
    }
    zoomAtPointer(event);
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (!state.connected || !getActiveViewState() || isFormField(event.target)) {
    return;
  }
  if (event.key === "1") {
    event.preventDefault();
    switchPlane("xy");
    return;
  }
  if (event.key === "2") {
    event.preventDefault();
    switchPlane("xz");
    return;
  }
  if (event.key === "3") {
    event.preventDefault();
    switchPlane("yz");
    return;
  }
  if (event.key === "[") {
    event.preventDefault();
    stepSlice(-1);
    return;
  }
  if (event.key === "]") {
    event.preventDefault();
    stepSlice(1);
  }
});

window.addEventListener("beforeunload", () => {
  disconnect();
});

async function init() {
  try {
    await refreshTargets();
    setStreamStatus("ready");
    resetPanelsOnDisconnect();
  } catch (error) {
    setStreamStatus(String(error), true);
  }
}

init();
