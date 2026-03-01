import { describe, expect, it } from "vitest";

import {
  createCommandEnvelope,
  isLeaseRecoveryError,
  parseErrorEnvelope,
} from "../src/protocol";

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
      request_id: "req_cli_00000001_7",
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

describe("parseErrorEnvelope", () => {
  it("parses typed lease errors that clients can act on without string parsing", () => {
    const parsed = parseErrorEnvelope({
      message_type: "error",
      schema_version: "lucida-proto-0.1",
      session_id: "sess_00000001",
      request_id: "req_lease_01",
      client_id: "cli_00000002",
      client_seq: 14,
      op: "lease.request",
      code: "lease_required",
      message: "lease is held by another client",
      retryable: true,
      details: {
        detail_type: "lease_required",
        detail: {
          required_scope: "scene_shared",
          reason: "lease_held_by_another_client",
          current_lease_holder_client_id: "cli_00000001",
        },
      },
      sent_at: "2026-03-01T10:00:00Z",
    });

    expect(parsed.code).toBe("lease_required");
    expect(parsed.details.detail_type).toBe("lease_required");
    if (parsed.details.detail_type !== "lease_required") {
      throw new Error("expected lease_required details");
    }
    expect(parsed.details.detail.reason).toBe("lease_held_by_another_client");
    expect(parsed.details.detail.required_scope).toBe("scene_shared");
    expect(isLeaseRecoveryError(parsed)).toBe(true);
  });

  it("rejects unsupported typed error codes", () => {
    expect(() =>
      parseErrorEnvelope({
        message_type: "error",
        schema_version: "lucida-proto-0.1",
        session_id: "sess_00000001",
        request_id: "req_invalid_code",
        client_id: "cli_00000002",
        client_seq: 15,
        op: "lease.request",
        code: "something_else",
        message: "bad code",
        retryable: false,
        details: { detail_type: "none" },
        sent_at: "2026-03-01T10:00:10Z",
      }),
    ).toThrow("code has an unsupported value");
  });
});
