import { createCommandEnvelope, type CommandEnvelope } from "./protocol";

export type ViewportState = {
  centerX: number;
  centerY: number;
  zoom: number;
  zIndex: number;
  tIndex: number;
  selectedChannels: number[];
};

export type InteractionCommandArgs =
  | { dx: number; dy: number; gesture_id: string }
  | { zoom: number; anchor_x: number; anchor_y: number; gesture_id: string }
  | { z_index: number }
  | { t_index: number }
  | { channels: number[] };

export type InteractionCommand = CommandEnvelope<InteractionCommandArgs>;

export class InteractionModel {
  private stateValue: ViewportState;
  private pendingCommands: InteractionCommand[];
  private clientSeq: number;
  private readonly sessionId: string;
  private readonly clientId: string;
  private activeGestureId: string | null;

  public constructor(sessionId: string, clientId: string, initial: ViewportState) {
    this.stateValue = initial;
    this.pendingCommands = [];
    this.clientSeq = 1;
    this.sessionId = sessionId;
    this.clientId = clientId;
    this.activeGestureId = null;
  }

  public beginGesture(gestureId: string): void {
    this.activeGestureId = gestureId;
  }

  public endGesture(): void {
    this.activeGestureId = null;
  }

  public pan(dx: number, dy: number): void {
    const gestureId = this.requireGestureId();
    this.stateValue = {
      ...this.stateValue,
      centerX: this.stateValue.centerX + dx,
      centerY: this.stateValue.centerY + dy,
    };
    this.enqueue("view.pan", { dx, dy, gesture_id: gestureId });
  }

  public zoom(scale: number, anchorX: number, anchorY: number): void {
    const gestureId = this.requireGestureId();
    this.stateValue = {
      ...this.stateValue,
      zoom: this.stateValue.zoom * scale,
    };
    this.enqueue("view.zoom", {
      zoom: this.stateValue.zoom,
      anchor_x: anchorX,
      anchor_y: anchorY,
      gesture_id: gestureId,
    });
  }

  public setZ(zIndex: number): void {
    this.stateValue = {
      ...this.stateValue,
      zIndex,
    };
    this.enqueue("view.set_z", { z_index: zIndex });
  }

  public setT(tIndex: number): void {
    this.stateValue = {
      ...this.stateValue,
      tIndex,
    };
    this.enqueue("view.set_t", { t_index: tIndex });
  }

  public setChannels(channels: number[]): void {
    this.stateValue = {
      ...this.stateValue,
      selectedChannels: [...channels],
    };
    this.enqueue("view.set_channels", { channels: [...channels] });
  }

  public drainCommands(): InteractionCommand[] {
    const drained = [...this.pendingCommands];
    this.pendingCommands = [];
    return drained;
  }

  public state(): ViewportState {
    return this.stateValue;
  }

  public reconcileAuthoritative(authoritative: ViewportState): void {
    this.stateValue = {
      centerX: reconcileAxis(this.stateValue.centerX, authoritative.centerX),
      centerY: reconcileAxis(this.stateValue.centerY, authoritative.centerY),
      zoom: reconcileAxis(this.stateValue.zoom, authoritative.zoom),
      zIndex: authoritative.zIndex,
      tIndex: authoritative.tIndex,
      selectedChannels: [...authoritative.selectedChannels],
    };
  }

  private enqueue(op: string, args: InteractionCommandArgs): void {
    this.pendingCommands.push(
      createCommandEnvelope({
        sessionId: this.sessionId,
        clientId: this.clientId,
        clientSeq: this.clientSeq,
        op,
        scope: "client_view",
        requiresLease: false,
        args,
      }),
    );
    this.clientSeq += 1;
  }

  private requireGestureId(): string {
    if (this.activeGestureId === null) {
      throw new Error("gesture must be active");
    }
    return this.activeGestureId;
  }
}

function reconcileAxis(predicted: number, authoritative: number): number {
  const delta = Math.abs(predicted - authoritative);
  if (delta < 0.001) {
    return predicted;
  }
  return authoritative;
}
