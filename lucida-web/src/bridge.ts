export interface BridgeHandlers {
  onSnapshot: (seq: number, sceneJson: string) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
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

    ws.onopen = () => {
      console.log("[Bridge] connected");
    };

    ws.onmessage = (event) => {
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

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

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
    this.ws?.close();
    this.ws = null;
  }
}
