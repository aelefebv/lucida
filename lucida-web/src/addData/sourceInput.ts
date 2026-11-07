import { is_local_dataset_url, normalize_dataset_url } from "lucida-core";

/** What the add-data field makes of what was typed. */
export type SourceCheck =
  | { readonly kind: "empty" }
  /** `url` is the canonical form (ADR 0042), ready to open. */
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "rejected"; readonly message: string };

const REMOTE_SCHEMES: readonly string[] = ["gs", "s3", "http", "https"];
const BUCKET_SCHEMES: readonly string[] = ["gs", "s3"];

const EXAMPLE_PATHS = "/data/sample.zarr or c:/data/sample.zarr";

function rejected(message: string): SourceCheck {
  return { kind: "rejected", message };
}

/**
 * Checks a typed path or URL before it is sent, so a mistake reads as what
 * to type instead, never as the server's "unsupported scheme". The local and
 * remote classification is the server's own, through the wasm build, so the
 * two cannot disagree about what opens.
 */
export function checkSource(raw: string): SourceCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  const url = normalize_dataset_url(trimmed);
  if (is_local_dataset_url(url)) return { kind: "ok", url };

  // Normalizing lowercased the scheme, so these compare as written.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(url)?.[1];
  if (scheme !== undefined) {
    if (!REMOTE_SCHEMES.includes(scheme)) {
      return rejected(
        `${scheme}:// URLs can't be opened. Enter a path, or a gs://, s3://, http://, or https:// URL.`,
      );
    }
    if (url.length === scheme.length + 3) {
      return rejected(
        BUCKET_SCHEMES.includes(scheme)
          ? `Add a bucket name after ${scheme}://.`
          : `Add a host name after ${scheme}://.`,
      );
    }
    return { kind: "ok", url };
  }
  // Two or more letters, so a drive letter (`c:`) never matches.
  if (/^[a-z][a-z0-9+.-]+:/i.test(url)) {
    return rejected("A URL needs :// after its scheme, like gs://bucket/sample.zarr.");
  }
  if (url.startsWith("~")) {
    return rejected(`The server doesn't expand ~. Enter the full path from the root, like ${EXAMPLE_PATHS}.`);
  }
  return rejected(`This path is relative. Enter the full path from the root, like ${EXAMPLE_PATHS}.`);
}
