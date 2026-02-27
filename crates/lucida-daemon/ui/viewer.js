const state = {
  connected: false,
  stream: null,
  viewId: null,
  sessionId: null,
  renderController: null,
};

const el = {
  viewId: document.querySelector("#view-id"),
  sessionId: document.querySelector("#session-id"),
  refreshTargets: document.querySelector("#refresh-targets"),
  renderWidth: document.querySelector("#render-width"),
  renderHeight: document.querySelector("#render-height"),
  renderFormat: document.querySelector("#render-format"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  renderNow: document.querySelector("#render-now"),
  streamStatus: document.querySelector("#stream-status"),
  lastEndpoint: document.querySelector("#last-endpoint"),
  stateHash: document.querySelector("#state-hash"),
  stateVersion: document.querySelector("#state-version"),
  backendUsed: document.querySelector("#backend-used"),
  viewportNote: document.querySelector("#viewport-note"),
  viewport: document.querySelector("#viewport"),
};

function setStreamStatus(text, isError = false) {
  el.streamStatus.textContent = text;
  el.streamStatus.className = isError ? "status-value danger" : "status-value";
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

function selectedRenderFormat() {
  const value = String(el.renderFormat.value || "").trim();
  return value === "raw_rgba" ? "raw_rgba" : "png";
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

function disconnect() {
  state.connected = false;
  closeStream();
  cancelInFlightRender();
  state.viewId = null;
  state.sessionId = null;
  setStreamStatus("disconnected");
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

async function bootstrapViewState(scope) {
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
  updateStatePanel(payload.view_state, "/view/{view_id}");
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
  stream.addEventListener("view_event", (rawEvent) => {
    if (!state.connected) {
      return;
    }
    try {
      const event = JSON.parse(rawEvent.data);
      updateStatePanel(event, event.endpoint || "/view/events/stream");
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
  setViewportNote("Connected. Render a frame to populate the viewport.");
}

async function renderFrame(reason) {
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
  const format = selectedRenderFormat();
  el.renderWidth.value = String(width);
  el.renderHeight.value = String(height);

  setViewportNote(`Rendering (${reason})...`);
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
      setViewportNote(`Render failed (${response.status}).`, true);
      return;
    }
    const payload = await response.json();
    const image = Array.isArray(payload.images) ? payload.images[0] : null;
    if (!image || !image.bytes_base64) {
      setViewportNote("Render response has no inline image.", true);
      return;
    }

    if (format === "raw_rgba") {
      if (image.mime !== "application/x-raw-rgba") {
        setViewportNote(`Unexpected raw mime: ${String(image.mime || "(missing)")}.`, true);
        return;
      }
      const artifactWidth = clampRenderSize(image.width_px, width);
      const artifactHeight = clampRenderSize(image.height_px, height);
      const bytes = decodeBase64ToBytes(image.bytes_base64);
      const expectedLength = artifactWidth * artifactHeight * 4;
      if (bytes.length !== expectedLength) {
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
    updateStatePanel(payload, "/render/image");
    setViewportNote("Frame updated.");
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
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
  renderFrame("manual");
});

window.addEventListener("beforeunload", () => {
  disconnect();
});

async function init() {
  try {
    await refreshTargets();
    setStreamStatus("ready");
  } catch (error) {
    setStreamStatus(String(error), true);
  }
}

init();
