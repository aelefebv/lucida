const logEl = document.getElementById("log");
const canvas = document.getElementById("renderCanvas");
const ctx = canvas.getContext("2d");
const wsUrlEl = document.getElementById("wsUrl");
const tokenEl = document.getElementById("token");
const sessionEl = document.getElementById("sessionId");
const viewEl = document.getElementById("viewId");
const connectBtn = document.getElementById("connectBtn");
const sessionGetBtn = document.getElementById("sessionGetBtn");

let socket = null;
let planSeq = -1;

function log(message, payload = null) {
  const stamp = new Date().toISOString();
  const line = payload ? `${stamp} ${message} ${JSON.stringify(payload)}` : `${stamp} ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
}

function sendRpc(method, params) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("socket not connected");
    return;
  }

  const id = crypto.randomUUID();
  socket.send(
    JSON.stringify({
      type: "rpc.request",
      id,
      method,
      params,
    }),
  );
}

function drawTile(message) {
  const tilePlanSeq = Number(message.plan_seq ?? 0);
  if (tilePlanSeq < planSeq) {
    return;
  }
  planSeq = tilePlanSeq;

  const image = new Image();
  const mime = message.format === "png" ? "image/png" : "image/jpeg";
  image.onload = () => {
    if (canvas.width !== message.width + message.x || canvas.height !== message.height + message.y) {
      canvas.width = Math.max(canvas.width, message.width + message.x);
      canvas.height = Math.max(canvas.height, message.height + message.y);
    }
    ctx.drawImage(image, message.x, message.y, message.width, message.height);
  };
  image.src = `data:${mime};base64,${message.payload_b64}`;
}

connectBtn.addEventListener("click", () => {
  const wsUrl = wsUrlEl.value.trim();
  const token = tokenEl.value.trim();
  const sessionId = sessionEl.value.trim();
  const viewId = viewEl.value.trim();

  if (!wsUrl || !token || !sessionId || !viewId) {
    log("missing required fields");
    return;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  const wsUrlWithToken = (() => {
    try {
      const parsed = new URL(wsUrl);
      parsed.searchParams.set("token", token);
      return parsed.toString();
    } catch {
      return wsUrl;
    }
  })();

  socket = new WebSocket(wsUrlWithToken, []);
  socket.addEventListener("open", () => {
    log("ws open");
    socket.send(
      JSON.stringify({
        type: "attach",
        session_id: sessionId,
        view_id: viewId,
        client_name: "lucida-web-reference",
        client_version: "0.1.0",
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "attach.ok") {
      log("attached", message);
      sessionGetBtn.disabled = false;
      return;
    }
    if (message.type === "render.tile") {
      drawTile(message);
      return;
    }
    if (message.type === "event") {
      log("event", { event_type: message.event?.event_type, session_seq: message.event?.session_seq });
      return;
    }
    if (message.type === "rpc.response") {
      log("rpc.response", message);
      return;
    }
    if (message.type === "rpc.error") {
      log("rpc.error", message);
      return;
    }
    if (message.type === "render.status") {
      log("render.status", message);
      return;
    }
    log("unknown message", message);
  });

  socket.addEventListener("close", () => {
    sessionGetBtn.disabled = true;
    log("ws closed");
  });

  socket.addEventListener("error", () => {
    log("ws error");
  });

  log("using query token auth for browser websocket", { token_preview: `${token.slice(0, 3)}***` });
});

sessionGetBtn.addEventListener("click", () => {
  sendRpc("session.get", {
    session_id: sessionEl.value.trim(),
  });
});
