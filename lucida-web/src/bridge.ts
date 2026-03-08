export interface BridgeHandlers {
  onSnapshot: (seq: number, sceneJson: string) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
  onChunkFetch?: (clientId: number, datasetId: string, key: string) => void;
  onChunkData?: (key: string, data: ArrayBuffer) => void;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

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
            this.handlers.onSnapshot(msg.seq, JSON.stringify(msg.scene));
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
    this.ws?.close();
    this.ws = null;
  }
}
