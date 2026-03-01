import {
  ConnectionBootstrap,
  permissionSummary,
  type AttachOptions,
  type ConnectionState,
  type PermissionClass,
} from "./connection-bootstrap";
import {
  applyEvent,
  hydrateClientState,
  reconcileWithSnapshot,
  type ClientState,
  type EventEnvelope,
  type SnapshotPayload,
} from "./client-store";
import type { ViewerRoute } from "./viewer-route";

export type ViewerRuntimeState = {
  routeKind: ViewerRoute["kind"];
  connection: ConnectionState;
  connectionSummary: string | null;
  snapshot: SnapshotPayload | null;
  clientState: ClientState | null;
};

type RuntimeSnapshotMessage = {
  message_type: "session.snapshot";
  permission_class: PermissionClass;
  is_lease_holder: boolean;
  snapshot: SnapshotPayload;
};

type RuntimeErrorMessage = {
  message_type: "error";
  message: string;
};

const CLIENT_EVENT_TYPES = new Set<EventEnvelope["event_type"]>([
  "scene_source_upsert",
  "scene_dataset_upsert",
  "scene_layer_upsert",
  "warnings_updated",
  "view_updated",
  "source_generation_detected",
  "source_generation_started",
  "source_generation_progress",
  "source_generation_ready",
]);

export class ViewerRuntime {
  private readonly route: ViewerRoute;
  private readonly onUpdate: (state: ViewerRuntimeState) => void;
  private readonly bootstrap: ConnectionBootstrap;
  private stateValue: ViewerRuntimeState;
  private socketValue: WebSocket | null;
  private disposed: boolean;

  public constructor(
    route: ViewerRoute,
    onUpdate: (state: ViewerRuntimeState) => void,
  ) {
    this.route = route;
    this.onUpdate = onUpdate;
    this.bootstrap = new ConnectionBootstrap();
    this.stateValue = {
      routeKind: route.kind,
      connection: this.bootstrap.state(),
      connectionSummary: null,
      snapshot: null,
      clientState: null,
    };
    this.socketValue = null;
    this.disposed = false;
  }

  public start(): void {
    const attachOptions: AttachOptions =
      this.route.token === undefined
        ? {
            sessionId: this.route.sessionId,
            clientLabel: this.route.clientLabel,
            mode: this.route.mode,
          }
        : {
            sessionId: this.route.sessionId,
            clientLabel: this.route.clientLabel,
            mode: this.route.mode,
            token: this.route.token,
          };
    const payload = this.bootstrap.begin(attachOptions);
    this.publish();

    const wsBase = this.route.wsBase.replace(/\/$/, "");
    const url = `${wsBase}/v1/sessions/${encodeURIComponent(this.route.sessionId)}/connect`;
    const socket = new WebSocket(url);
    this.socketValue = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          message_type: "attach",
          client_label: payload.client_label,
          requested_permission: payload.requested_permission,
          auth: payload.auth,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      this.handleFrame(event.data);
    });
    socket.addEventListener("error", () => {
      if (this.disposed) {
        return;
      }
      this.bootstrap.fail("control-plane transport error");
      this.publish();
    });
    socket.addEventListener("close", () => {
      if (this.disposed) {
        return;
      }
      if (this.bootstrap.state().phase !== "attached") {
        this.bootstrap.fail("control-plane connection closed before attach");
      }
      this.publish();
    });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.socketValue !== null) {
      this.socketValue.close();
      this.socketValue = null;
    }
  }

  public state(): ViewerRuntimeState {
    return this.stateValue;
  }

  private handleFrame(rawFrame: unknown): void {
    if (typeof rawFrame !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFrame);
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }
    const messageType = parsed.message_type;
    if (messageType === "session.snapshot") {
      this.handleSnapshot(parsed as RuntimeSnapshotMessage);
      return;
    }
    if (messageType === "event") {
      this.handleEvent(parsed);
      return;
    }
    if (messageType === "error") {
      const error = parsed as RuntimeErrorMessage;
      this.bootstrap.fail(error.message);
      this.publish();
    }
  }

  private handleSnapshot(message: RuntimeSnapshotMessage): void {
    this.bootstrap.complete(
      message.permission_class,
      Boolean(message.is_lease_holder),
    );
    const nextClientState =
      this.stateValue.clientState === null
        ? hydrateClientState(message.snapshot)
        : reconcileWithSnapshot(this.stateValue.clientState, message.snapshot);
    this.stateValue = {
      ...this.stateValue,
      connection: this.bootstrap.state(),
      connectionSummary:
        capabilitySummary(this.bootstrap.state()),
      snapshot: message.snapshot,
      clientState: nextClientState,
    };
    this.onUpdate(this.stateValue);
  }

  private handleEvent(raw: Record<string, unknown>): void {
    if (this.stateValue.clientState === null) {
      return;
    }
    const eventType = raw.event_type;
    if (typeof eventType !== "string" || !isClientEventType(eventType)) {
      return;
    }
    const sessionRev = raw.session_rev;
    if (typeof sessionRev !== "number") {
      return;
    }
    const event: EventEnvelope = {
      session_rev: sessionRev,
      event_type: eventType,
      payload: raw.payload,
    };
    this.stateValue = {
      ...this.stateValue,
      clientState: applyEvent(this.stateValue.clientState, event),
    };
    this.onUpdate(this.stateValue);
  }

  private publish(): void {
    this.stateValue = {
      ...this.stateValue,
      connection: this.bootstrap.state(),
      connectionSummary:
        capabilitySummary(this.bootstrap.state()),
    };
    this.onUpdate(this.stateValue);
  }
}

function capabilitySummary(state: ConnectionState): string | null {
  if (state.capabilities === null) {
    return null;
  }
  return permissionSummary(state.capabilities);
}

function isClientEventType(value: string): value is EventEnvelope["event_type"] {
  return CLIENT_EVENT_TYPES.has(value as EventEnvelope["event_type"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
