const PLANE_ROLES = {
  xy: ["x", "y", "z"],
  xz: ["x", "z", "y"],
  yz: ["y", "z", "x"],
};

const state = {
  connected: false,
  stream: null,
  viewId: null,
  sessionId: null,
  viewState: null,
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
    minDraftIntervalMs: 90,
    draftTimer: null,
    pendingDraftTrigger: null,
    settleTimer: null,
    settleDebounceMs: 180,
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

function clampZoom(value) {
  if (!Number.isFinite(value)) {
    return 1.0;
  }
  return Math.max(0.02, Math.min(4096, value));
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

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
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
  stopDragging();
  state.viewId = null;
  state.sessionId = null;
  state.viewState = null;
  setStreamStatus("disconnected");
  setViewportNote("Connect and render to display frames.");
  resetPanelsOnDisconnect();
}

function updateStatePanel(payload, endpoint) {
  if (endpoint) {
    el.lastEndpoint.textContent = endpoint;
  }
  el.stateHash.textContent = payload.state_hash || payload.view_state?.state_hash || "-";
  const stateVersion = payload.state_version ?? payload.view_state?.state_version;
  el.stateVersion.textContent =
    stateVersion === null || stateVersion === undefined ? "-" : String(stateVersion);
}

function updateTimingPanel(payload) {
  const totalMs = payload?.meta?.timing_ms?.total;
  if (Number.isFinite(totalMs)) {
    el.renderTotalMs.textContent = `${Number(totalMs).toFixed(1)} ms`;
  } else {
    el.renderTotalMs.textContent = "-";
  }
}

function selectorIndex(selectors, axis) {
  if (!Array.isArray(selectors) || typeof axis !== "string") {
    return null;
  }
  for (const selector of selectors) {
    if (!selector || selector.axis !== axis) {
      continue;
    }
    if (selector.kind === "index" && Number.isInteger(selector.index)) {
      return Number(selector.index);
    }
    if (selector.kind === "range" && Number.isInteger(selector.start)) {
      return Number(selector.start);
    }
    if (selector.kind === "set" && Array.isArray(selector.indices) && selector.indices.length > 0) {
      const first = selector.indices[0];
      if (Number.isInteger(first)) {
        return Number(first);
      }
    }
  }
  return null;
}

function selectorsWithReplacement(axis, nextIndex) {
  const currentSelectors = Array.isArray(state.viewState?.selectors) ? state.viewState.selectors : [];
  const selectors = currentSelectors.filter((selector) => selector && selector.axis !== axis);
  selectors.push({
    axis,
    kind: "index",
    index: nextIndex,
    clamp: true,
  });
  return selectors;
}

async function applySelectorIndex(axis, nextIndex) {
  const patch = [
    {
      op: "replace",
      path: "/selectors",
      value: selectorsWithReplacement(axis, nextIndex),
    },
  ];
  const sliceAxis = state.viewState?.view_2d?.slice?.axis;
  if (sliceAxis === axis && state.viewState?.view_2d?.slice) {
    patch.push({ op: "replace", path: "/view_2d/slice/index", value: nextIndex });
  }
  try {
    await updateViewStateWithPatch(patch, `axis ${axis}`);
    requestDraftRender(`axis_${axis}`);
    scheduleSettleRender(`axis_${axis}`);
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

function renderSelectorControls() {
  const selectors = Array.isArray(state.viewState?.selectors) ? state.viewState.selectors : [];
  el.selectorControls.innerHTML = "";
  if (selectors.length === 0) {
    el.selectorControls.innerHTML = "<p>No selectors available for the connected view.</p>";
    return;
  }

  const sorted = [...selectors].sort((left, right) => String(left.axis).localeCompare(String(right.axis)));

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

function setViewState(viewState, endpoint = "/view/{view_id}") {
  state.viewState = viewState;
  state.viewId = viewState.view_id || state.viewId;
  state.sessionId = viewState.session_id || state.sessionId;
  updateStatePanel(viewState, endpoint);
  if (viewState.view_2d && viewState.view_2d.plane && PLANE_ROLES[viewState.view_2d.plane]) {
    el.planeSelect.value = viewState.view_2d.plane;
  }
  renderSelectorControls();
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

async function bootstrapViewState(scope) {
  const viewState = await fetchViewState(scope);
  setViewState(viewState, "/view/{view_id}");
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
      if (event.event_type === "view_state_committed") {
        const eventVersion = Number(event.state_version ?? -1);
        const localVersion = Number(state.viewState?.state_version ?? -1);
        if (eventVersion > localVersion) {
          try {
            await bootstrapViewState({ viewId: state.viewId, sessionId: state.sessionId });
            scheduleSettleRender("stream_update");
          } catch (_) {
            setViewportNote("Failed to refresh view state from stream event.", true);
          }
        }
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

async function updateViewStateWithPatch(patch, reason, retryConflict = true) {
  if (!state.connected || !state.viewId || !state.viewState) {
    throw new Error("viewer is not connected to an active view");
  }

  const request = {
    schema_version: 1,
    view_id: state.viewId,
    expected_state_version: Number(state.viewState.state_version || 0),
    patch,
  };
  if (state.sessionId) {
    request.session_id = state.sessionId;
  }

  const response = await fetch("/view/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (response.status === 409 && retryConflict) {
    const refreshed = await fetchViewState({
      viewId: state.viewId,
      sessionId: state.sessionId,
    });
    setViewState(refreshed, "/view/{view_id}");
    return updateViewStateWithPatch(patch, reason, false);
  }

  if (!response.ok) {
    throw new Error(`view update failed (${response.status})`);
  }

  const payload = await response.json();
  if (!payload.view_state) {
    throw new Error("view update response missing view_state");
  }
  setViewState(payload.view_state, "/view/update");
  setViewportNote(`Applied ${reason}.`);
  return payload.view_state;
}

function screenDeltaToWorld(dxPx, dyPx, zoom, pixelRatio, rotationDeg) {
  const scale = 1.0 / (zoom * pixelRatio);
  const theta = (rotationDeg * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const worldU = (dxPx * cosTheta + dyPx * sinTheta) * scale;
  const worldV = (-dxPx * sinTheta + dyPx * cosTheta) * scale;
  return [worldU, worldV];
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

function queuePanDelta(dxPx, dyPx) {
  state.panPending.dxPx += dxPx;
  state.panPending.dyPx += dyPx;
  if (state.panPending.timer) {
    return;
  }
  state.panPending.timer = setTimeout(async () => {
    state.panPending.timer = null;
    const dx = state.panPending.dxPx;
    const dy = state.panPending.dyPx;
    state.panPending.dxPx = 0;
    state.panPending.dyPx = 0;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      return;
    }
    try {
      const view2d = state.viewState?.view_2d;
      if (!view2d) {
        return;
      }
      const zoom = Number(view2d.camera?.zoom || 1.0);
      const pixelRatio = Number(state.viewState.viewport?.pixel_ratio || 1.0);
      const rotationDeg = Number(view2d.camera?.rotation_deg || 0.0);
      const centerWorld = Array.isArray(view2d.camera?.center_world)
        ? [...view2d.camera.center_world]
        : [0.0, 0.0];
      const [deltaU, deltaV] = screenDeltaToWorld(dx, dy, zoom, pixelRatio, rotationDeg);
      const nextCenter = [Number(centerWorld[0]) + deltaU, Number(centerWorld[1]) + deltaV];
      await updateViewStateWithPatch(
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
    } catch (error) {
      setViewportNote(String(error), true);
    }
  }, 45);
}

function sliceInfo() {
  const view2d = state.viewState?.view_2d;
  if (!view2d) {
    return null;
  }
  const slice = view2d.slice || null;
  const axis = slice && typeof slice.axis === "string" ? slice.axis : null;
  if (!axis) {
    return null;
  }
  const directIndex = slice && Number.isInteger(slice.index) ? Number(slice.index) : null;
  const fallbackIndex = selectorIndex(state.viewState?.selectors, axis);
  const index = directIndex ?? fallbackIndex ?? 0;
  return { axis, index };
}

async function stepSlice(delta) {
  const info = sliceInfo();
  if (!info) {
    setViewportNote("Current view has no slice axis to step.", true);
    return;
  }
  const nextIndex = Math.round(info.index + delta);
  const patch = [
    {
      op: "replace",
      path: "/selectors",
      value: selectorsWithReplacement(info.axis, nextIndex),
    },
  ];
  if (state.viewState?.view_2d?.slice) {
    patch.push({
      op: "replace",
      path: "/view_2d/slice/index",
      value: nextIndex,
    });
  }
  try {
    await updateViewStateWithPatch(patch, "slice step");
    requestDraftRender("slice_step");
    scheduleSettleRender("slice_step");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

function setPlanePatch(nextPlane) {
  const view2d = state.viewState?.view_2d;
  if (!view2d) {
    throw new Error("view has no 2d state");
  }
  if (!Object.prototype.hasOwnProperty.call(PLANE_ROLES, nextPlane)) {
    throw new Error(`unsupported plane: ${nextPlane}`);
  }
  const currentPlane = Object.prototype.hasOwnProperty.call(PLANE_ROLES, view2d.plane)
    ? view2d.plane
    : "xy";

  const [currentURole, currentVRole, currentOrthRole] = PLANE_ROLES[currentPlane];
  const [targetURole, targetVRole, targetOrthRole] = PLANE_ROLES[nextPlane];

  const centerWorld = Array.isArray(view2d.camera?.center_world) ? [...view2d.camera.center_world] : [0, 0];
  if (centerWorld.length !== 2) {
    centerWorld.splice(0, centerWorld.length, 0, 0);
  }

  const slicePayload = view2d.slice ? deepClone(view2d.slice) : {};
  const sliceAxis = view2d.slice && typeof view2d.slice.axis === "string" ? view2d.slice.axis : null;
  const currentSliceIndex =
    Number.isInteger(view2d.slice?.index)
      ? Number(view2d.slice.index)
      : selectorIndex(state.viewState?.selectors, sliceAxis) ?? 0;

  const roleValues = {
    [currentURole]: Number(centerWorld[0]),
    [currentVRole]: Number(centerWorld[1]),
    [currentOrthRole]: Number(currentSliceIndex),
  };

  const newCenter = [
    Number(roleValues[targetURole] ?? centerWorld[0]),
    Number(roleValues[targetVRole] ?? centerWorld[1]),
  ];

  const nextSlice = {
    ...slicePayload,
    index: Math.round(Number(roleValues[targetOrthRole] ?? 0)),
  };

  return [
    { op: "replace", path: "/view_2d/plane", value: nextPlane },
    { op: "replace", path: "/view_2d/camera/center_world", value: newCenter },
    { op: "replace", path: "/view_2d/slice", value: nextSlice },
  ];
}

async function switchPlane(nextPlane) {
  if (!state.connected || !state.viewState) {
    return;
  }
  try {
    const patch = setPlanePatch(nextPlane);
    await updateViewStateWithPatch(patch, `plane ${nextPlane}`);
    requestDraftRender("plane_change");
    scheduleSettleRender("plane_change");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

async function zoomAtPointer(event) {
  if (!state.connected || !state.viewState?.view_2d) {
    return;
  }
  const view2d = state.viewState.view_2d;
  const camera = view2d.camera;
  const viewport = state.viewState.viewport;
  const zoom = Number(camera?.zoom || 1.0);
  const pixelRatio = Number(viewport?.pixel_ratio || 1.0);
  const rotationDeg = Number(camera?.rotation_deg || 0.0);
  const centerWorld = Array.isArray(camera?.center_world) ? [...camera.center_world] : [0.0, 0.0];

  const wheelDelta = Number(event.deltaY || 0);
  const factor = Math.exp(-wheelDelta * 0.0015);
  const nextZoom = clampZoom(zoom * factor);

  const rect = el.viewport.getBoundingClientRect();
  const offsetX = event.clientX - rect.left - rect.width / 2;
  const offsetY = event.clientY - rect.top - rect.height / 2;

  const [currentOffsetU, currentOffsetV] = screenDeltaToWorld(
    offsetX,
    offsetY,
    zoom,
    pixelRatio,
    rotationDeg,
  );
  const [nextOffsetU, nextOffsetV] = screenDeltaToWorld(
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
    await updateViewStateWithPatch(
      [
        { op: "replace", path: "/view_2d/camera/zoom", value: nextZoom },
        { op: "replace", path: "/view_2d/camera/center_world", value: nextCenter },
      ],
      "zoom",
    );
    requestDraftRender("zoom");
    scheduleSettleRender("zoom");
  } catch (error) {
    setViewportNote(String(error), true);
  }
}

async function renderFrame({ reason, format, stage }) {
  const scope = {
    viewId: state.viewId || selectedViewId(),
    sessionId: state.sessionId || selectedSessionId(),
  };
  if (!scope.viewId) {
    setStreamStatus("select a view_id first", true);
    return;
  }

  cancelInFlightRender();
  const controller = new AbortController();
  state.renderController = controller;

  const width = clampRenderSize(el.renderWidth.value, 1024);
  const height = clampRenderSize(el.renderHeight.value, 1024);
  el.renderWidth.value = String(width);
  el.renderHeight.value = String(height);

  setRenderStatus(`rendering ${stage}`);
  setViewportNote(`Rendering ${stage} (${reason})...`);
  try {
    const request = {
      schema_version: 1,
      view_id: scope.viewId,
      output: {
        format,
        delivery: "inline_base64",
        width_px: width,
        height_px: height,
      },
    };
    if (scope.sessionId) {
      request.session_id = scope.sessionId;
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
      const artifactWidth = clampRenderSize(image.width_px, width);
      const artifactHeight = clampRenderSize(image.height_px, height);
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
});

el.planeSelect.addEventListener("change", () => {
  switchPlane(el.planeSelect.value);
});

el.viewport.addEventListener("pointerdown", (event) => {
  if (!state.connected || !state.viewState || event.button !== 0) {
    return;
  }
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
});

el.viewport.addEventListener("pointercancel", (event) => {
  if (!state.drag.active || state.drag.pointerId !== event.pointerId) {
    return;
  }
  stopDragging();
  scheduleSettleRender("pan_cancel");
});

el.viewport.addEventListener(
  "wheel",
  (event) => {
    if (!state.connected || !state.viewState) {
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
  if (!state.connected || !state.viewState || isFormField(event.target)) {
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
