const state = {
  stream: null,
  connected: false,
  viewId: null,
  sessionId: null,
  renderTimer: null,
  lastRenderAtMs: 0,
  minRenderIntervalMs: 200,
  debounceMs: 120,
  renderController: null,
  renderSeq: 0,
  thumbnails: [],
  lastRenderId: null,
  viewsById: new Map(),
};

const el = {
  viewId: document.querySelector("#view-id"),
  sessionId: document.querySelector("#session-id"),
  refreshTargets: document.querySelector("#refresh-targets"),
  renderWidth: document.querySelector("#render-width"),
  renderHeight: document.querySelector("#render-height"),
  renderMode: document.querySelector("#render-mode"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  renderNow: document.querySelector("#render-now"),
  streamStatus: document.querySelector("#stream-status"),
  lastEndpoint: document.querySelector("#last-endpoint"),
  stateHash: document.querySelector("#state-hash"),
  stateVersion: document.querySelector("#state-version"),
  updatedAt: document.querySelector("#updated-at"),
  viewportNote: document.querySelector("#viewport-note"),
  viewport: document.querySelector("#viewport"),
  thumbs: document.querySelector("#thumbs"),
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

function formatLocalTime(value) {
  if (!value) {
    return "-";
  }
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) {
    return String(value);
  }
  return ts.toLocaleString();
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

function selectedRenderMode() {
  const value = String(el.renderMode.value || "").trim();
  return value === "raw_rgba" ? "raw_rgba" : "png";
}

function currentScope() {
  return {
    viewId: selectedViewId(),
    sessionId: selectedSessionId(),
  };
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function cancelScheduledRender() {
  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
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
  cancelScheduledRender();
  cancelInFlightRender();
  setStreamStatus("disconnected");
}

function updateStatePanel(event) {
  el.lastEndpoint.textContent = event.endpoint || "-";
  el.stateHash.textContent = event.state_hash || "-";
  el.stateVersion.textContent =
    event.state_version === null || event.state_version === undefined
      ? "-"
      : String(event.state_version);
  el.updatedAt.textContent = formatLocalTime(event.occurred_at_utc);
}

function addThumbnail(event) {
  const thumbnail = event.thumbnail;
  if (!thumbnail || !thumbnail.url) {
    return;
  }
  if (state.thumbnails.some((item) => item.url === thumbnail.url)) {
    return;
  }
  state.thumbnails.unshift({
    url: thumbnail.url,
    sha256: thumbnail.sha256 || "",
    width: thumbnail.width_px,
    height: thumbnail.height_px,
    occurredAt: event.occurred_at_utc || null,
    renderId: event.render_id || null,
  });
  state.thumbnails = state.thumbnails.slice(0, 24);
  renderThumbnails();
}

function renderThumbnails() {
  el.thumbs.innerHTML = "";
  if (state.thumbnails.length === 0) {
    el.thumbs.innerHTML = "<p>No thumbnails captured yet.</p>";
    return;
  }
  state.thumbnails.forEach((thumb) => {
    const card = document.createElement("article");
    card.className = "thumb-card";

    const img = document.createElement("img");
    img.src = thumb.url;
    img.alt = "render thumbnail";
    card.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "thumb-meta";
    const idLabel = thumb.renderId ? `render:${thumb.renderId}` : "render:(none)";
    meta.textContent = `${idLabel} ${thumb.width}x${thumb.height} ${formatLocalTime(thumb.occurredAt)}`;
    card.appendChild(meta);
    el.thumbs.appendChild(card);
  });
}

function showImage(src) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "live view frame";
  el.viewport.innerHTML = "";
  el.viewport.appendChild(img);
}

function decodeBase64ToBytes(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
  state.viewsById = new Map();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = views.length === 0 ? "No active views" : "Select a view";
  el.viewId.appendChild(placeholder);

  views.forEach((view) => {
    state.viewsById.set(view.view_id, view);
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
  const viewState = payload && payload.view_state ? payload.view_state : null;
  if (!viewState) {
    throw new Error("missing view_state");
  }
  el.lastEndpoint.textContent = "/view/{view_id}";
  el.stateHash.textContent = viewState.state_hash || "-";
  el.stateVersion.textContent =
    viewState.state_version === null || viewState.state_version === undefined
      ? "-"
      : String(viewState.state_version);
  el.updatedAt.textContent = formatLocalTime(viewState.created_at);
}

function scheduleRender(trigger) {
  if (!state.connected || !state.viewId) {
    return;
  }
  cancelScheduledRender();
  const now = Date.now();
  const elapsed = now - state.lastRenderAtMs;
  const minWait = Math.max(0, state.minRenderIntervalMs - elapsed);
  const delay = Math.max(state.debounceMs, minWait);
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    renderFrame(`trigger:${trigger}`);
  }, delay);
}

async function renderFrame(reason) {
  const scope = { viewId: state.viewId, sessionId: state.sessionId };
  if (!scope.viewId) {
    return;
  }
  cancelInFlightRender();
  const controller = new AbortController();
  state.renderController = controller;
  const seq = (state.renderSeq += 1);
  const width = clampRenderSize(el.renderWidth.value, 1024);
  const height = clampRenderSize(el.renderHeight.value, 1024);
  const format = selectedRenderMode();
  el.renderWidth.value = String(width);
  el.renderHeight.value = String(height);

  setViewportNote(`Rendering frame (${reason})...`);
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
    if (seq !== state.renderSeq) {
      return;
    }
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

    state.lastRenderAtMs = Date.now();
    state.lastRenderId = payload.render_id ? String(payload.render_id) : null;
    el.lastEndpoint.textContent = "/render/image";
    el.stateHash.textContent = payload.state_hash || "-";
    el.stateVersion.textContent =
      payload.state_version === null || payload.state_version === undefined
        ? "-"
        : String(payload.state_version);
    el.updatedAt.textContent = formatLocalTime(new Date().toISOString());
    setViewportNote("Live frame updated.");
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    setViewportNote(String(error), true);
  }
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
      updateStatePanel(event);
      addThumbnail(event);
      if (event.event_type === "view_state_committed") {
        scheduleRender("view_state_committed");
        return;
      }

      if (event.event_type === "render_completed") {
        const eventRenderId = event.render_id ? String(event.render_id) : null;
        if (eventRenderId && state.lastRenderId && eventRenderId === state.lastRenderId) {
          return;
        }
        if (selectedRenderMode() === "raw_rgba") {
          scheduleRender("render_completed");
          return;
        }
        const thumbnailUrl =
          event.thumbnail && event.thumbnail.url ? String(event.thumbnail.url) : null;
        if (thumbnailUrl) {
          showImage(thumbnailUrl);
          setViewportNote("Synced from latest render thumbnail.");
        }
      }
    } catch (_) {
      setStreamStatus("stream parse error", true);
    }
  });
}

async function connect() {
  const scope = currentScope();
  if (!scope.viewId) {
    setStreamStatus("select a view_id first", true);
    return;
  }
  disconnect();
  state.connected = true;
  state.viewId = scope.viewId;
  state.sessionId = scope.sessionId;
  state.thumbnails = [];
  state.lastRenderId = null;
  renderThumbnails();
  setStreamStatus("connecting");
  try {
    await bootstrapViewState(scope);
  } catch (error) {
    setStreamStatus(String(error), true);
    disconnect();
    return;
  }
  connectStream(scope);
  scheduleRender("connect");
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
  const scope = currentScope();
  if (!scope.viewId) {
    setStreamStatus("select a view_id first", true);
    return;
  }
  state.viewId = scope.viewId;
  state.sessionId = scope.sessionId;
  renderFrame("manual");
});

el.renderMode.addEventListener("change", () => {
  if (!state.connected || !state.viewId) {
    return;
  }
  renderFrame("mode_change");
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
