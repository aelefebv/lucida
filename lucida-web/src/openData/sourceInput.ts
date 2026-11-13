import { dataset_location_error, normalize_dataset_url } from "lucida-core";

/** What the open dialog makes of a typed or pasted location. */
export type SourceCheck =
  | { readonly kind: "empty" }
  /** `url` is the canonical form, ready to open. */
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "rejected"; readonly message: string };

const EXAMPLE_PATHS = "/data/sample.zarr or c:/data/sample.zarr";

function rejected(message: string): SourceCheck {
  return { kind: "rejected", message };
}

/**
 * Checks a typed path or URL before it is sent, so a mistake reads as what
 * to type instead, never as the server's "unsupported scheme". The verdict
 * is the server's own location parse, through the wasm build, so the two
 * cannot disagree about what opens. The browser has no working directory,
 * so a relative path is refused here rather than resolved.
 */
export function checkSource(raw: string): SourceCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  const error = dataset_location_error(trimmed);
  if (error === undefined) return { kind: "ok", url: normalize_dataset_url(trimmed) };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  switch (error) {
    case "unknown_scheme":
      return rejected(
        `${scheme}:// URLs can't be opened. Enter a path, or a gs://, s3://, http://, or https:// URL.`,
      );
    case "missing_bucket":
      return rejected(`Add a bucket name after ${scheme}://.`);
    case "missing_host":
      return rejected(`Add a host name after ${scheme}://.`);
  }
  // Two or more letters, so a drive letter (`c:`) never matches.
  if (scheme === undefined && /^[a-z][a-z0-9+.-]+:/i.test(trimmed)) {
    return rejected("A URL needs :// after its scheme, like gs://bucket/sample.zarr.");
  }
  if (trimmed.startsWith("~")) {
    return rejected(`The server doesn't expand ~. Enter the full path from the root, like ${EXAMPLE_PATHS}.`);
  }
  return rejected(`This path is relative. Enter the full path from the root, like ${EXAMPLE_PATHS}.`);
}

/**
 * Whether typed text reads as a dataset location rather than search words:
 * a scheme (`gs://`, or one missing its slashes), a drive, the root, a UNC
 * share, or `~`. A relative path stays search words, since a search matches
 * the last segments of each dataset's URL.
 */
export function looksLikeLocation(raw: string): boolean {
  const trimmed = raw.trim();
  // Two or more letters before the colon, so a drive letter is left to the next test.
  return /^[a-z][a-z0-9+.-]+:/i.test(trimmed) || /^[a-z]:[\\/]/i.test(trimmed) || /^[\\/~]/.test(trimmed);
}
