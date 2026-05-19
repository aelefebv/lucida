import { isDebugEnabled } from "./debug/logging.ts";
import type {
  GeneratedChunkStatus,
  WireGeneratedAvailabilityByDataset,
} from "./pipeline/generatedAvailability.ts";

export type ClientId = number;

/**
 * Gated debug logger for bridge events. Toggle via the DebugPanel "Logging"
 * tab or `localStorage.setItem("debug", "bridge")`. See
 * `wiki/decisions/logging-conventions.md`.
 */
export function bridgeLog(event: string, data: Record<string, unknown> = {}, wsReadyState?: number) {
  if (!isDebugEnabled("bridge")) return;
  const payload = wsReadyState !== undefined ? { wsReadyState, ...data } : data;
  console.log(`[bridge] ${event}`, payload);
}

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
  onSnapshot: (
    seq: number,
    documentJson: string,
    peers: PresenceState[],
    yourId: ClientId,
    generatedAvailability: WireGeneratedAvailabilityByDataset,
  ) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
  /**
   * Binary frame received from the WebSocket. The bridge parses the
   * envelope (client_id + keyLen + key + payload) and forwards
   * (key, payload) here. The chunk-vs-proxy routing decision lives
   * in the application layer (the content source) so the bridge stays
   * a generic binary transport.
   */
  onBinary?: (key: string, payload: ArrayBuffer) => void;
  onPeerJoined?: (clientId: ClientId, presence: PresenceState) => void;
  onPeerLeft?: (clientId: ClientId) => void;
  onPresenceUpdate?: (clientId: ClientId, camera: unknown, view: PresenceState["view"], display: PresenceState["display"]) => void;
  onCursorUpdate?: (clientId: ClientId, position: [number, number] | null) => void;
  onFollowChanged?: (clientId: ClientId, target: ClientId | null) => void;
  onDatasetPresenceUpdate?: (clientId: ClientId, datasetOrder: string[], datasetSettings: Record<string, unknown>) => void;
  onOpenDatasetFailed?: (url: string, error: string) => void;
  /**
   * The server may emit an empty `delta.added` as a sanity check (no-op).
   */
  onAssetCatalogUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedAvailabilityUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: GeneratedChunkStatus,
    message?: string | null,
  ) => void;
  /**
   * Cross-peer bookmark-sidebar updates. Fired when the server
   * broadcasts a `bookmark_changed` message because some client
   * mutated a bookmark whose dataset URLs overlap a loaded dataset
   * in this session. `useBookmarks` uses this to refetch
   * (Created/Updated) or remove from local state (Deleted) without
   * waiting for a manual refresh.
   */
  onBookmarkChanged?: (
    id: string,
    action: BookmarkAction,
    datasetUrls: string[],
  ) => void;
  onDisconnect?: () => void;
}

/** Mirror of `lucida_core::protocol::BookmarkAction` (lowercase wire form). */
export type BookmarkAction = "created" | "updated" | "deleted";

/** Listener for cross-peer `bookmark_changed` broadcasts. Subscribed to
 *  via [`Bridge.subscribeBookmarkChanged`] — the WS handler invokes
 *  every registered listener in registration order. Fan-out lives on
 *  the bridge so feature code (e.g. `useBookmarks`) doesn't have to
 *  thread a pub-sub through React props. */
export type BookmarkChangedListener = (
  id: string,
  action: BookmarkAction,
  datasetUrls: string[],
) => void;

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
  /** Bookmark-sidebar cross-peer subscribers. Owned on the bridge so
   *  feature code subscribes via a stable handle instead of wiring
   *  callbacks through React props. */
  private bookmarkChangedListeners: BookmarkChangedListener[] = [];

  constructor(handlers: BridgeHandlers, urlOverride?: string) {
    // Same-origin WebSocket so the lucida_session cookie is sent on
    // the upgrade handshake (browsers refuse cross-origin cookies on
    // WS upgrades with SameSite=Lax). Vite dev server proxies `/ws`
    // to the backend; production serves both from one origin.
    if (urlOverride) {
      this.url = urlOverride;
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${window.location.host}/ws`;
    }
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      bridgeLog("ws.connected", { url: this.url }, ws.readyState);
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
              msg.generated_availability ?? {},
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
          case "asset_catalog_update":
            this.handlers.onAssetCatalogUpdate?.(
              msg.dataset_id,
              JSON.stringify(msg.delta ?? { added: [] }),
            );
            break;
          case "generated_availability_update":
            this.handlers.onGeneratedAvailabilityUpdate?.(
              msg.dataset_id,
              JSON.stringify(msg.delta ?? { levels: [], chunks: [] }),
            );
            break;
          case "generated_chunk_status":
            this.handlers.onGeneratedChunkStatus?.(
              msg.dataset_id,
              msg.image_id,
              msg.key,
              msg.status,
              msg.message ?? null,
            );
            break;
          case "bookmark_changed": {
            const action = msg.action as BookmarkAction;
            const datasetUrls: string[] = Array.isArray(msg.dataset_urls)
              ? msg.dataset_urls
              : [];
            const id: string = typeof msg.id === "string" ? msg.id : "";
            this.handlers.onBookmarkChanged?.(id, action, datasetUrls);
            for (const cb of this.bookmarkChangedListeners) {
              try {
                cb(id, action, datasetUrls);
              } catch (e) {
                bridgeLog("bookmark_changed.listener_threw", {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
            break;
          }
        }
      } catch (e) {
        bridgeLog("ws.bad_message", {
          error: e instanceof Error ? e.message : String(e),
        }, ws.readyState);
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
    const payload = buffer.slice(6 + keyLen);
    // The transport doesn't know the application's chunk-vs-proxy
    // taxonomy — forward the (key, payload) pair and let the
    // application layer dispatch.
    this.handlers.onBinary?.(key, payload);
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

  /** Send presence update, throttled to ~50ms (leading+trailing edge). */
  sendPresence(presenceJson: string) {
    // Merge type field into the presence object
    const obj = JSON.parse(presenceJson);
    const json = JSON.stringify({ type: "presence", ...obj });
    if (!this.presenceTimer) {
      // Leading edge: send immediately, start cooldown
      this.send(json);
      this.pendingPresence = null;
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        if (this.pendingPresence) {
          this.send(this.pendingPresence);
          this.pendingPresence = null;
        }
      }, 50);
    } else {
      // During cooldown: store latest for trailing edge
      this.pendingPresence = json;
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

  sendOpenRemoteDataset(url: string) {
    bridgeLog("open_remote_dataset.send", { url }, this.ws?.readyState);
    this.send(JSON.stringify({ type: "open_remote_dataset", url }));
  }

  sendViewerInterest(interest: unknown) {
    this.send(JSON.stringify({ type: "viewer_interest", interest }));
  }

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

  /** Subscribe to cross-peer `bookmark_changed` broadcasts. Returns
   *  an unsubscribe function. Listeners run in registration order;
   *  exceptions in a listener are logged but don't break the chain. */
  subscribeBookmarkChanged(cb: BookmarkChangedListener): () => void {
    this.bookmarkChangedListeners.push(cb);
    return () => {
      const idx = this.bookmarkChangedListeners.indexOf(cb);
      if (idx >= 0) this.bookmarkChangedListeners.splice(idx, 1);
    };
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
