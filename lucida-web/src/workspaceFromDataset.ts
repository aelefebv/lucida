// Convenience flow (#697): create a NEW workspace around one or more datasets.
//
// The only path into a workspace used to be "create a blank workspace, open it,
// then add a dataset from inside the viewer." This module is the small
// orchestration layer for the inverse: start from dataset URL(s)/path(s) (typed,
// or chosen in the file browser) and spin up a fresh workspace that already has
// them open.
//
// It is deliberately thin and reuses existing pieces:
//   - `createWorkspace(name)` makes a workspace OWNED BY THE CALLER with the
//     server's default sharing (restricted, owner-only, link access OFF). The
//     client only sends a name, so that default is reused verbatim — never
//     weakened here (see workspaceApi.createWorkspace + the workspaces table
//     defaults `link_access='restricted'`, `link_role='viewer'`).
//   - The actual dataset open is NOT done here. The caller navigates into the
//     new workspace and hands the URLs to `<App initialDatasetUrls=…>`, which
//     opens them over the same websocket the in-viewer "Open" flow uses. That
//     ordering is what makes a FAILED import leave the workspace in place: the
//     workspace already exists and the user is already in it when the open is
//     attempted, and a failure surfaces through the viewer's existing
//     open-failed banner rather than unwinding the workspace.

import { createWorkspace, type WorkspaceRecord } from "./workspaceApi.ts";

/**
 * Last path segment of a dataset URL/path, used as the default workspace name.
 *
 * Strips query/fragment and any trailing slash(es), then takes the final
 * segment. Canonical dataset URLs are forward-slashed (ADR-0042), but this also
 * runs on the *raw* user input (which may be a Windows path like
 * `C:\Users\me\foo.zarr` that the viewer canonicalizes later), so it accepts
 * BOTH separators — naming only, never used to derive the dataset id. Remote
 * schemes (`gs://bucket/foo.zarr`), `file://` URLs, and plain paths all reduce
 * to their last segment.
 */
export function datasetBasename(url: string): string {
  const noQuery = url.split("?")[0].split("#")[0];
  // Trim trailing separators of either kind, then take everything after the
  // last separator of either kind.
  const cleaned = noQuery.replace(/[/\\]+$/, "");
  const sep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const tail = sep >= 0 ? cleaned.slice(sep + 1) : cleaned;
  return tail;
}

/**
 * Default name for a workspace created from one or more datasets.
 *
 *   - single dataset  → its basename (e.g. `sample.ome.zarr`)
 *   - multiple        → first dataset's basename + ` (+N)`, where N is the
 *                       number of *additional* datasets (e.g.
 *                       `sample.ome.zarr (+2)` for three datasets)
 *
 * The `(+N)` form keeps the most useful label (the first dataset's name) front
 * and centre while still signalling that the workspace holds more than one, and
 * the owner can rename later (workspace rename already exists). Falls back to
 * the empty string when given no usable basenames, letting the server apply its
 * own default workspace name.
 */
export function workspaceNameFromDatasets(urls: readonly string[]): string {
  const names = urls.map(datasetBasename).filter((n) => n.length > 0);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} (+${names.length - 1})`;
}

/**
 * Create a workspace named after the given dataset(s) and resolve to the new
 * record. Pure orchestration: it does not open the datasets — the caller
 * navigates into `record.id` and passes the same URLs to the viewer to open.
 *
 * `urls` are the raw user-supplied dataset URLs/paths, only `.trim()`ed and
 * emptiness-filtered by the caller — they are NOT canonicalized here (no
 * `normalize_dataset_url`). The name is derived purely from each URL's basename
 * (see `workspaceNameFromDatasets` / `datasetBasename`, which tolerate both
 * separators), so it never depends on the canonical dataset id; the viewer
 * canonicalizes the URL itself when it actually opens the dataset. An explicit
 * `name` overrides the basename-derived default.
 */
export function createWorkspaceFromDatasets(
  urls: readonly string[],
  name?: string,
): Promise<WorkspaceRecord> {
  const resolvedName = name ?? workspaceNameFromDatasets(urls);
  // An empty derived name → omit it so the server uses its default workspace
  // name rather than persisting a blank one.
  return createWorkspace(resolvedName.length > 0 ? resolvedName : undefined);
}
