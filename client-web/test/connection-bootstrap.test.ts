import { describe, expect, it } from "vitest";

import {
  ConnectionBootstrap,
  buildAttachPayload,
  deriveCapabilities,
  permissionSummary,
} from "../src/connection-bootstrap";

describe("connection bootstrap", () => {
  it("builds open-view attach payload without token", () => {
    const payload = buildAttachPayload({
      sessionId: "sess_00000001",
      clientLabel: "browser-a",
      mode: "open_view",
    });

    expect(payload.requested_permission).toBe("view");
    expect(payload.auth.token).toBeNull();
  });

  it("requires token for token_view and control modes", () => {
    expect(() =>
      buildAttachPayload({
        sessionId: "sess_00000001",
        clientLabel: "browser-a",
        mode: "token_view",
      }),
    ).toThrow("token is required");

    expect(() =>
      buildAttachPayload({
        sessionId: "sess_00000001",
        clientLabel: "browser-a",
        mode: "control",
      }),
    ).toThrow("token is required");
  });

  it("derives capability display state from permission and lease", () => {
    const controlObserver = deriveCapabilities("control", false);
    const controlHolder = deriveCapabilities("control", true);
    const viewOnly = deriveCapabilities("view", false);

    expect(permissionSummary(controlObserver)).toBe("Control (observer)");
    expect(permissionSummary(controlHolder)).toBe("Control (lease holder)");
    expect(permissionSummary(viewOnly)).toBe("View only");
  });

  it("tracks handshake lifecycle state transitions", () => {
    const bootstrap = new ConnectionBootstrap();
    bootstrap.begin({
      sessionId: "sess_00000001",
      clientLabel: "browser-a",
      mode: "control",
      token: "control-token",
    });

    expect(bootstrap.state().phase).toBe("connecting");
    expect(bootstrap.state().tokenPresent).toBe(true);

    bootstrap.complete("control", true);
    expect(bootstrap.state().phase).toBe("attached");
    expect(bootstrap.state().capabilities?.canEditSharedScene).toBe(true);

    bootstrap.fail("token expired");
    expect(bootstrap.state().phase).toBe("error");
    expect(bootstrap.state().message).toBe("token expired");
  });
});
