import { describe, expect, it } from "vitest";

import { createCommandEnvelope } from "../src/protocol";

describe("createCommandEnvelope", () => {
  it("creates an envelope with stable wire fields", () => {
    const envelope = createCommandEnvelope({
      sessionId: "sess_00000001",
      clientId: "cli_00000001",
      clientSeq: 7,
      op: "view.pan",
      scope: "client_view",
      requiresLease: false,
      args: { dx: 10, dy: -4 },
    });

    expect(envelope).toEqual({
      message_type: "command",
      schema_version: "lucida-proto-0.1",
      session_id: "sess_00000001",
      client_id: "cli_00000001",
      client_seq: 7,
      op: "view.pan",
      scope: "client_view",
      requires_lease: false,
      args: { dx: 10, dy: -4 },
    });
  });

  it("rejects non-positive client sequence numbers", () => {
    expect(() =>
      createCommandEnvelope({
        sessionId: "sess_00000001",
        clientId: "cli_00000001",
        clientSeq: 0,
        op: "view.pan",
        scope: "client_view",
        requiresLease: false,
        args: { dx: 10, dy: -4 },
      }),
    ).toThrow("clientSeq must be a positive integer");
  });
});
