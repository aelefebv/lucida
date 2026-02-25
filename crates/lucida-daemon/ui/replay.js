const state = {
  runs: [],
  frames: [],
  currentFrameIndex: 0,
  isPlaying: false,
  playbackTimer: null,
  stream: null,
  renderCache: new Map(),
  selectedRunId: null,
};

const el = {
  runSelect: document.querySelector("#run-select"),
  eventLimit: document.querySelector("#event-limit"),
  renderWidth: document.querySelector("#render-width"),
  renderHeight: document.querySelector("#render-height"),
  loadRun: document.querySelector("#load-run"),
  refreshRuns: document.querySelector("#refresh-runs"),
  status: document.querySelector("#status"),
  prevFrame: document.querySelector("#prev-frame"),
  playToggle: document.querySelector("#play-toggle"),
  nextFrame: document.querySelector("#next-frame"),
  playbackSpeed: document.querySelector("#playback-speed"),
  frameSlider: document.querySelector("#frame-slider"),
  frameIndicator: document.querySelector("#frame-indicator"),
  viewport: document.querySelector("#viewport"),
  changes: document.querySelector("#changes"),
  eventList: document.querySelector("#event-list"),
};

function setStatus(text) {
  el.status.textContent = text;
}

async function fetchJSON(url, options = undefined) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadRuns() {
  setStatus("loading runs");
  const payload = await fetchJSON("/usage/runs?limit=200");
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  renderRunOptions();
  setStatus(`runs:${state.runs.length}`);
}

function renderRunOptions() {
  const previous = el.runSelect.value;
  el.runSelect.innerHTML = "";
  if (state.runs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No runs";
    el.runSelect.appendChild(option);
    return;
  }

  state.runs.forEach((run) => {
    const option = document.createElement("option");
    option.value = run.agent_run_id;
    option.textContent = `${run.agent_run_id} (${run.event_count} events)`;
    el.runSelect.appendChild(option);
  });
  if (previous && state.runs.some((run) => run.agent_run_id === previous)) {
    el.runSelect.value = previous;
  }
}

async function loadSelectedRun() {
  const runId = el.runSelect.value.trim();
  if (!runId) {
    state.frames = [];
    renderEventList();
    renderFrame();
    return;
  }
  state.selectedRunId = runId;
  stopPlayback();
  closeStream();

  const limit = Math.max(10, Math.min(500, Number(el.eventLimit.value || "200")));
  setStatus(`loading run:${runId}`);
  const payload = await fetchJSON(`/usage/runs/${encodeURIComponent(runId)}?limit=${limit}`);
  const events = Array.isArray(payload.events) ? payload.events : [];
  state.frames = buildFrames(events);
  state.currentFrameIndex = Math.max(0, state.frames.length - 1);
  renderEventList();
  renderFrame();
  connectRunStream(runId);
  setStatus(`frames:${state.frames.length}`);
}

function buildFrames(events) {
  const sorted = [...events].sort((a, b) => Number(a.id) - Number(b.id));
  return sorted.map((event, index) => {
    const inlineArtifact = extractInlineRenderArtifact(event);
    const inlineImageUrl =
      inlineArtifact && inlineArtifact.bytes_base64
        ? `data:${inlineArtifact.mime || "image/png"};base64,${inlineArtifact.bytes_base64}`
        : null;
    const viewState = extractViewState(event);
    return {
      frameIndex: index,
      event,
      viewState,
      inlineImageUrl,
    };
  });
}

function extractInlineRenderArtifact(event) {
  const response = event && typeof event.response_json === "object" ? event.response_json : null;
  if (!response || !Array.isArray(response.images) || response.images.length === 0) {
    return null;
  }
  return response.images[0];
}

function extractViewState(event) {
  const response = event && typeof event.response_json === "object" ? event.response_json : null;
  const request = event && typeof event.request_json === "object" ? event.request_json : null;
  if (response && response.view_state && typeof response.view_state === "object") {
    return response.view_state;
  }
  if (request && request.view_state && typeof request.view_state === "object") {
    return request.view_state;
  }
  return null;
}

function renderRunEventRow(frame, active) {
  const row = document.createElement("article");
  row.className = active ? "event-row active" : "event-row";

  const jump = document.createElement("button");
  jump.className = "secondary";
  jump.textContent = `${formatTime(frame.event.occurred_at_utc)} ${frame.event.endpoint}`;
  jump.addEventListener("click", () => {
    state.currentFrameIndex = frame.frameIndex;
    renderFrame();
    renderEventList();
  });
  row.appendChild(jump);

  const meta = document.createElement("div");
  meta.className = "event-meta";
  meta.appendChild(chip(`id:${frame.event.id}`));
  meta.appendChild(chip(`status:${frame.event.status_code}`));
  meta.appendChild(chip(`lat:${formatMs(frame.event.latency_ms)}`));
  if (frame.event.agent_step_id) {
    meta.appendChild(chip(`step:${frame.event.agent_step_id}`));
  }
  if (frame.event.view_id) {
    meta.appendChild(chip(`view:${frame.event.view_id}`));
  }
  if (frame.inlineImageUrl) {
    meta.appendChild(chip("inline-image"));
  } else if (frame.viewState) {
    meta.appendChild(chip("view-state"));
  }
  row.appendChild(meta);
  return row;
}

function renderEventList() {
  el.eventList.innerHTML = "";
  if (state.frames.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No frames loaded.";
    el.eventList.appendChild(p);
    return;
  }
  state.frames.forEach((frame, index) => {
    el.eventList.appendChild(renderRunEventRow(frame, index === state.currentFrameIndex));
  });
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) {
    return value;
  }
  return ts.toLocaleString();
}

function formatMs(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${Number(value).toFixed(1)}ms`;
}

function chip(text) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = text;
  return span;
}

async function renderFrame() {
  const total = state.frames.length;
  if (total === 0) {
    el.frameIndicator.textContent = "frame 0/0";
    el.frameSlider.max = "0";
    el.frameSlider.value = "0";
    el.viewport.innerHTML = "<p>Select a run and frame.</p>";
    el.changes.innerHTML = "";
    return;
  }

  state.currentFrameIndex = Math.max(0, Math.min(total - 1, state.currentFrameIndex));
  el.frameSlider.max = String(total - 1);
  el.frameSlider.value = String(state.currentFrameIndex);
  el.frameIndicator.textContent = `frame ${state.currentFrameIndex + 1}/${total}`;

  const frame = state.frames[state.currentFrameIndex];
  const previous = state.currentFrameIndex > 0 ? state.frames[state.currentFrameIndex - 1] : null;
  renderStateDiff(previous?.viewState ?? null, frame.viewState);
  await renderViewport(frame);
}

async function renderViewport(frame) {
  el.viewport.innerHTML = "<p>Rendering frame...</p>";
  try {
    const imageUrl = await resolveFrameImage(frame);
    if (!imageUrl) {
      el.viewport.innerHTML =
        "<p>No inline render artifact was captured for this action. A replay render could not be generated.</p>";
      return;
    }
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "agent viewport replay frame";
    el.viewport.innerHTML = "";
    el.viewport.appendChild(img);
  } catch (error) {
    el.viewport.innerHTML = `<p>${String(error)}</p>`;
  }
}

async function resolveFrameImage(frame) {
  if (frame.inlineImageUrl) {
    return frame.inlineImageUrl;
  }
  if (!frame.viewState) {
    return null;
  }

  const width = Math.max(64, Math.min(2048, Number(el.renderWidth.value || "768")));
  const height = Math.max(64, Math.min(2048, Number(el.renderHeight.value || "768")));
  const cacheKey = `${frame.event.id}:${width}x${height}`;
  if (state.renderCache.has(cacheKey)) {
    return state.renderCache.get(cacheKey);
  }

  const payload = {
    schema_version: 1,
    view_state: frame.viewState,
    output: {
      format: "png",
      delivery: "inline_base64",
      width_px: width,
      height_px: height,
    },
  };

  const response = await fetch("/render/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return null;
  }
  const rendered = await response.json();
  const artifact = Array.isArray(rendered.images) ? rendered.images[0] : null;
  if (!artifact || !artifact.bytes_base64) {
    return null;
  }
  const url = `data:${artifact.mime || "image/png"};base64,${artifact.bytes_base64}`;
  state.renderCache.set(cacheKey, url);
  return url;
}

function renderStateDiff(previous, current) {
  el.changes.innerHTML = "";
  if (!current) {
    el.changes.innerHTML = "<p>No view state on this frame.</p>";
    return;
  }
  const changes = diffJSON(previous || {}, current, "", []);
  if (changes.length === 0) {
    const item = document.createElement("div");
    item.className = "change-item";
    item.textContent = "No view-state field changes.";
    el.changes.appendChild(item);
    return;
  }

  changes.slice(0, 30).forEach((change) => {
    const item = document.createElement("div");
    item.className = "change-item";
    item.textContent = `${change.path}: ${change.before} -> ${change.after}`;
    el.changes.appendChild(item);
  });
}

function diffJSON(before, after, path, output) {
  const beforeType = typeOf(before);
  const afterType = typeOf(after);
  if (beforeType !== afterType) {
    output.push({
      path: path || "/",
      before: shortValue(before),
      after: shortValue(after),
    });
    return output;
  }

  if (afterType === "object") {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    [...keys].sort().forEach((key) => {
      const nextPath = path ? `${path}/${key}` : `/${key}`;
      if (!(key in before)) {
        output.push({ path: nextPath, before: "∅", after: shortValue(after[key]) });
      } else if (!(key in after)) {
        output.push({ path: nextPath, before: shortValue(before[key]), after: "∅" });
      } else {
        diffJSON(before[key], after[key], nextPath, output);
      }
    });
    return output;
  }

  if (afterType === "array") {
    const maxLength = Math.max(before.length, after.length);
    for (let i = 0; i < maxLength; i += 1) {
      const nextPath = `${path}[${i}]`;
      if (i >= before.length) {
        output.push({ path: nextPath, before: "∅", after: shortValue(after[i]) });
      } else if (i >= after.length) {
        output.push({ path: nextPath, before: shortValue(before[i]), after: "∅" });
      } else {
        diffJSON(before[i], after[i], nextPath, output);
      }
    }
    return output;
  }

  if (before !== after) {
    output.push({
      path: path || "/",
      before: shortValue(before),
      after: shortValue(after),
    });
  }
  return output;
}

function typeOf(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value && typeof value === "object") {
    return "object";
  }
  return "primitive";
}

function shortValue(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => shortValue(item)).slice(0, 5).join(", ")}${value.length > 5 ? ", ..." : ""}]`;
  }
  if (typeof value === "object") {
    return "{...}";
  }
  return String(value);
}

function stepFrame(delta) {
  if (state.frames.length === 0) {
    return;
  }
  state.currentFrameIndex += delta;
  if (state.currentFrameIndex < 0) {
    state.currentFrameIndex = 0;
  }
  if (state.currentFrameIndex >= state.frames.length) {
    state.currentFrameIndex = state.frames.length - 1;
    stopPlayback();
  }
  renderFrame();
  renderEventList();
}

function stopPlayback() {
  state.isPlaying = false;
  el.playToggle.textContent = "Play";
  if (state.playbackTimer) {
    clearInterval(state.playbackTimer);
    state.playbackTimer = null;
  }
}

function startPlayback() {
  if (state.frames.length === 0) {
    return;
  }
  if (state.currentFrameIndex >= state.frames.length - 1) {
    state.currentFrameIndex = 0;
  }
  state.isPlaying = true;
  el.playToggle.textContent = "Pause";
  const intervalMs = Math.max(120, Number(el.playbackSpeed.value || "900"));
  state.playbackTimer = setInterval(() => {
    if (state.currentFrameIndex >= state.frames.length - 1) {
      stopPlayback();
      return;
    }
    stepFrame(1);
  }, intervalMs);
}

function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function connectRunStream(runId) {
  closeStream();
  const stream = new EventSource(`/usage/events/stream?run_id=${encodeURIComponent(runId)}`);
  state.stream = stream;
  stream.addEventListener("usage_event", (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (!parsed || !parsed.id) {
        return;
      }
      if (state.frames.some((frame) => frame.event.id === parsed.id)) {
        return;
      }
      const [newFrame] = buildFrames([parsed]);
      if (!newFrame) {
        return;
      }
      newFrame.frameIndex = state.frames.length;
      state.frames.push(newFrame);
      el.frameSlider.max = String(Math.max(0, state.frames.length - 1));
      if (!state.isPlaying) {
        state.currentFrameIndex = state.frames.length - 1;
      }
      renderEventList();
      renderFrame();
      setStatus(`live frames:${state.frames.length}`);
    } catch (_) {
      setStatus("stream parse error");
    }
  });
  stream.addEventListener("error", () => {
    setStatus("stream reconnecting");
  });
}

el.refreshRuns.addEventListener("click", async () => {
  try {
    await loadRuns();
  } catch (error) {
    setStatus(`error: ${String(error)}`);
  }
});

el.loadRun.addEventListener("click", async () => {
  try {
    await loadSelectedRun();
  } catch (error) {
    setStatus(`error: ${String(error)}`);
  }
});

el.prevFrame.addEventListener("click", () => {
  stepFrame(-1);
  renderEventList();
});

el.nextFrame.addEventListener("click", () => {
  stepFrame(1);
  renderEventList();
});

el.playToggle.addEventListener("click", togglePlayback);

el.frameSlider.addEventListener("input", () => {
  state.currentFrameIndex = Number(el.frameSlider.value || "0");
  renderFrame();
  renderEventList();
});

el.playbackSpeed.addEventListener("change", () => {
  if (state.isPlaying) {
    stopPlayback();
    startPlayback();
  }
});

window.addEventListener("beforeunload", () => {
  stopPlayback();
  closeStream();
});

async function init() {
  try {
    await loadRuns();
    if (state.runs.length > 0) {
      el.runSelect.value = state.runs[0].agent_run_id;
      await loadSelectedRun();
    } else {
      renderFrame();
      renderEventList();
    }
  } catch (error) {
    setStatus(`error: ${String(error)}`);
  }
}

init();
