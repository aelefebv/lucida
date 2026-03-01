export type PermissionScope = "client_view" | "scene_shared" | "admin";

export type CommandEnvelope<TArgs> = {
  message_type: "command";
  schema_version: "lucida-proto-0.1";
  session_id: string;
  client_id: string;
  client_seq: number;
  op: string;
  scope: PermissionScope;
  requires_lease: boolean;
  args: TArgs;
};

export type CreateCommandInput<TArgs> = {
  sessionId: string;
  clientId: string;
  clientSeq: number;
  op: string;
  scope: PermissionScope;
  requiresLease: boolean;
  args: TArgs;
};

export function createCommandEnvelope<TArgs>(
  input: CreateCommandInput<TArgs>,
): CommandEnvelope<TArgs> {
  if (input.clientSeq < 1 || !Number.isInteger(input.clientSeq)) {
    throw new Error("clientSeq must be a positive integer");
  }

  return {
    message_type: "command",
    schema_version: "lucida-proto-0.1",
    session_id: input.sessionId,
    client_id: input.clientId,
    client_seq: input.clientSeq,
    op: input.op,
    scope: input.scope,
    requires_lease: input.requiresLease,
    args: input.args,
  };
}

export type ErrorCode =
  | "validation_error"
  | "unknown_op"
  | "permission_denied"
  | "invalid_token"
  | "lease_required"
  | "precondition_failed"
  | "stale_revision"
  | "not_found"
  | "source_unavailable"
  | "generation_unavailable"
  | "generation_build_incomplete"
  | "metadata_mismatch"
  | "publish_conflict"
  | "unsupported_codec"
  | "quota_exceeded"
  | "internal_error";

export type ValidationErrorKind =
  | "command_envelope_malformed"
  | "scope_mismatch"
  | "lease_requirement_mismatch"
  | "args_shape_mismatch"
  | "unsupported_operation"
  | "client_sequence_invalid"
  | "internal_routing_inconsistency";

export type LeaseErrorReason =
  | "active_lease_required"
  | "lease_held_by_another_client"
  | "lease_not_stealable";

export type NotFoundResource =
  | "session"
  | "client"
  | "source"
  | "layer"
  | "generation"
  | "metadata"
  | "publish_batch";

export type RevisionKind =
  | "session"
  | "scene"
  | "view"
  | "layer"
  | "metadata"
  | "write"
  | "generation";

export type ErrorDetails =
  | { detail_type: "none" }
  | { detail_type: "validation_error"; detail: { kind: ValidationErrorKind } }
  | {
      detail_type: "permission_denied";
      detail: { required_scope: PermissionScope };
    }
  | {
      detail_type: "lease_required";
      detail: {
        required_scope: PermissionScope;
        reason: LeaseErrorReason;
        current_lease_holder_client_id: string | null;
      };
    }
  | {
      detail_type: "not_found";
      detail: { resource: NotFoundResource; resource_id: string | null };
    }
  | {
      detail_type: "stale_revision";
      detail: {
        revision_kind: RevisionKind;
        expected_revision: number;
        actual_revision: number;
      };
    }
  | { detail_type: "source_unavailable"; detail: { source_id: string } }
  | {
      detail_type: "generation_unavailable";
      detail: { source_id: string; generation_seq: number | null };
    }
  | {
      detail_type: "metadata_mismatch";
      detail: {
        layer_id: string;
        expected_metadata_rev: number;
        actual_metadata_rev: number;
      };
    }
  | {
      detail_type: "publish_conflict";
      detail: {
        layer_id: string;
        expected_write_rev: number;
        actual_write_rev: number;
      };
    };

export type ErrorEnvelope = {
  message_type: "error";
  schema_version: "lucida-proto-0.1";
  session_id: string;
  request_id: string;
  client_id: string;
  client_seq: number;
  op: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details: ErrorDetails;
  sent_at: string;
};

const ERROR_CODES: readonly ErrorCode[] = [
  "validation_error",
  "unknown_op",
  "permission_denied",
  "invalid_token",
  "lease_required",
  "precondition_failed",
  "stale_revision",
  "not_found",
  "source_unavailable",
  "generation_unavailable",
  "generation_build_incomplete",
  "metadata_mismatch",
  "publish_conflict",
  "unsupported_codec",
  "quota_exceeded",
  "internal_error",
] as const;

const VALIDATION_ERROR_KINDS: readonly ValidationErrorKind[] = [
  "command_envelope_malformed",
  "scope_mismatch",
  "lease_requirement_mismatch",
  "args_shape_mismatch",
  "unsupported_operation",
  "client_sequence_invalid",
  "internal_routing_inconsistency",
] as const;

const LEASE_ERROR_REASONS: readonly LeaseErrorReason[] = [
  "active_lease_required",
  "lease_held_by_another_client",
  "lease_not_stealable",
] as const;

const NOT_FOUND_RESOURCES: readonly NotFoundResource[] = [
  "session",
  "client",
  "source",
  "layer",
  "generation",
  "metadata",
  "publish_batch",
] as const;

const REVISION_KINDS: readonly RevisionKind[] = [
  "session",
  "scene",
  "view",
  "layer",
  "metadata",
  "write",
  "generation",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function readStringOrNull(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }

  return value;
}

function readLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value`);
  }

  return value as T;
}

function parseErrorDetails(value: unknown): ErrorDetails {
  if (!isRecord(value)) {
    throw new Error("details must be an object");
  }

  const detailType = readLiteral(
    value.detail_type,
    [
      "none",
      "validation_error",
      "permission_denied",
      "lease_required",
      "not_found",
      "stale_revision",
      "source_unavailable",
      "generation_unavailable",
      "metadata_mismatch",
      "publish_conflict",
    ] as const,
    "details.detail_type",
  );

  if (detailType === "none") {
    return { detail_type: "none" };
  }

  const detailValue = value.detail;
  if (!isRecord(detailValue)) {
    throw new Error("details.detail must be an object");
  }

  switch (detailType) {
    case "validation_error":
      return {
        detail_type: "validation_error",
        detail: {
          kind: readLiteral(
            detailValue.kind,
            VALIDATION_ERROR_KINDS,
            "details.detail.kind",
          ),
        },
      };
    case "permission_denied":
      return {
        detail_type: "permission_denied",
        detail: {
          required_scope: readLiteral(
            detailValue.required_scope,
            ["client_view", "scene_shared", "admin"] as const,
            "details.detail.required_scope",
          ),
        },
      };
    case "lease_required":
      return {
        detail_type: "lease_required",
        detail: {
          required_scope: readLiteral(
            detailValue.required_scope,
            ["client_view", "scene_shared", "admin"] as const,
            "details.detail.required_scope",
          ),
          reason: readLiteral(
            detailValue.reason,
            LEASE_ERROR_REASONS,
            "details.detail.reason",
          ),
          current_lease_holder_client_id: readStringOrNull(
            detailValue,
            "current_lease_holder_client_id",
            "details.detail.current_lease_holder_client_id",
          ),
        },
      };
    case "not_found":
      return {
        detail_type: "not_found",
        detail: {
          resource: readLiteral(
            detailValue.resource,
            NOT_FOUND_RESOURCES,
            "details.detail.resource",
          ),
          resource_id: readStringOrNull(
            detailValue,
            "resource_id",
            "details.detail.resource_id",
          ),
        },
      };
    case "stale_revision":
      return {
        detail_type: "stale_revision",
        detail: {
          revision_kind: readLiteral(
            detailValue.revision_kind,
            REVISION_KINDS,
            "details.detail.revision_kind",
          ),
          expected_revision: readNumber(
            detailValue,
            "expected_revision",
            "details.detail.expected_revision",
          ),
          actual_revision: readNumber(
            detailValue,
            "actual_revision",
            "details.detail.actual_revision",
          ),
        },
      };
    case "source_unavailable":
      return {
        detail_type: "source_unavailable",
        detail: {
          source_id: readString(
            detailValue,
            "source_id",
            "details.detail.source_id",
          ),
        },
      };
    case "generation_unavailable":
      return {
        detail_type: "generation_unavailable",
        detail: {
          source_id: readString(
            detailValue,
            "source_id",
            "details.detail.source_id",
          ),
          generation_seq:
            detailValue.generation_seq === null ||
            detailValue.generation_seq === undefined
              ? null
              : readNumber(
                  detailValue,
                  "generation_seq",
                  "details.detail.generation_seq",
                ),
        },
      };
    case "metadata_mismatch":
      return {
        detail_type: "metadata_mismatch",
        detail: {
          layer_id: readString(
            detailValue,
            "layer_id",
            "details.detail.layer_id",
          ),
          expected_metadata_rev: readNumber(
            detailValue,
            "expected_metadata_rev",
            "details.detail.expected_metadata_rev",
          ),
          actual_metadata_rev: readNumber(
            detailValue,
            "actual_metadata_rev",
            "details.detail.actual_metadata_rev",
          ),
        },
      };
    case "publish_conflict":
      return {
        detail_type: "publish_conflict",
        detail: {
          layer_id: readString(
            detailValue,
            "layer_id",
            "details.detail.layer_id",
          ),
          expected_write_rev: readNumber(
            detailValue,
            "expected_write_rev",
            "details.detail.expected_write_rev",
          ),
          actual_write_rev: readNumber(
            detailValue,
            "actual_write_rev",
            "details.detail.actual_write_rev",
          ),
        },
      };
  }
}

export function parseErrorEnvelope(payload: unknown): ErrorEnvelope {
  if (!isRecord(payload)) {
    throw new Error("error payload must be an object");
  }

  const messageType = readString(payload, "message_type", "message_type");
  if (messageType !== "error") {
    throw new Error("message_type must be `error`");
  }

  const schemaVersion = readString(payload, "schema_version", "schema_version");
  if (schemaVersion !== "lucida-proto-0.1") {
    throw new Error("schema_version must be `lucida-proto-0.1`");
  }

  return {
    message_type: "error",
    schema_version: "lucida-proto-0.1",
    session_id: readString(payload, "session_id", "session_id"),
    request_id: readString(payload, "request_id", "request_id"),
    client_id: readString(payload, "client_id", "client_id"),
    client_seq: readNumber(payload, "client_seq", "client_seq"),
    op: readString(payload, "op", "op"),
    code: readLiteral(payload.code, ERROR_CODES, "code"),
    message: readString(payload, "message", "message"),
    retryable: readBoolean(payload, "retryable", "retryable"),
    details: parseErrorDetails(payload.details),
    sent_at: readString(payload, "sent_at", "sent_at"),
  };
}

export function isLeaseRecoveryError(error: ErrorEnvelope): boolean {
  return (
    error.code === "lease_required" &&
    error.details.detail_type === "lease_required"
  );
}
