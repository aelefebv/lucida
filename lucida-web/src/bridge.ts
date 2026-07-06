import { isDebugEnabled } from "./debug/logging.ts";
import type {
  GeneratedChunkStatus,
  WireGeneratedAvailabilityByDataset,
} from "./pipeline/generatedAvailability.ts";

export type ClientId = number;

export type DatasetHealthStatus = "healthy" | "degraded" | "unavailable";

export interface DatasetHealthComponent {
  status: DatasetHealthStatus;
  message?: string | null;
}

export interface DatasetSourceCacheStats {
  max_bytes: number;
  current_bytes: number;
  used_percent: number;
  entry_count: number;
  hits: number;
  misses: number;
  evictions: number;
  backend_errors: number;
}

export interface DatasetGeneratedCoarseCacheStats {
  storage: string;
  current_bytes: number;
  max_bytes?: number | null;
  used_percent?: number | null;
  evictions: number;
  root?: string | null;
}

export interface DatasetGeneratedCoarseFailure {
  image_id: string;
  level_index: number;
  key: string;
  status: GeneratedChunkStatus;
  message?: string | null;
}

export interface DatasetGeneratedCoarseHealth {
  status: DatasetHealthStatus;
  level_count: number;
  ready_chunks: number;
  pending_chunks: number;
  failed_chunks: number;
  unavailable_chunks: number;
  message?: string | null;
  cache?: DatasetGeneratedCoarseCacheStats | null;
  recent_failures?: DatasetGeneratedCoarseFailure[];
}

export interface DatasetSourceHealth {
  workspace_dataset_id: string;
  name: string;
  status: DatasetHealthStatus;
  source_url?: string | null;
  backend?: string | null;
  binding: DatasetHealthComponent;
  source_cache?: DatasetSourceCacheStats | null;
  generated_coarse: DatasetGeneratedCoarseHealth;
  messages?: string[];
}

export type DatasetOpenStage =
  | "request_received"
  | "authorization"
  | "source_lookup"
  | "backend_open"
  | "metadata_import"
  | "binding_build"
  | "generated_coarse_planning"
  | "workspace_persist"
  | "broadcast"
  | "complete";

export interface DatasetOpenProgressDiagnostic {
  stage: DatasetOpenStage;
  message: string;
  workspace_dataset_id?: string | null;
  dataset_source_id?: string | null;
  detail?: string | null;
}

interface PendingDatasetHealthRequest {
  resolve: (datasets: DatasetSourceHealth[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

/**
 * Mirror of `lucida_core::protocol::PeerIdentity`. Server-authored from the
 * connecting principal and surfaced on the peer's live cursor (#540). All
 * fields are best-effort: `display_name` may be empty, `picture_url` may be
 * absent (dev sessions, providers without avatars). The whole object is
 * absent for sessions without auth (the non-workspace `/ws` path), so peer
 * rendering must tolerate a missing `identity`.
 *
 * Privacy: the raw email is deliberately NOT here — collaborator emails are
 * owner-only, so presence (seen by every co-present peer, including non-owner
 * viewers/editors) must not carry it. The server precomputes a single-char
 * `initial` for the avatar chip from display-name-or-email so no address
 * crosses the wire.
 */
export interface PeerIdentity {
  display_name: string;
  picture_url?: string | null;
  /** Single-grapheme fallback glyph for the avatar chip, computed
   *  server-side (display name, else email local-part). Never the raw
   *  email. May be absent/empty for legacy peers. */
  initial?: string;
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
  /** Presentational identity for this peer's cursor (#540). Optional:
   *  absent for peers from a session without auth. */
  identity?: PeerIdentity | null;
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
  onDatasetOpenProgress?: (
    requestId: string,
    url: string,
    diagnostic: DatasetOpenProgressDiagnostic,
  ) => void;
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
  onWorkspaceArchived?: (workspaceId: string) => void;
  /**
   * The underlying WebSocket transitioned to OPEN — the transport can now
   * carry frames (before this, [`Bridge.send`] silently drops). Distinct
   * from `onSnapshot` (the application-level "session established" signal):
   * a frame sent between `onConnected` and the first snapshot still reaches
   * the server. Fires on every (re)connect's `onopen`.
   */
  onConnected?: () => void;
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
  private pendingDatasetHealth = new Map<string, PendingDatasetHealthRequest>();
  /** Bookmark-sidebar cross-peer subscribers. Owned on the bridge so
   *  feature code subscribes via a stable handle instead of wiring
   *  callbacks through React props. */
  private bookmarkChangedListeners: BookmarkChangedListener[] = [];

  constructor(handlers: BridgeHandlers, urlOverride?: string, workspaceId?: string) {
    // Same-origin WebSocket so the lucida_session cookie is sent on
    // the upgrade handshake (browsers refuse cross-origin cookies on
    // WS upgrades with SameSite=Lax). Vite dev server proxies `/ws`
    // to the backend; production serves both from one origin.
    if (urlOverride) {
      this.url = urlOverride;
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const path = workspaceId
        ? `/ws/workspaces/${encodeURIComponent(workspaceId)}`
        : "/ws";
      this.url = `${proto}//${window.location.host}${path}`;
    }
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      // A CONNECTING socket can complete after destroy(); a dead bridge
      // must not announce connectivity.
      if (this.destroyed) return;
      bridgeLog("ws.connected", { url: this.url }, ws.readyState);
      // The socket is OPEN: `send` will no longer silently drop. Notify the
      // app so readiness-gated work (e.g. the #697 seed open) can fire against
      // a transport that actually carries it, instead of a CONNECTING socket.
      this.handlers.onConnected?.();
    };

    ws.onmessage = (event) => {
      // A message task can already be queued when destroy() runs; nothing
      // received afterwards may reach the handler chain (e.g. a late
      // `workspace_archived` would navigate state outside this bridge's
      // owner).
      if (this.destroyed) return;
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
          case "dataset_open_progress":
            this.handleDatasetOpenProgress(msg);
            break;
          case "open_dataset_failed":
            this.handlers.onOpenDatasetFailed?.(msg.url, msg.error);
            break;
          case "dataset_health":
            this.handleDatasetHealth(msg);
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
          case "workspace_archived":
            this.handlers.onWorkspaceArchived?.(msg.workspace_id ?? "");
            this.destroy();
            break;
        }
      } catch (e) {
        bridgeLog("ws.bad_message", {
          error: e instanceof Error ? e.message : String(e),
        }, ws.readyState);
      }
    };

    ws.onclose = () => {
      // The close event fires asynchronously after destroy()'s close();
      // a dead bridge must not report a disconnect (or reconnect).
      if (this.destroyed) return;
      this.ws = null;
      this.handlers.onDisconnect?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.destroyed) return;
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

  private handleDatasetHealth(msg: unknown) {
    const obj = msg as { request_id?: unknown; datasets?: unknown };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    if (!requestId) return;

    const pending = this.pendingDatasetHealth.get(requestId);
    if (!pending) return;
    this.pendingDatasetHealth.delete(requestId);
    clearTimeout(pending.timer);

    const datasets = Array.isArray(obj.datasets)
      ? (obj.datasets as DatasetSourceHealth[])
      : [];
    bridgeLog("dataset_health.received", {
      requestId,
      datasetCount: datasets.length,
    }, this.ws?.readyState);
    pending.resolve(datasets);
  }

  private handleDatasetOpenProgress(msg: unknown) {
    const obj = msg as {
      request_id?: unknown;
      url?: unknown;
      diagnostic?: unknown;
    };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    const url = typeof obj.url === "string" ? obj.url : "";
    const diagnostic = obj.diagnostic as DatasetOpenProgressDiagnostic | undefined;
    if (!requestId || !diagnostic || typeof diagnostic.message !== "string") return;
    bridgeLog("open_remote_dataset.progress", {
      requestId,
      url,
      stage: diagnostic.stage,
      message: diagnostic.message,
      datasetId: diagnostic.workspace_dataset_id ?? null,
    }, this.ws?.readyState);
    this.handlers.onDatasetOpenProgress?.(requestId, url, diagnostic);
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
    const requestId = makeOpenDatasetRequestId();
    bridgeLog("open_remote_dataset.send", { url, requestId }, this.ws?.readyState);
    this.send(JSON.stringify({
      type: "open_remote_dataset",
      request_id: requestId,
      url,
    }));
  }

  sendViewerInterest(interest: unknown) {
    this.send(JSON.stringify({ type: "viewer_interest", interest }));
  }

  requestDatasetHealth(datasetId?: string | null, timeoutMs = 5000): Promise<DatasetSourceHealth[]> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket is not connected"));
    }
    const requestId = makeBridgeRequestId("web-health");
    const payload: Record<string, unknown> = {
      type: "dataset_health",
      request_id: requestId,
    };
    if (datasetId) payload.dataset_id = datasetId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDatasetHealth.delete(requestId);
        reject(new Error("Timed out waiting for dataset health"));
      }, timeoutMs);
      this.pendingDatasetHealth.set(requestId, { resolve, reject, timer });
      bridgeLog("dataset_health.send", {
        requestId,
        datasetId: datasetId ?? null,
      }, this.ws?.readyState);
      this.send(JSON.stringify(payload));
    });
  }

  sendDatasetRetry(datasetId: string) {
    const requestId = makeBridgeRequestId("web-retry");
    bridgeLog("dataset_retry.send", {
      requestId,
      datasetId,
    }, this.ws?.readyState);
    this.send(JSON.stringify({
      type: "dataset_retry",
      request_id: requestId,
      dataset_id: datasetId,
    }));
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

  /** Low-level send (raw JSON string). Drops the frame unless the socket is
   *  OPEN; a destroyed bridge never transmits. */
  send(json: string) {
    if (this.destroyed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  /**
   * Permanently shut this bridge down. After this returns, no handler
   * callback fires again (the socket's event handlers are detached and
   * every callback is additionally gated on `destroyed`, covering event
   * tasks already queued), no frame is transmitted, no reconnect is
   * attempted, and every pending request promise is settled. Idempotent.
   */
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
    for (const pending of this.pendingDatasetHealth.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge destroyed"));
    }
    this.pendingDatasetHealth.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach before closing: close() only queues the close event, and a
      // received-message task may already be queued ahead of it. Detaching
      // (plus the `destroyed` gates in each handler) guarantees neither
      // dispatches into the handler chain after this point.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }
}

function makeOpenDatasetRequestId(): string {
  return makeBridgeRequestId("web");
}

function makeBridgeRequestId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
