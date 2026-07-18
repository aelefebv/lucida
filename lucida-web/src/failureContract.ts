export type FailureCategory =
  | "source"
  | "schema"
  | "codec"
  | "bounds"
  | "authorization"
  | "protocol"
  | "persistence"
  | "internal";

export type FailureCode =
  | "authorization"
  | "session_closed"
  | "workspace_lookup"
  | "unsupported_scheme"
  | "invalid_locator"
  | "local_path"
  | "missing_object"
  | "permission"
  | "cloud_configuration"
  | "http"
  | "storage_backend"
  | "unsupported_codec"
  | "decode_failure"
  | "unsupported_layout"
  | "chunk_out_of_bounds"
  | "resource_limit"
  | "malformed_metadata"
  | "missing_metadata"
  | "import"
  | "unknown_dataset"
  | "unknown_image"
  | "missing_chunk_metadata"
  | "invalid_chunk_key"
  | "protocol"
  | "persistence"
  | "internal";

export interface FailureDescriptor {
  category: FailureCategory;
  code: FailureCode;
  retryable: boolean;
}

const FAILURE_CATEGORIES = new Set<string>([
  "source", "schema", "codec", "bounds", "authorization", "protocol",
  "persistence", "internal",
]);

const FAILURE_CODES = new Set<string>([
  "authorization", "session_closed", "workspace_lookup", "unsupported_scheme",
  "invalid_locator", "local_path", "missing_object", "permission",
  "cloud_configuration", "http", "storage_backend", "unsupported_codec",
  "decode_failure", "unsupported_layout", "chunk_out_of_bounds", "resource_limit",
  "malformed_metadata", "missing_metadata", "import", "unknown_dataset",
  "unknown_image", "missing_chunk_metadata", "invalid_chunk_key", "protocol",
  "persistence", "internal",
]);

/** Validate and preserve the protocol-owned failure contract. The legacy
 * `kind` spelling is accepted on read only; current servers emit `code`. */
export function parseFailureDescriptor(raw: unknown): FailureDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const category = value.category;
  const code = value.code ?? value.kind;
  if (
    typeof category !== "string"
    || !FAILURE_CATEGORIES.has(category)
    || typeof code !== "string"
    || !FAILURE_CODES.has(code)
    || typeof value.retryable !== "boolean"
  ) return null;
  return {
    category: category as FailureCategory,
    code: code as FailureCode,
    retryable: value.retryable,
  };
}
