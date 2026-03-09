export type ClientId = number;

export interface PresenceState {
  client_id: ClientId;
  camera: unknown;
  view: unknown;
  display: { contrast_min: number; contrast_max: number; gamma: number };
  following: ClientId | null;
  cursor: [number, number] | null;
}

export interface BridgeHandlers {
  onSnapshot: (seq: number, documentJson: string, peers: PresenceState[], yourId: ClientId) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
  onChunkFetch?: (clientId: number, datasetId: string, key: string) => void;
  onChunkData?: (key: string, data: ArrayBuffer) => void;
  onPeerJoined?: (clientId: ClientId, presence: PresenceState) => void;
  onPeerLeft?: (clientId: ClientId) => void;
  onPresenceUpdate?: (clientId: ClientId, camera: unknown, view: unknown, display: PresenceState["display"]) => void;
  onCursorUpdate?: (clientId: ClientId, position: [number, number]) => void;
  onFollowChanged?: (clientId: ClientId, target: ClientId | null) => void;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: string | null = null;

  constructor(handlers: BridgeHandlers, port = 9876) {
    this.url = `ws://localhost:${port}`;
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("[Bridge] connected");
    };

    ws.onmessage = (event) => {
      // Binary message: chunk data relay
      if (event.data instanceof ArrayBuffer) {
        this.handleBinary(event.data);
        return;
      }

      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "snapshot":
            this.handlers.onSnapshot(
              msg.seq,
              JSON.stringify(msg.document),
              msg.peers ?? [],
              msg.your_id ?? 0,
            );
            break;
          case "command_broadcast":
            this.handlers.onCommand(msg.seq, JSON.stringify(msg.command));
            break;
          case "ack":
            this.handlers.onAck(msg.seq);
            break;
          case "chunk_fetch":
            this.handlers.onChunkFetch?.(msg.client_id, msg.dataset_id, msg.key);
            break;
          case "peer_joined":
            this.handlers.onPeerJoined?.(msg.client_id, msg.presence);
            break;
          case "peer_left":
            this.handlers.onPeerLeft?.(msg.client_id);
            break;
          case "presence_update":
            this.handlers.onPresenceUpdate?.(msg.client_id, msg.camera, msg.view, msg.display);
            break;
          case "cursor_update":
            this.handlers.onCursorUpdate?.(msg.client_id, msg.position);
            break;
          case "follow_changed":
            this.handlers.onFollowChanged?.(msg.client_id, msg.target);
            break;
        }
      } catch (e) {
        console.warn("[Bridge] failed to parse message:", e);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };

    this.ws = ws;
  }

  private handleBinary(buffer: ArrayBuffer) {
    if (buffer.byteLength < 6) return;
    const view = new DataView(buffer);
    // Skip client_id (4 bytes) — we are the target
    const keyLen = view.getUint16(4, true);
    if (buffer.byteLength < 6 + keyLen) return;
    const keyBytes = new Uint8Array(buffer, 6, keyLen);
    const key = new TextDecoder().decode(keyBytes);
    const chunkData = buffer.slice(6 + keyLen);
    this.handlers.onChunkData?.(key, chunkData);
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  /** Send a document command wrapped in the ClientMessage envelope. */
  sendCommand(json: string) {
    const cmd = JSON.parse(json);
    this.send(JSON.stringify({ type: "command", command: cmd }));
  }

  /** Send presence update, throttled to ~50ms. */
  sendPresence(presenceJson: string) {
    // Merge type field into the presence object
    const obj = JSON.parse(presenceJson);
    this.pendingPresence = JSON.stringify({ type: "presence", ...obj });
    if (!this.presenceTimer) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        if (this.pendingPresence) {
          this.send(this.pendingPresence);
          this.pendingPresence = null;
        }
      }, 50);
    }
  }

  /** Send a follow request. */
  sendFollow(target: ClientId | null) {
    this.send(JSON.stringify({ type: "follow", target }));
  }

  /** Send a cursor position update. */
  sendCursor(position: [number, number]) {
    this.send(JSON.stringify({ type: "cursor", position }));
  }

  /** Low-level send (raw JSON string). */
  send(json: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  sendBinary(data: ArrayBuffer | Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
    }
    this.ws?.close();
    this.ws = null;
  }
}
