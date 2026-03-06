export type CommandHandler = (json: string) => void;

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handler: CommandHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(handler: CommandHandler, port = 9876) {
    this.url = `ws://localhost:${port}`;
    this.handler = handler;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    const ws = new WebSocket(this.url);

    ws.onopen = () => {
      console.log("[Bridge] connected");
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handler(event.data);
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
