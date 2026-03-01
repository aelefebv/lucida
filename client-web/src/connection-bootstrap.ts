export type AttachMode = "open_view" | "token_view" | "control";
export type PermissionClass = "view" | "control" | "admin";

export type AttachOptions = {
  sessionId: string;
  clientLabel: string;
  mode: AttachMode;
  token?: string;
};

export type AttachPayload = {
  session_id: string;
  client_label: string;
  requested_permission: PermissionClass;
  auth: {
    mode: AttachMode;
    token: string | null;
  };
};

export type Capabilities = {
  canView: boolean;
  canControl: boolean;
  canEditSharedScene: boolean;
  canPublishDerived: boolean;
};

export type ConnectionState = {
  phase: "idle" | "connecting" | "attached" | "error";
  mode: AttachMode | null;
  tokenPresent: boolean;
  capabilities: Capabilities | null;
  message: string | null;
};

const VIEW_CAPABILITIES: Capabilities = {
  canView: true,
  canControl: false,
  canEditSharedScene: false,
  canPublishDerived: false,
};

export function buildAttachPayload(options: AttachOptions): AttachPayload {
  if (options.sessionId.length === 0) {
    throw new Error("sessionId is required");
  }
  if (options.clientLabel.length === 0) {
    throw new Error("clientLabel is required");
  }
  if (
    (options.mode === "token_view" || options.mode === "control") &&
    (options.token === undefined || options.token.length === 0)
  ) {
    throw new Error("token is required for token_view/control attach modes");
  }

  return {
    session_id: options.sessionId,
    client_label: options.clientLabel,
    requested_permission: options.mode === "control" ? "control" : "view",
    auth: {
      mode: options.mode,
      token: options.token ?? null,
    },
  };
}

export function deriveCapabilities(
  permissionClass: PermissionClass,
  isLeaseHolder: boolean,
): Capabilities {
  if (permissionClass === "view") {
    return VIEW_CAPABILITIES;
  }

  const canControl = permissionClass === "control" || permissionClass === "admin";
  return {
    canView: true,
    canControl,
    canEditSharedScene: canControl && isLeaseHolder,
    canPublishDerived: canControl,
  };
}

export function permissionSummary(capabilities: Capabilities): string {
  if (!capabilities.canControl) {
    return "View only";
  }
  if (capabilities.canEditSharedScene) {
    return "Control (lease holder)";
  }
  return "Control (observer)";
}

export class ConnectionBootstrap {
  private stateValue: ConnectionState;

  public constructor() {
    this.stateValue = {
      phase: "idle",
      mode: null,
      tokenPresent: false,
      capabilities: null,
      message: null,
    };
  }

  public begin(options: AttachOptions): AttachPayload {
    const payload = buildAttachPayload(options);
    this.stateValue = {
      phase: "connecting",
      mode: options.mode,
      tokenPresent: payload.auth.token !== null,
      capabilities: null,
      message: null,
    };
    return payload;
  }

  public complete(permissionClass: PermissionClass, isLeaseHolder: boolean): void {
    this.stateValue = {
      ...this.stateValue,
      phase: "attached",
      capabilities: deriveCapabilities(permissionClass, isLeaseHolder),
      message: null,
    };
  }

  public fail(message: string): void {
    this.stateValue = {
      ...this.stateValue,
      phase: "error",
      message,
    };
  }

  public state(): ConnectionState {
    return this.stateValue;
  }
}
