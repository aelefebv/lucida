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
import {
  LiveRenderLoop,
  type RenderFrameState,
} from "./live-render-loop";
import { InteractionModel, type ViewportState } from "./interaction-model";
import type { ViewerRoute } from "./viewer-route";

export type ViewerRuntimeState = {
  routeKind: ViewerRoute["kind"];
  connection: ConnectionState;
  connectionSummary: string | null;
  snapshot: SnapshotPayload | null;
  clientState: ClientState | null;
  renderFrame: RenderFrameState | null;
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

type ConnectMode = "attach" | "reconnect";

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
  private readonly renderLoop: LiveRenderLoop;
  private stateValue: ViewerRuntimeState;
  private socketValue: WebSocket | null;
  private interactionModel: InteractionModel | null;
  private interactionClientId: string | null;
  private lastAttachedClientId: string | null;
  private gestureCounter: number;
  private reconnectScheduled: boolean;
  private disposed: boolean;

  public constructor(
    route: ViewerRoute,
    onUpdate: (state: ViewerRuntimeState) => void,
  ) {
    this.route = route;
    this.onUpdate = onUpdate;
    this.bootstrap = new ConnectionBootstrap();
    this.renderLoop = new LiveRenderLoop(route.dataBase, (renderFrame) => {
      this.stateValue = {
        ...this.stateValue,
        renderFrame,
      };
      this.onUpdate(this.stateValue);
    });
    this.stateValue = {
      routeKind: route.kind,
      connection: this.bootstrap.state(),
      connectionSummary: null,
      snapshot: null,
      clientState: null,
      renderFrame: null,
    };
    this.socketValue = null;
    this.interactionModel = null;
    this.interactionClientId = null;
    this.lastAttachedClientId = null;
    this.gestureCounter = 1;
    this.reconnectScheduled = false;
    this.disposed = false;
  }

  public start(): void {
    this.connect("attach");
  }

  public pan(dx: number, dy: number): void {
    if (this.interactionModel === null) {
      return;
    }
    const gestureId = this.nextGestureId();
    this.interactionModel.beginGesture(gestureId);
    this.interactionModel.pan(dx, dy);
    this.interactionModel.endGesture();
    this.flushInteractionCommands();
  }

  public zoom(scale: number, anchorX: number, anchorY: number): void {
    if (this.interactionModel === null) {
      return;
    }
    const gestureId = this.nextGestureId();
    this.interactionModel.beginGesture(gestureId);
    this.interactionModel.zoom(scale, anchorX, anchorY);
    this.interactionModel.endGesture();
    this.flushInteractionCommands();
  }

  public setZ(zIndex: number): void {
    if (this.interactionModel === null) {
      return;
    }
    this.interactionModel.setZ(zIndex);
    this.flushInteractionCommands();
  }

  public setT(tIndex: number): void {
    if (this.interactionModel === null) {
      return;
    }
    this.interactionModel.setT(tIndex);
    this.flushInteractionCommands();
  }

  public setChannels(channels: number[]): void {
    if (this.interactionModel === null) {
      return;
    }
    this.interactionModel.setChannels(channels);
    this.flushInteractionCommands();
  }

  public dispose(): void {
    this.disposed = true;
    this.reconnectScheduled = false;
    this.renderLoop.dispose();
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
    this.lastAttachedClientId = nextClientState.clientId;
    this.ensureInteractionModel(nextClientState);
    this.stateValue = {
      ...this.stateValue,
      connection: this.bootstrap.state(),
      connectionSummary:
        capabilitySummary(this.bootstrap.state()),
      snapshot: message.snapshot,
      clientState: nextClientState,
    };
    this.renderLoop.update(nextClientState);
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
    if (this.stateValue.clientState !== null) {
      if (this.interactionModel !== null) {
        this.interactionModel.reconcileAuthoritative(
          viewportFromClientState(this.stateValue.clientState),
        );
      }
      this.renderLoop.update(this.stateValue.clientState);
    }
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

  private connect(mode: ConnectMode): void {
    if (this.disposed) {
      return;
    }
    if (this.socketValue !== null) {
      this.socketValue.close();
      this.socketValue = null;
    }

    const payload = this.bootstrap.begin(this.attachOptions());
    this.publish();

    const wsBase = this.route.wsBase.replace(/\/$/, "");
    const url = `${wsBase}/v1/sessions/${encodeURIComponent(this.route.sessionId)}/connect`;
    const socket = new WebSocket(url);
    this.socketValue = socket;

    socket.addEventListener("open", () => {
      if (mode === "reconnect" && this.lastAttachedClientId !== null) {
        socket.send(
          JSON.stringify({
            message_type: "reconnect",
            client_label: payload.client_label,
            requested_permission: payload.requested_permission,
            previous_client_id: this.lastAttachedClientId,
          }),
        );
        return;
      }
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
      if (this.bootstrap.state().phase === "attached") {
        this.scheduleReconnect();
        return;
      }
      this.bootstrap.fail("control-plane connection closed before attach");
      this.publish();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectScheduled || this.lastAttachedClientId === null) {
      return;
    }
    this.reconnectScheduled = true;
    setTimeout(() => {
      this.reconnectScheduled = false;
      if (this.disposed) {
        return;
      }
      this.connect("reconnect");
    }, 80);
  }

  private flushInteractionCommands(): void {
    if (this.interactionModel === null) {
      return;
    }
    const socket = this.socketValue;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      this.interactionModel.drainCommands();
      return;
    }
    const commands = this.interactionModel.drainCommands();
    for (const command of commands) {
      socket.send(JSON.stringify(command));
    }
  }

  private ensureInteractionModel(clientState: ClientState): void {
    if (
      this.interactionModel === null ||
      this.interactionClientId !== clientState.clientId
    ) {
      this.interactionModel = new InteractionModel(
        clientState.sessionId,
        clientState.clientId,
        viewportFromClientState(clientState),
      );
      this.interactionClientId = clientState.clientId;
      return;
    }

    this.interactionModel.reconcileAuthoritative(
      viewportFromClientState(clientState),
    );
  }

  private attachOptions(): AttachOptions {
    if (this.route.token === undefined) {
      return {
        sessionId: this.route.sessionId,
        clientLabel: this.route.clientLabel,
        mode: this.route.mode,
      };
    }
    return {
      sessionId: this.route.sessionId,
      clientLabel: this.route.clientLabel,
      mode: this.route.mode,
      token: this.route.token,
    };
  }

  private nextGestureId(): string {
    const next = this.gestureCounter;
    this.gestureCounter += 1;
    return `gesture-${next.toString()}`;
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

function viewportFromClientState(clientState: ClientState): ViewportState {
  return {
    centerX: clientState.centerX,
    centerY: clientState.centerY,
    zoom: clientState.zoom,
    zIndex: clientState.zIndex,
    tIndex: clientState.tIndex,
    selectedChannels: [...clientState.selectedChannels],
  };
}
