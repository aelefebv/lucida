// Create a new workspace around one or more dataset URLs or paths.
//
// The client sends only a name, so the server's owner-only default sharing is
// never weakened here. The datasets are not opened here: the caller navigates
// into the workspace and hands the URLs to `<App initialDatasetUrls=…>`. That
// order means a failed import leaves the workspace in place and surfaces in the
// viewer's open-failed banner instead of unwinding it.

import { createWorkspace, type WorkspaceRecord } from "./workspaceApi.ts";

/**
 * Last path segment of a dataset URL or path, for the default workspace name.
 * It runs on raw user input, which may be a Windows path, so it accepts both
 * separators. Naming only; never used to derive the dataset id.
 */
export function datasetBasename(url: string): string {
  const noQuery = url.split("?")[0].split("#")[0];
  const cleaned = noQuery.replace(/[/\\]+$/, "");
  const sep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const tail = sep >= 0 ? cleaned.slice(sep + 1) : cleaned;
  return tail;
}

/**
 * Default workspace name: the first dataset's basename, plus ` (+N)` for N
 * more (`sample.ome.zarr (+2)`). Empty when no basename is usable, so the
 * server applies its own default.
 */
export function workspaceNameFromDatasets(urls: readonly string[]): string {
  const names = urls.map(datasetBasename).filter((n) => n.length > 0);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} (+${names.length - 1})`;
}

/**
 * Create a workspace named after the given datasets. `urls` are raw user input,
 * not canonicalized here; the viewer canonicalizes them when it opens them.
 */
export function createWorkspaceFromDatasets(
  urls: readonly string[],
  name?: string,
): Promise<WorkspaceRecord> {
  const resolvedName = name ?? workspaceNameFromDatasets(urls);
  // Omit an empty name so the server uses its default rather than a blank one.
  return createWorkspace(resolvedName.length > 0 ? resolvedName : undefined);
}
