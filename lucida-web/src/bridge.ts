export type ClientId = number;

export interface PresenceState {
  client_id: ClientId;
  camera: unknown;
  view: { z_range: { start: number; end: number }; t: number; c: number };
  display: { contrast_min: number; contrast_max: number; gamma: number };
  following: ClientId | null;
  cursor: [number, number] | null;
  dataset_order: string[];
  dataset_settings: Record<string, unknown>;
}

export interface BridgeHandlers {
  onSnapshot: (seq: number, documentJson: string, peers: PresenceState[], yourId: ClientId) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
  onChunkData?: (key: string, data: ArrayBuffer) => void;
  onPeerJoined?: (clientId: ClientId, presence: PresenceState) => void;
  onPeerLeft?: (clientId: ClientId) => void;
  onPresenceUpdate?: (clientId: ClientId, camera: unknown, view: PresenceState["view"], display: PresenceState["display"]) => void;
  onCursorUpdate?: (clientId: ClientId, position: [number, number] | null) => void;
  onFollowChanged?: (clientId: ClientId, target: ClientId | null) => void;
  onDatasetPresenceUpdate?: (clientId: ClientId, datasetOrder: string[], datasetSettings: Record<string, unknown>) => void;
  onOpenDatasetFailed?: (url: string, error: string) => void;
  onDisconnect?: () => void;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: string | null = null;
  private datasetPresenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDatasetPresence: string | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: string | null = null;

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
          case "dataset_presence_update":
            this.handlers.onDatasetPresenceUpdate?.(msg.client_id, msg.dataset_order, msg.dataset_settings);
            break;
          case "open_dataset_failed":
            this.handlers.onOpenDatasetFailed?.(msg.url, msg.error);
            break;
        }
      } catch (e) {
        console.warn("[Bridge] failed to parse message:", e);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.handlers.onDisconnect?.();
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

  /** Send dataset presence update, throttled to ~200ms. */
  sendDatasetPresence(json: string) {
    const obj = JSON.parse(json);
    this.pendingDatasetPresence = JSON.stringify({ type: "dataset_presence", ...obj });
    if (!this.datasetPresenceTimer) {
      this.datasetPresenceTimer = setTimeout(() => {
        this.datasetPresenceTimer = null;
        if (this.pendingDatasetPresence) {
          this.send(this.pendingDatasetPresence);
          this.pendingDatasetPresence = null;
        }
      }, 200);
    }
  }

  /** Send a request to open a remote dataset by URL. */
  sendOpenRemoteDataset(url: string) {
    this.send(JSON.stringify({ type: "open_remote_dataset", url }));
  }

  /** Send a follow request. */
  sendFollow(target: ClientId | null) {
    this.send(JSON.stringify({ type: "follow", target }));
  }

  /** Send a cursor position update, throttled to ~50ms. Null sends immediately. */
  sendCursor(position: [number, number] | null) {
    if (position === null) {
      if (this.cursorTimer !== null) {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = null;
      }
      this.pendingCursor = null;
      this.send(JSON.stringify({ type: "cursor", position: null }));
      return;
    }
    this.pendingCursor = JSON.stringify({ type: "cursor", position });
    if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        if (this.pendingCursor) {
          this.send(this.pendingCursor);
          this.pendingCursor = null;
        }
      }, 50);
    }
  }

  /** Low-level send (raw JSON string). */
  send(json: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
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
    if (this.datasetPresenceTimer !== null) {
      clearTimeout(this.datasetPresenceTimer);
    }
    if (this.cursorTimer !== null) {
      clearTimeout(this.cursorTimer);
    }
    this.ws?.close();
    this.ws = null;
  }
}
