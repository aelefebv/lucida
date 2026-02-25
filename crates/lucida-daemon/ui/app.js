const state = {
  events: [],
  runs: [],
  selectedEventId: null,
  sse: null,
};

const elements = {
  filterRunId: document.querySelector("#filter-run-id"),
  filterEndpoint: document.querySelector("#filter-endpoint"),
  filterStatusCode: document.querySelector("#filter-status-code"),
  filterLimit: document.querySelector("#filter-limit"),
  applyFilters: document.querySelector("#apply-filters"),
  clearRunFilter: document.querySelector("#clear-run-filter"),
  refreshRuns: document.querySelector("#refresh-runs"),
  refreshEvents: document.querySelector("#refresh-events"),
  statusPill: document.querySelector("#status-pill"),
  runList: document.querySelector("#run-list"),
  eventsList: document.querySelector("#events-list"),
  renderPreview: document.querySelector("#render-preview"),
};

function currentFilters() {
  const runId = elements.filterRunId.value.trim();
  const endpoint = elements.filterEndpoint.value.trim();
  const statusRaw = elements.filterStatusCode.value.trim();
  const limitRaw = elements.filterLimit.value.trim();

  return {
    run_id: runId || null,
    endpoint: endpoint || null,
    status_code: statusRaw ? Number(statusRaw) : null,
    limit: limitRaw ? Number(limitRaw) : 100,
  };
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

async function loadRuns() {
  const response = await fetch("/usage/runs?limit=50");
  if (!response.ok) {
    throw new Error(`Failed to load runs: ${response.status}`);
  }
  const payload = await response.json();
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  renderRuns();
}

async function loadEvents() {
  const filters = currentFilters();
  const query = buildQuery(filters);
  const response = await fetch(`/usage/events?${query}`);
  if (!response.ok) {
    throw new Error(`Failed to load events: ${response.status}`);
  }
  const payload = await response.json();
  state.events = Array.isArray(payload.events) ? payload.events : [];
  if (!state.events.some((event) => event.id === state.selectedEventId)) {
    state.selectedEventId = state.events[0]?.id ?? null;
  }
  renderEvents();
  renderPreview();
}

function connectStream() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const filters = currentFilters();
  const query = buildQuery({ run_id: filters.run_id });
  const streamUrl = query ? `/usage/events/stream?${query}` : "/usage/events/stream";
  const sse = new EventSource(streamUrl);
  state.sse = sse;
  elements.statusPill.textContent = "stream: connecting";

  sse.addEventListener("open", () => {
    elements.statusPill.textContent = "stream: connected";
  });

  sse.addEventListener("usage_event", (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (!passesEventFilter(parsed)) {
        return;
      }
      state.events.unshift(parsed);
      const limit = Math.max(1, Number(elements.filterLimit.value || "100"));
      state.events = state.events.slice(0, limit);
      if (state.selectedEventId === null) {
        state.selectedEventId = parsed.id;
      }
      renderEvents();
      renderPreview();
    } catch (_) {
      elements.statusPill.textContent = "stream: parse error";
    }
  });

  sse.addEventListener("error", () => {
    elements.statusPill.textContent = "stream: reconnecting";
  });
}

function passesEventFilter(event) {
  const filters = currentFilters();
  if (filters.run_id && event.agent_run_id !== filters.run_id) {
    return false;
  }
  if (filters.endpoint && event.endpoint !== filters.endpoint) {
    return false;
  }
  if (filters.status_code && Number(event.status_code) !== Number(filters.status_code)) {
    return false;
  }
  return true;
}

function renderRuns() {
  elements.runList.innerHTML = "";
  if (state.runs.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No runs available.";
    elements.runList.appendChild(empty);
    return;
  }

  state.runs.forEach((run) => {
    const card = document.createElement("article");
    card.className = "run-card";

    const title = document.createElement("div");
    title.className = "run-title";
    const code = document.createElement("code");
    code.textContent = run.agent_run_id;
    title.appendChild(code);

    const selectButton = document.createElement("button");
    selectButton.className = "secondary";
    selectButton.textContent = "Filter";
    selectButton.addEventListener("click", () => {
      elements.filterRunId.value = run.agent_run_id;
      refreshAll();
    });
    title.appendChild(selectButton);

    const metrics = document.createElement("div");
    metrics.className = "run-metrics";
    metrics.appendChild(metricChip(`events:${run.event_count}`));
    metrics.appendChild(metricChip(`errors:${run.error_count}`));
    metrics.appendChild(metricChip(`renders:${run.render_count}`));
    metrics.appendChild(metricChip(`p50:${formatMs(run.p50_latency_ms)}`));
    metrics.appendChild(metricChip(`p95:${formatMs(run.p95_latency_ms)}`));
    metrics.appendChild(metricChip(`last:${formatTime(run.last_activity_at_utc)}`));

    card.appendChild(title);
    card.appendChild(metrics);
    elements.runList.appendChild(card);
  });
}

function metricChip(text) {
  const chip = document.createElement("span");
  chip.className = "metric";
  chip.textContent = text;
  return chip;
}

function renderEvents() {
  elements.eventsList.innerHTML = "";
  if (state.events.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No events match current filters.";
    elements.eventsList.appendChild(empty);
    return;
  }

  state.events.forEach((event) => {
    const card = document.createElement("article");
    card.className = "event-card";

    const header = document.createElement("div");
    header.className = "event-header";

    const summary = document.createElement("button");
    summary.className = "secondary";
    summary.textContent = `${formatTime(event.occurred_at_utc)} ${event.endpoint}`;
    summary.addEventListener("click", () => {
      state.selectedEventId = event.id;
      renderPreview();
    });

    const tags = document.createElement("div");
    tags.className = "event-tags";
    tags.appendChild(statusTag(event.status_code));
    tags.appendChild(tag(`lat:${formatMs(event.latency_ms)}`));
    if (event.agent_run_id) {
      tags.appendChild(tag(`run:${event.agent_run_id}`));
    }
    if (event.agent_step_id) {
      tags.appendChild(tag(`step:${event.agent_step_id}`));
    }
    if (event.view_id) {
      tags.appendChild(tag(`view:${event.view_id}`));
    }
    if (event.render_id) {
      tags.appendChild(tag(`render:${event.render_id}`));
    }

    header.appendChild(summary);
    header.appendChild(tags);
    card.appendChild(header);

    const details = document.createElement("details");
    details.className = "event-details";
    const detailsTitle = document.createElement("summary");
    detailsTitle.textContent = "Details";
    details.appendChild(detailsTitle);

    details.appendChild(jsonBlock("request_json", event.request_json));
    details.appendChild(jsonBlock("response_json", event.response_json));
    card.appendChild(details);
    elements.eventsList.appendChild(card);
  });
}

function renderPreview() {
  elements.renderPreview.innerHTML = "";
  const selected = state.events.find((event) => event.id === state.selectedEventId);
  if (!selected) {
    const text = document.createElement("p");
    text.textContent = "Select an event to preview output.";
    elements.renderPreview.appendChild(text);
    return;
  }

  if (selected.endpoint !== "/render/image") {
    const text = document.createElement("p");
    text.textContent = "Selected event is not a render operation.";
    elements.renderPreview.appendChild(text);
    return;
  }

  const image = selected.response_json?.images?.[0];
  const thumbnailUrl = selected.response_json?.usage_thumbnail?.url;
  const inlineBytes = image?.bytes_base64;
  const hasInlineBytes =
    typeof inlineBytes === "string" && inlineBytes !== "<omitted>" && inlineBytes.length > 0;
  if (!image) {
    if (thumbnailUrl) {
      const img = document.createElement("img");
      img.alt = "render preview thumbnail";
      img.src = thumbnailUrl;
      elements.renderPreview.appendChild(img);
      return;
    }
    const text = document.createElement("p");
    text.textContent = "Render response has no image artifact.";
    elements.renderPreview.appendChild(text);
    return;
  }

  if (hasInlineBytes && image.mime) {
    const img = document.createElement("img");
    img.alt = "render preview";
    img.src = `data:${image.mime};base64,${inlineBytes}`;
    elements.renderPreview.appendChild(img);
    return;
  }

  if (thumbnailUrl) {
    const img = document.createElement("img");
    img.alt = "render preview thumbnail";
    img.src = thumbnailUrl;
    elements.renderPreview.appendChild(img);
    return;
  }

  if (image.delivery === "file_path") {
    const text = document.createElement("p");
    text.textContent = "Preview unavailable for file-path delivery.";
    elements.renderPreview.appendChild(text);
    return;
  }

  const text = document.createElement("p");
  text.textContent = "Render preview is unavailable.";
  elements.renderPreview.appendChild(text);
}

function statusTag(statusCode) {
  const status = Number(statusCode);
  if (status >= 400) {
    return tag(`status:${status}`, "err");
  }
  return tag(`status:${status}`, "ok");
}

function tag(text, className = "") {
  const node = document.createElement("span");
  node.className = className ? `tag ${className}` : "tag";
  node.textContent = text;
  return node;
}

function jsonBlock(title, payload) {
  const wrapper = document.createElement("div");
  const heading = document.createElement("p");
  heading.textContent = title;
  heading.style.margin = "0.45rem 0 0.25rem";
  heading.style.fontFamily = "var(--mono)";
  heading.style.fontSize = "0.72rem";
  wrapper.appendChild(heading);

  const pre = document.createElement("pre");
  pre.textContent = payload ? JSON.stringify(payload, null, 2) : "null";
  wrapper.appendChild(pre);
  return wrapper;
}

function formatMs(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${Number(value).toFixed(1)}ms`;
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

async function refreshAll() {
  try {
    await Promise.all([loadRuns(), loadEvents()]);
    connectStream();
  } catch (error) {
    elements.statusPill.textContent = String(error);
  }
}

elements.applyFilters.addEventListener("click", refreshAll);
elements.clearRunFilter.addEventListener("click", () => {
  elements.filterRunId.value = "";
  refreshAll();
});
elements.refreshRuns.addEventListener("click", loadRuns);
elements.refreshEvents.addEventListener("click", loadEvents);

refreshAll();
